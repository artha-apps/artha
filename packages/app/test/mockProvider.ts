/**
 * Mock OpenAI-compatible provider — TEST FIXTURE ONLY (lives outside src/ so
 * it is never compiled into the shipped app).
 *
 * An in-process HTTP server speaking the OpenAI wire dialect so provider
 * adapters, discovery, connection testing, and error normalization are
 * testable WITHOUT live keys (Phase A commit 4; founder directive: Phase A
 * tests must not require production credentials).
 *
 * Simulates, per scenario config:
 *   model-list discovery (incl. empty + duplicate/changing ids), auth failure,
 *   rate limiting, streaming (SSE), interrupted streams, tool calls,
 *   structured output, embeddings, usage fields, unsupported parameters,
 *   malformed responses, response delay (timeouts), provider unavailability,
 *   and provider-specific error shapes.
 */
import * as http from 'http';
import type { AddressInfo } from 'net';

export interface MockProviderScenario {
  /** Bearer token the server accepts. Anything else → 401 error shape. */
  apiKey?: string;
  /** Model ids returned by GET /v1/models. */
  models?: string[];
  /** Return an empty model catalogue. */
  emptyCatalogue?: boolean;
  /** Return duplicate ids in the catalogue (real providers do this). */
  duplicateModels?: boolean;
  /** Assistant text for completions. */
  replyText?: string;
  /** Respond with a tool call instead of/alongside text. */
  toolCall?: { name: string; arguments: string };
  /** usage block attached to completions (and echoed on the final SSE chunk). */
  usage?: { prompt_tokens: number; completion_tokens: number };
  /** Request params that trigger a 400 "unsupported parameter" error shape. */
  unsupportedParams?: string[];
  /** Failure injection. */
  failure?: 'rate_limit' | 'unavailable' | 'malformed' | 'interrupt_stream';
  /** Delay before responding (drive client-timeout tests). */
  delayMs?: number;
  /** Error payload shape: OpenAI-style {error:{...}} or a bare string body. */
  errorShape?: 'openai' | 'bare';
  /** Embedding vector length for POST /v1/embeddings. */
  embeddingDims?: number;
}

export interface CapturedRequest {
  method: string;
  path: string;
  headers: http.IncomingHttpHeaders;
  body: unknown;
}

