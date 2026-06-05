/**
 * LLM Client — Single OpenAI-compatible REST adapter.
 *
 * Covers Ollama (localhost:11434), LM Studio (localhost:1234),
 * llama.cpp server, and cloud providers (OpenAI, Anthropic via proxy).
 * No per-runtime code: one adapter, configured by base URL.
 */
import OpenAI from 'openai';
import { getDb } from '../db/schema';
import { applyToolCallDeltas, toToolCalls, type PartialToolCall } from './streamMerge';

/** Assembled result of a streamed completion — mirrors the bits of a
 *  ChatCompletionMessage the ReAct loop consumes. */
export interface StreamedMessage {
  content: string | null;
  tool_calls?: OpenAI.Chat.Completions.ChatCompletionMessageToolCall[];
}

export interface LLMConfig {
  baseUrl: string;        // e.g. http://localhost:11434/v1
  apiKey?: string;        // 'ollama' for local, real key for cloud
  model: string;          // e.g. 'llama3:8b-instruct-q4_K_M'
  /** Output-token cap (max_tokens / num_predict). NOT the context window. */
  maxTokens?: number;
  temperature?: number;
  /** Ollama context window (num_ctx). Only applied on the local-Ollama native
   *  path — the OpenAI-compat /v1 endpoint ignores num_ctx, so the default 2048
   *  would silently truncate big tool-using prompts and re-eval every turn. */
  contextWindow?: number;
  /** How long Ollama keeps the model resident after a call (keep_alive). Keeps
   *  the model warm between agent turns/tasks so there's no reload latency. */
  keepAlive?: string;
}

/** Callbacks wired by the orchestrator to forward text tokens to the renderer
 *  and handle completion/error events. */
export interface StreamCallbacks {
  onToken: (token: string) => void;
  /** Called once with the full concatenated text when the stream closes. */
  onDone: (fullText: string) => void;
  onError: (err: Error) => void;
}

/**
 * Thin wrapper around the OpenAI SDK that targets any OpenAI-compatible
 * endpoint. Exposes three call modes: `streamChat` (simple text streaming),
 * `complete` (non-streaming, used for classification/planning), and
 * `streamComplete` (streaming with tool-call reassembly for the ReAct loop).
 */
export class LLMClient {
  private client: OpenAI;
  private config: LLMConfig;

  constructor(config: LLMConfig) {
    this.config = config;
    this.client = new OpenAI({
      baseURL: config.baseUrl,
      apiKey: config.apiKey ?? 'ollama',
    });
  }

  /** True for a local Ollama endpoint, where we use the native /api/chat route
   *  to set num_ctx/keep_alive (the OpenAI-compat /v1 endpoint can't). */
  private get isOllama(): boolean {
    return /(:11434)(\/|$)/.test(this.config.baseUrl);
  }

  /** Strip the trailing /v1 so we can hit Ollama's native API base. */
  private get ollamaBase(): string {
    return this.config.baseUrl.replace(/\/v1\/?$/, '');
  }

  /** Stream a chat completion. Yields tokens via callbacks. */
  async streamChat(
    messages: OpenAI.ChatCompletionMessageParam[],
    callbacks: StreamCallbacks
  ): Promise<void> {
    try {
      const stream = await this.client.chat.completions.create({
        model: this.config.model,
        messages,
        stream: true,
        max_tokens: this.config.maxTokens ?? 4096,
        temperature: this.config.temperature ?? 0.7,
      });

      let fullText = '';
      for await (const chunk of stream) {
        const token = chunk.choices[0]?.delta?.content ?? '';
        if (token) {
          fullText += token;
          callbacks.onToken(token);
        }
      }
      callbacks.onDone(fullText);
    } catch (err) {
      callbacks.onError(err instanceof Error ? err : new Error(String(err)));
    }
  }

  /** Non-streaming completion — for tool call parsing, planning steps, and
   *  classification prompts where the full response is needed at once. Uses a
   *  lower default temperature (0.3) than `streamChat` for more determinism. */
  async complete(
    messages: OpenAI.ChatCompletionMessageParam[],
    tools?: OpenAI.ChatCompletionTool[]
  ): Promise<OpenAI.ChatCompletion> {
    // Local Ollama: use the native endpoint so we send the SAME num_ctx +
    // keep_alive as the streaming ReAct path. The OpenAI-compat /v1 endpoint
    // ignores num_ctx (defaults to 2048), so mixing it with the native path
    // makes Ollama reload/resize the model between phases of one turn — a
    // multi-second stall per phase on a large model. Keeping both paths on the
    // same num_ctx lets the model stay resident across plan → answer → refresh.
    if (this.isOllama) {
      return this.completeOllamaNative(messages, tools);
    }
    return this.client.chat.completions.create({
      model: this.config.model,
      messages,
      tools,
      tool_choice: tools?.length ? 'auto' : undefined,
      max_tokens: this.config.maxTokens ?? 4096,
      temperature: this.config.temperature ?? 0.3,
      stream: false,
    });
  }

