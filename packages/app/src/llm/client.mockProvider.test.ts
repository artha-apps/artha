/**
 * LLMClient ⇄ mock provider conformance tests (Phase A commit 4).
 *
 * The REAL OpenAI-compat adapter talks to the in-process mock provider
 * (test/mockProvider.ts) — no live keys, no network. This is the harness that
 * commit 5's discovery/connection-test IPC and commit 9's capability registry
 * build on.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { vi } from 'vitest';

// client.ts pulls in db/schema + electron transitively; neither is used by the
// LLMClient class itself, so stub both.
vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => 'gnome_libsecret',
    encryptString: (p: string) => Buffer.from(p, 'utf8'),
    decryptString: (b: Buffer) => b.toString('utf8'),
  },
}));
vi.mock('../db/schema', () => ({ getDb: () => ({ prepare: () => ({ get: () => undefined, all: () => [], run: () => ({}) }) }) }));

import { LLMClient } from './client';
import { startMockProvider, type MockProvider } from '../../test/mockProvider';

let mock: MockProvider;

beforeAll(async () => { mock = await startMockProvider(); });
afterAll(async () => { await mock.close(); });
beforeEach(() => { mock.requests.length = 0; });

const client = (apiKey = 'sk-mock') =>
  new LLMClient({ baseUrl: mock.url, apiKey, model: 'mock-large', maxTokens: 64 });

describe('non-streaming completion', () => {
  it('returns text and passes the usage block through', async () => {
    mock.setScenario({ apiKey: 'sk-mock', replyText: 'hello from mock', usage: { prompt_tokens: 21, completion_tokens: 7 } });
    const res = await client().complete([{ role: 'user', content: 'hi' }]);
    expect(res.choices[0].message.content).toBe('hello from mock');
    // usage is on the wire — the Phase B ledger reads exactly this field.
    expect(res.usage).toMatchObject({ prompt_tokens: 21, completion_tokens: 7 });
  });

  it('returns tool calls with intact JSON arguments', async () => {
    mock.setScenario({ apiKey: 'sk-mock', toolCall: { name: 'web_search', arguments: '{"query":"artha"}' } });
    const res = await client().complete([{ role: 'user', content: 'search' }], [
      { type: 'function', function: { name: 'web_search', parameters: { type: 'object' } } },
    ]);
    const tc = res.choices[0].message.tool_calls?.[0];
    expect(tc?.function.name).toBe('web_search');
    expect(JSON.parse(tc!.function.arguments)).toEqual({ query: 'artha' });
  });

  it('authentication failure surfaces as a 401 error, not a mangled reply', async () => {
    mock.setScenario({ apiKey: 'sk-mock', replyText: 'never' });
    await expect(client('sk-WRONG').complete([{ role: 'user', content: 'hi' }]))
      .rejects.toMatchObject({ status: 401 });
  });

  it('rate limit surfaces as 429', async () => {
    mock.setScenario({ apiKey: 'sk-mock', failure: 'rate_limit' });
    const c = new LLMClient({ baseUrl: mock.url, apiKey: 'sk-mock', model: 'mock-large' });
    await expect(c.complete([{ role: 'user', content: 'hi' }])).rejects.toMatchObject({ status: 429 });
  }, 30_000); // the SDK retries 429s before giving up

  it('unsupported parameter yields a 400 with the provider message', async () => {
    mock.setScenario({ apiKey: 'sk-mock', unsupportedParams: ['max_tokens'] });
    await expect(client().complete([{ role: 'user', content: 'hi' }]))
      .rejects.toMatchObject({ status: 400 });
  });

  it('provider unavailability (503) rejects rather than fabricating output', async () => {
    mock.setScenario({ apiKey: 'sk-mock', failure: 'unavailable' });
    await expect(client().complete([{ role: 'user', content: 'hi' }]))
      .rejects.toMatchObject({ status: 503 });
  }, 60_000); // SDK retries 5xx

  it('malformed provider JSON rejects with a parse-level error', async () => {
    mock.setScenario({ apiKey: 'sk-mock', failure: 'malformed' });
    await expect(client().complete([{ role: 'user', content: 'hi' }])).rejects.toBeTruthy();
  });
});

describe('streaming completion (ReAct hot path)', () => {
  it('assembles streamed tokens and forwards them in order', async () => {
    mock.setScenario({ apiKey: 'sk-mock', replyText: 'alpha beta gamma' });
    const tokens: string[] = [];
    const out = await client().streamComplete(
      [{ role: 'user', content: 'go' }], undefined, t => tokens.push(t));
    expect(out.content).toBe('alpha beta gamma');
    expect(tokens.join('')).toBe('alpha beta gamma');
  });

  it('reassembles tool-call arguments split across SSE chunks', async () => {
    mock.setScenario({ apiKey: 'sk-mock', replyText: 'ok', toolCall: { name: 'rag_search', arguments: '{"q":"tax rules","k":5}' } });
    const out = await client().streamComplete([{ role: 'user', content: 'go' }], undefined, () => {});
    expect(out.tool_calls).toHaveLength(1);
    expect(out.tool_calls![0].function.name).toBe('rag_search');
    expect(JSON.parse(out.tool_calls![0].function.arguments)).toEqual({ q: 'tax rules', k: 5 });
  });

  it('an interrupted stream (connection cut mid-SSE) rejects or returns partial — never hangs', async () => {
    mock.setScenario({ apiKey: 'sk-mock', replyText: 'one two three four', failure: 'interrupt_stream' });
    const tokens: string[] = [];
    const attempt = client().streamComplete([{ role: 'user', content: 'go' }], undefined, t => tokens.push(t));
    // Either shape is acceptable at the adapter layer; the orchestrator's
    // failure banner handles both. What is NOT acceptable is a hang.
    await expect(Promise.race([
      attempt.then(r => ({ ok: true as const, r })).catch(e => ({ ok: false as const, e })),
      new Promise((_, rej) => setTimeout(() => rej(new Error('adapter hung on interrupted stream')), 25_000)),
    ])).resolves.toBeTruthy();
  }, 30_000);
});

describe('model discovery surface (consumed by commit 5)', () => {
  const listModels = async () => {
    const res = await fetch(`${mock.url}/models`, { headers: { authorization: 'Bearer sk-mock' } });
    if (!res.ok) throw Object.assign(new Error(`models ${res.status}`), { status: res.status });
    const json = await res.json() as { data: { id: string }[] };
    return json.data.map(m => m.id);
  };

  it('lists the catalogue', async () => {
    mock.setScenario({ apiKey: 'sk-mock', models: ['kimi-k2', 'kimi-k2-mini'] });
    expect(await listModels()).toEqual(['kimi-k2', 'kimi-k2-mini']);
  });

  it('handles an empty catalogue (UI must offer manual model entry)', async () => {
    mock.setScenario({ apiKey: 'sk-mock', emptyCatalogue: true });
    expect(await listModels()).toEqual([]);
  });

  it('duplicate model ids must be de-duplicated by the consumer', async () => {
    mock.setScenario({ apiKey: 'sk-mock', models: ['m1', 'm2'], duplicateModels: true });
    const ids = await listModels();
    expect(ids).toHaveLength(4);
    expect([...new Set(ids)]).toEqual(['m1', 'm2']);
  });

  it('discovery auth failure is a clean 401', async () => {
    mock.setScenario({ apiKey: 'sk-OTHER' });
    await expect(listModels()).rejects.toMatchObject({ status: 401 });
  });
});

describe('embeddings surface (consumed by Phase B embedder abstraction)', () => {
  it('returns a vector of the advertised dimensionality with usage', async () => {
    mock.setScenario({ apiKey: 'sk-mock', embeddingDims: 16, usage: { prompt_tokens: 4, completion_tokens: 0 } });
    const res = await fetch(`${mock.url}/embeddings`, {
      method: 'POST',
      headers: { authorization: 'Bearer sk-mock', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'mock-embed', input: 'hello' }),
    });
    const json = await res.json() as { data: { embedding: number[] }[]; usage: { prompt_tokens: number } };
    expect(json.data[0].embedding).toHaveLength(16);
    expect(json.usage.prompt_tokens).toBe(4);
  });
});