export interface MockProvider {
  url: string; // e.g. http://127.0.0.1:PORT/v1
  requests: CapturedRequest[];
  setScenario(s: MockProviderScenario): void;
  close(): Promise<void>;
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

export async function startMockProvider(initial: MockProviderScenario = {}): Promise<MockProvider> {
  let scenario: MockProviderScenario = initial;
  const requests: CapturedRequest[] = [];

  const errorBody = (status: number, message: string, type: string) =>
    scenario.errorShape === 'bare'
      ? message
      : JSON.stringify({ error: { message, type, code: null } });

  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', c => { raw += c; });
    req.on('end', () => { void handle(req, res, raw); });
  });

  async function handle(req: http.IncomingMessage, res: http.ServerResponse, raw: string) {
    let body: unknown = undefined;
    try { body = raw ? JSON.parse(raw) : undefined; } catch { body = raw; }
    requests.push({ method: req.method ?? '', path: req.url ?? '', headers: req.headers, body });

    if (scenario.delayMs) await sleep(scenario.delayMs);

    // Auth: every route checks the bearer when the scenario pins one.
    if (scenario.apiKey) {
      const auth = req.headers.authorization ?? '';
      if (auth !== `Bearer ${scenario.apiKey}`) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(errorBody(401, 'Incorrect API key provided.', 'invalid_request_error'));
        return;
      }
    }

    if (scenario.failure === 'unavailable') {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(errorBody(503, 'The server is temporarily unavailable.', 'server_error'));
      return;
    }
    if (scenario.failure === 'rate_limit') {
      res.writeHead(429, { 'Content-Type': 'application/json', 'retry-after': '7' });
      res.end(errorBody(429, 'Rate limit reached for requests.', 'rate_limit_exceeded'));
      return;
    }

    if (req.method === 'GET' && req.url?.endsWith('/models')) {
      const ids = scenario.emptyCatalogue
        ? []
        : (scenario.models ?? ['mock-small', 'mock-large']);
      const list = scenario.duplicateModels ? [...ids, ...ids] : ids;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', data: list.map(id => ({ id, object: 'model', owned_by: 'mock' })) }));
      return;
    }

    if (req.method === 'POST' && req.url?.endsWith('/embeddings')) {
      const dims = scenario.embeddingDims ?? 8;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        object: 'list',
        data: [{ object: 'embedding', index: 0, embedding: Array.from({ length: dims }, (_, i) => i / dims) }],
        usage: scenario.usage ?? { prompt_tokens: 3, completion_tokens: 0 },
      }));
      return;
    }

    if (req.method === 'POST' && req.url?.endsWith('/chat/completions')) {
      const b = body as Record<string, unknown> | undefined;
      for (const p of scenario.unsupportedParams ?? []) {
        if (b && p in b && b[p] !== undefined) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(errorBody(400, `Unsupported parameter: '${p}'.`, 'invalid_request_error'));
          return;
        }
      }
      if (scenario.failure === 'malformed') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"choices": [{"mess'); // truncated JSON
        return;
      }

      const text = scenario.replyText ?? 'mock reply';
      const usage = scenario.usage ?? { prompt_tokens: 10, completion_tokens: 5 };
      const toolCalls = scenario.toolCall
        ? [{ id: 'call_0', type: 'function' as const, function: { name: scenario.toolCall.name, arguments: scenario.toolCall.arguments } }]
        : undefined;

      if (b?.stream) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
        const send = (obj: unknown) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
        const chunk = (delta: Record<string, unknown>, finish: string | null = null) => ({
          id: 'chatcmpl-mock', object: 'chat.completion.chunk', created: 1, model: b?.model ?? 'mock',
          choices: [{ index: 0, delta, finish_reason: finish }],
        });
        const words = text.split(' ');
        send(chunk({ role: 'assistant' }));
        for (let i = 0; i < words.length; i++) {
          send(chunk({ content: (i ? ' ' : '') + words[i] }));
          if (scenario.failure === 'interrupt_stream' && i === 0) {
            res.destroy(); // hard mid-stream cut, no [DONE]
            return;
          }
        }
        if (toolCalls) {
          // Arguments split across two chunks — exercises delta reassembly.
          const args = toolCalls[0].function.arguments;
          const mid = Math.ceil(args.length / 2);
          send(chunk({ tool_calls: [{ index: 0, id: 'call_0', type: 'function', function: { name: toolCalls[0].function.name, arguments: args.slice(0, mid) } }] }));
          send(chunk({ tool_calls: [{ index: 0, function: { arguments: args.slice(mid) } }] }));
        }
        send({ ...chunk({}, toolCalls ? 'tool_calls' : 'stop'), usage });
        res.write('data: [DONE]\n\n');
        res.end();
        return;
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        id: 'chatcmpl-mock', object: 'chat.completion', created: 1, model: b?.model ?? 'mock',
        choices: [{
          index: 0,
          finish_reason: toolCalls ? 'tool_calls' : 'stop',
          logprobs: null,
          message: { role: 'assistant', content: toolCalls ? null : text, refusal: null, tool_calls: toolCalls },
        }],
        usage,
      }));
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(errorBody(404, `Unknown path ${req.url}`, 'invalid_request_error'));
  }

  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;

  return {
    url: `http://127.0.0.1:${port}/v1`,
    requests,
    setScenario: (s: MockProviderScenario) => { scenario = s; },
    close: () => new Promise<void>((resolve, reject) => server.close(err => (err ? reject(err) : resolve()))),
  };
}