  /** Non-streaming native Ollama `/api/chat` — same num_ctx/keep_alive as the
   *  streaming path so the resident model isn't reloaded between phases. */
  private async completeOllamaNative(
    messages: OpenAI.ChatCompletionMessageParam[],
    tools?: OpenAI.ChatCompletionTool[],
  ): Promise<OpenAI.ChatCompletion> {
    const body = {
      model: this.config.model,
      messages: this.toOllamaMessages(messages),
      tools: tools && tools.length ? tools : undefined,
      stream: false,
      keep_alive: this.config.keepAlive ?? '30m',
      options: {
        num_ctx: this.config.contextWindow ?? 8192,
        num_predict: this.config.maxTokens ?? 4096,
        temperature: this.config.temperature ?? 0.3,
      },
    };
    const res = await fetch(`${this.ollamaBase}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw new Error(`Ollama /api/chat failed: ${res.status} ${res.statusText}`);
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const data: any = await res.json();
    const msg = data?.message ?? {};
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tool_calls = Array.isArray(msg.tool_calls) && msg.tool_calls.length
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ? msg.tool_calls.map((tc: any, i: number) => ({
          id: `call_${i}_${tc.function?.name ?? 'fn'}`,
          type: 'function' as const,
          function: {
            name: tc.function?.name ?? '',
            arguments: typeof tc.function?.arguments === 'string'
              ? tc.function.arguments
              : JSON.stringify(tc.function?.arguments ?? {}),
          },
        }))
      : undefined;
    return {
      id: 'ollama-native',
      object: 'chat.completion',
      created: 0,
      model: this.config.model,
      choices: [{
        index: 0,
        finish_reason: 'stop',
        logprobs: null,
        message: { role: 'assistant', content: msg.content ?? '', refusal: null, tool_calls },
      }],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any as OpenAI.ChatCompletion;
  }

  /** Map OpenAI-shaped messages to Ollama native `/api/chat` shape. Shared by
   *  the streaming + non-streaming native paths. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private toOllamaMessages(messages: OpenAI.ChatCompletionMessageParam[]): any[] {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return messages.map((m): any => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const am = m as any;
      if (m.role === 'assistant' && am.tool_calls?.length) {
        return {
          role: 'assistant',
          content: am.content ?? '',
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          tool_calls: am.tool_calls.map((tc: any) => ({
            function: { name: tc.function?.name, arguments: safeParseArgs(tc.function?.arguments) },
          })),
        };
      }
      const content = typeof am.content === 'string' ? am.content : JSON.stringify(am.content ?? '');
      return { role: m.role, content };
    });
  }

  /** Streaming completion for the ReAct loop. Forwards text deltas via
   *  `onToken` and assembles any tool calls. `shouldAbort` is polled between
   *  chunks so the Stop button can interrupt a long generation mid-stream.
   *  `onReasoning` receives the model's separate chain-of-thought deltas (Ollama
   *  `message.thinking` / OpenAI `reasoning_content`) so the UI can show *what*
   *  the model is thinking during the long silent reasoning phase, instead of a
   *  blank spinner. */
  async streamComplete(
    messages: OpenAI.ChatCompletionMessageParam[],
    tools: OpenAI.ChatCompletionTool[] | undefined,
    onToken: (token: string) => void,
    shouldAbort?: () => boolean,
    onReasoning?: (chunk: string) => void
  ): Promise<StreamedMessage> {
    // Local Ollama: use the native endpoint so we can set num_ctx + keep_alive.
    // This is the hot ReAct path, so the bigger context window (no per-turn
    // truncation/re-eval) and a warm model matter most here.
    if (this.isOllama) {
      return this.streamCompleteOllamaNative(messages, tools, onToken, shouldAbort, onReasoning);
    }
    const stream = await this.client.chat.completions.create({
      model: this.config.model,
      messages,
      tools,
      tool_choice: tools?.length ? 'auto' : undefined,
      max_tokens: this.config.maxTokens ?? 4096,
      temperature: this.config.temperature ?? 0.3,
      stream: true,
    });

    let content = '';
    let partials: PartialToolCall[] = [];
    for await (const chunk of stream) {
      // Poll the abort signal on every chunk so the Stop button is responsive
      // without needing a separate AbortController thread.
      if (shouldAbort?.()) {
        stream.controller.abort();
        break;
      }
      const delta = chunk.choices[0]?.delta;
      if (!delta) continue;
      // Reasoning models on OpenAI-compatible endpoints stream their
      // chain-of-thought in a separate `reasoning_content` (or `reasoning`)
      // field that the SDK doesn't type. Surface it so the wait feels alive.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const reasoning = (delta as any).reasoning_content ?? (delta as any).reasoning;
      if (reasoning && onReasoning) onReasoning(reasoning);
      if (delta.content) {
        content += delta.content;
        onToken(delta.content);
      }
      // Tool-call arguments arrive as partial JSON strings across multiple
      // chunks; accumulate them until the stream closes.
      if (delta.tool_calls?.length) {
        partials = applyToolCallDeltas(partials, delta.tool_calls);
      }
    }

    const tool_calls = toToolCalls(partials);
    // Return content as null (not '') so the ReAct loop can cleanly distinguish
    // "model produced only tool calls" from "model produced empty text".
    return { content: content || null, tool_calls: tool_calls.length ? tool_calls : undefined };
  }

  /** Native Ollama /api/chat streaming with tool support. Lets us pass num_ctx
   *  + keep_alive (which the OpenAI-compat endpoint ignores). Translates to/from
   *  the OpenAI message/tool shapes the orchestrator uses. Tool results map by
   *  order (Ollama has no tool_call_id), which matches how the loop appends them. */
  private async streamCompleteOllamaNative(
    messages: OpenAI.ChatCompletionMessageParam[],
    tools: OpenAI.ChatCompletionTool[] | undefined,
    onToken: (token: string) => void,
    shouldAbort?: () => boolean,
    onReasoning?: (chunk: string) => void,
  ): Promise<StreamedMessage> {
    const oMessages = this.toOllamaMessages(messages);

    const buildBody = (think: boolean) => ({
      model: this.config.model,
      messages: oMessages,
      tools: tools && tools.length ? tools : undefined,
      stream: true,
      // Ask thinking models to emit their reasoning as a separate `thinking`
      // field (instead of inline <think> tags or hidden) so we can stream it to
      // the UI. Non-thinking models reject this with a 400 — handled below by
      // retrying once without it.
      ...(think ? { think: true } : {}),
      keep_alive: this.config.keepAlive ?? '30m',
      options: {
        num_ctx: this.config.contextWindow ?? 8192,
        num_predict: this.config.maxTokens ?? 2048,
        temperature: this.config.temperature ?? 0.3,
      },
    });

    const controller = new AbortController();
    const post = (think: boolean) =>
      fetch(`${this.ollamaBase}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(buildBody(think)),
        signal: controller.signal,
      });

