/**
 * LLM Client — Single OpenAI-compatible REST adapter.
 *
 * Covers Ollama (localhost:11434), LM Studio (localhost:1234),
 * llama.cpp server, and cloud providers (OpenAI, Anthropic via proxy).
 * No per-runtime code: one adapter, configured by base URL.
 */
import OpenAI from 'openai';
import { getDb } from '../db/schema';

export interface LLMConfig {
  baseUrl: string;        // e.g. http://localhost:11434/v1
  apiKey?: string;        // 'ollama' for local, real key for cloud
  model: string;          // e.g. 'llama3:8b-instruct-q4_K_M'
  maxTokens?: number;
  temperature?: number;
}

export interface StreamCallbacks {
  onToken: (token: string) => void;
  onDone: (fullText: string) => void;
  onError: (err: Error) => void;
}

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

  /** Non-streaming completion — for tool call parsing, planning steps. */
  async complete(
    messages: OpenAI.ChatCompletionMessageParam[],
    tools?: OpenAI.ChatCompletionTool[]
  ): Promise<OpenAI.ChatCompletion> {
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
}

/** Canonical task types the router benchmarks and routes by. */
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
    return best?.ollama_name;
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

  const baseUrl = (row?.base_url as string) ?? 'http://localhost:11434/v1';
  const apiKey  = (row?.api_key as string)  ?? 'ollama';
  const fallbackModel = (row?.ollama_name as string) ?? 'llama3.2:3b-instruct-q4_K_M';

  const routed = resolveModelName(modelOverride, taskType);

  return new LLMClient({
    baseUrl,
    apiKey,
    model: routed ?? fallbackModel,
  });
}