    let res = await post(true);
    // A model that doesn't support thinking returns 400 ("does not support
    // thinking"). Retry once without `think` so non-reasoning models still work.
    if (res.status === 400) {
      const errText = await res.text().catch(() => '');
      if (/think/i.test(errText)) {
        res = await post(false);
      } else {
        throw new Error(`Ollama /api/chat failed: 400 ${errText}`);
      }
    }
    if (!res.ok || !res.body) {
      throw new Error(`Ollama /api/chat failed: ${res.status} ${res.statusText}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let content = '';
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const collected: any[] = [];

    for (;;) {
      if (shouldAbort?.()) { controller.abort(); break; }
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        let evt: any;
        try { evt = JSON.parse(line); } catch { continue; }
        const think: string | undefined = evt?.message?.thinking;
        if (think && onReasoning) onReasoning(think);
        const tok: string | undefined = evt?.message?.content;
        if (tok) { content += tok; onToken(tok); }
        const tcs = evt?.message?.tool_calls;
        if (Array.isArray(tcs)) {
          for (const tc of tcs) {
            collected.push({
              id: `call_${collected.length}_${tc.function?.name ?? 'fn'}`,
              type: 'function' as const,
              function: {
                name: tc.function?.name ?? '',
                arguments: typeof tc.function?.arguments === 'string'
                  ? tc.function.arguments
                  : JSON.stringify(tc.function?.arguments ?? {}),
              },
            });
          }
        }
      }
    }

    return { content: content || null, tool_calls: collected.length ? collected : undefined };
  }
}

/** Coerce an OpenAI tool-call `arguments` (JSON string or object) into the
 *  plain object Ollama's native API expects. */
function safeParseArgs(s: unknown): Record<string, unknown> {
  if (s && typeof s === 'object') return s as Record<string, unknown>;
  if (typeof s === 'string') { try { return JSON.parse(s); } catch { return {}; } }
  return {};
}

/**
 * Canonical task types the router benchmarks and routes by. Must stay in sync
 * with `model_profiles.task_type` and the benchmark probe list in benchmark.ts.
 */
export type TaskType = 'plan' | 'tool_args' | 'synthesis';

/** Pick the best Ollama model for a given task, in priority order:
 *  1. modelOverride (caller pinned a specific model — e.g. fork replay)
 *  2. router_overrides row for this task_type (user pinned)
 *  3. highest-quality model_profiles row for this task_type
 *  4. fall through to whatever's in llm_models WHERE is_active=1
 */
function resolveModelName(modelOverride?: string, taskType?: TaskType): string | undefined {
  if (modelOverride) return modelOverride;
  if (!taskType) return undefined;

  const db = getDb();
  try {
    const pinned = db
      .prepare(`SELECT ollama_name FROM router_overrides WHERE task_type=?`)
      .get(taskType) as { ollama_name: string } | undefined;
    if (pinned?.ollama_name) return pinned.ollama_name;

    const best = db
      .prepare(
        `SELECT ollama_name FROM model_profiles
         WHERE task_type=? ORDER BY quality DESC, latency_ms ASC LIMIT 1`
      )
      .get(taskType) as { ollama_name: string } | undefined;
    if (best?.ollama_name) return best.ollama_name;

    // No benchmark + no user override. For the latency-sensitive auxiliary
    // phases, fall back to the SMALLEST installed local model rather than the
    // active (possibly huge) answer model — planning + tool-arg formatting
    // don't need a 70B, and running them on one is the main cause of slow
    // turns. 'synthesis' is quality-sensitive (doc generation, final combine)
    // so it deliberately falls through to the active model.
    if (taskType === 'plan' || taskType === 'tool_args') {
      const rows = db
        .prepare(`SELECT ollama_name FROM llm_models WHERE provider='ollama'`)
        .all() as { ollama_name: string }[];
      // Parse parameter count from the tag (…:7b, :72b, :3b-instruct-q4 → 7/72/3).
      const params = (n: string): number => {
        const tag = n.includes(':') ? n.slice(n.lastIndexOf(':') + 1) : n;
        const m = tag.match(/(\d+(?:\.\d+)?)\s*b\b/i);
        return m ? parseFloat(m[1]) : Infinity;
      };
      const smallest = rows
        .map(r => ({ name: r.ollama_name, b: params(r.ollama_name) }))
        .sort((a, b) => a.b - b.b)[0];
      return smallest?.name;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/** Returns an LLMClient configured from the active model in the DB.
 *  `taskType` lets the router pick a different model per phase of a run;
 *  `modelOverride` short-circuits everything (used by time-travel fork). */
export function getActiveLLMClient(modelOverride?: string, taskType?: TaskType): LLMClient {
  const db = getDb();
  const row = db
    .prepare(`SELECT * FROM llm_models WHERE is_active = 1 LIMIT 1`)
    .get() as Record<string, unknown> | undefined;

  const baseUrl       = (row?.base_url as string)        ?? 'http://localhost:11434/v1';
  const apiKey        = (row?.api_key as string)          ?? 'ollama';
  const fallbackModel = (row?.ollama_name as string)      ?? 'llama3.2:3b-instruct-q4_K_M';
  // num_ctx for the local Ollama native path. Default 8192 (up from Ollama's
  // 2048) so big tool-using prompts aren't truncated + re-evaluated each turn.
  const contextWindow = (row?.context_window as number)   ?? 8192;

  const routed = resolveModelName(modelOverride, taskType);

  // Use the ROUTED model's OWN context window, not the active model's. Routing
  // (e.g. Delegate's fast model) can select a different model than the active
  // one; forcing it into the active model's (possibly tiny) num_ctx truncates
  // the large tool-using prompt + tool schemas, which silently breaks tool use
  // and reading. Floor at 8192 so a tool-heavy loop never runs in a
  // truncating-small window.
  let effectiveContextWindow = contextWindow;
  if (routed && routed !== (row?.ollama_name as string)) {
    const routedRow = db
      .prepare(`SELECT context_window FROM llm_models WHERE ollama_name = ?`)
      .get(routed) as { context_window?: number } | undefined;
    if (routedRow?.context_window) effectiveContextWindow = routedRow.context_window;
  }
  effectiveContextWindow = Math.max(effectiveContextWindow, 8192);

  return new LLMClient({
    baseUrl,
    apiKey,
    model: routed ?? fallbackModel,
    contextWindow: effectiveContextWindow,
    keepAlive: '30m',
  });
}
