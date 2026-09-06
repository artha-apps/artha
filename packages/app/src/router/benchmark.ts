/**
 * Adaptive Model Router — benchmark harness.
 *
 * Probes all locally-installed Ollama models with three canonical tasks:
 *   plan        — short structured planning response
 *   tool_args   — a REAL structured tool call to an offered function (the
 *                 thing agent routing depends on; prose/JSON-in-text scores 0)
 *   synthesis   — paragraph-length prose synthesis
 *
 * Records latency + a heuristic quality score in `model_profiles`. The LLM
 * client (`getActiveLLMClient(taskType)`) consults that table to pick the
 * best-scoring model per step type, dramatically speeding up multi-step
 * ReAct loops on local hardware.
 */
import OpenAI from 'openai';
import { getDb } from '../db/schema';

/** Aligned with `model_profiles.task_type` and the LLM client's task hints. */
export type TaskType = 'plan' | 'tool_args' | 'synthesis' | 'agent';

/** A single benchmark probe: messages to send, plus a `validate()` that
 *  scores the response 0..1 on shape/correctness — not on aesthetic quality. */
interface ProbeTask {
  task: TaskType;
  messages: OpenAI.ChatCompletionMessageParam[];
  /** Offered to the model as real function tools. When present the probe is
   *  scored on the structured `tool_calls` it returns, not on prose. */
  tools?: OpenAI.ChatCompletionTool[];
  validate: (reply: ProbeReply) => number; // 0..1 heuristic quality score
}

/** What a probe gets to score: the text and any structured tool calls. */
export interface ProbeReply {
  text: string;
  toolCalls: { name: string; args: Record<string, unknown> }[];
}

/** The one tool offered in the tool-call probe. Deliberately shaped like the
 *  agent's own fs_list_directory so the probe measures the thing routing
 *  depends on: can this model emit a well-formed call to a listed tool. */
const PROBE_TOOL: OpenAI.ChatCompletionTool = {
  type: 'function',
  function: {
    name: 'fs_list_directory',
    description: 'List the files in a directory on this computer.',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Absolute path of the directory to list.' } },
      required: ['path'],
    },
  },
};

/** Score a tool-call probe reply 0..1. Exported for tests. A model that
 *  answers in prose or emits JSON-in-text instead of a structured call scores
 *  0: on Ollama such a model's calls are silently dropped, which is exactly
 *  the failure the router must route around. */
export function scoreToolCallReply(reply: ProbeReply): number {
  const call = reply.toolCalls.find(c => c.name === PROBE_TOOL.function.name);
  if (!call) return 0;
  const path = call.args.path;
  if (typeof path !== 'string' || !path.trim()) return 0.25;
  if (!path.startsWith('/') && !path.startsWith('~') && !/^[A-Za-z]:\\/.test(path)) return 0.5;
  return /desktop/i.test(path) ? 1 : 0.75;
}

// The three canonical probes are designed to stress each capability in
// isolation without requiring internet access or large context windows.
const PROBES: ProbeTask[] = [
  {
    task: 'plan',
    // Checks that the model can emit a clean JSON array — the shape the
    // orchestrator expects from planning steps.
    messages: [
      { role: 'system', content: 'Respond with a JSON array of 3 short step descriptions to make tea. No explanation, JSON only.' },
      { role: 'user', content: 'Plan it.' },
    ],
    validate: ({ text }) => {
      try {
        const arr = JSON.parse(text.replace(/```json\n?|\n?```/g, '').trim()) as unknown;
        // Partial credit if the array exists but has too many/few items.
        return Array.isArray(arr) && arr.length >= 2 && arr.length <= 6 ? 1 : 0.4;
      } catch { return 0; }
    },
  },
  {
    task: 'tool_args',
    // A REAL tool call, not JSON-in-prose: the model is offered one function
    // and asked to use it. Scored on the structured call it returns.
    messages: [
      { role: 'system', content: 'You are a desktop assistant with tools. Use the tools to act; do not describe what you would do.' },
      { role: 'user', content: 'List the files on my Desktop.' },
    ],
    tools: [PROBE_TOOL],
    validate: scoreToolCallReply,
  },
  {
    task: 'synthesis',
    // Checks coherent prose generation — output length is the proxy for quality.
    messages: [
      { role: 'system', content: 'Write a concise, professional 2-sentence project status update.' },
      { role: 'user', content: 'Status: Q1 milestone met, two risks identified.' },
    ],
    validate: ({ text }) => {
      const trimmed = text.trim();
      if (trimmed.length < 40) return 0.2;
      const sentences = trimmed.match(/[.!?]+/g)?.length ?? 0;
      if (sentences >= 1 && sentences <= 4) return 1;
      return 0.6;
    },
  },
];

/** Minimal shape of a single model entry in the Ollama `/api/tags` response. */
interface OllamaTag { name: string; size: number }

/** Live `/api/tags` query against Ollama. Empty array on connection failure. */
async function listOllamaModels(): Promise<string[]> {
  try {
    const res = await fetch('http://localhost:11434/api/tags');
    const json = await res.json() as { models?: OllamaTag[] };
    return (json.models ?? []).map(m => m.name);
  } catch { return []; }
}

/** Send a single probe to a model and time it. Returns quality=0 on any error
 *  so a broken model never beats a working one in the router's ranking. */
async function probeModel(modelName: string, probe: ProbeTask): Promise<{ latency: number; quality: number }> {
  const client = new OpenAI({ baseURL: 'http://localhost:11434/v1', apiKey: 'ollama' });
  const start = Date.now();
  try {
    const res = await client.chat.completions.create({
      model: modelName,
      messages: probe.messages,
      ...(probe.tools ? { tools: probe.tools } : {}),
      max_tokens: 300,
      temperature: 0.2,
      stream: false,
    });
    const latency = Date.now() - start;
    const msg = res.choices[0]?.message;
    const toolCalls = (msg?.tool_calls ?? []).flatMap(tc => {
      if (tc.type !== 'function') return [];
      let args: Record<string, unknown> = {};
      try { args = JSON.parse(tc.function.arguments || '{}') as Record<string, unknown>; } catch { /* unparsable args score low */ }
      return [{ name: tc.function.name, args }];
    });
    return { latency, quality: probe.validate({ text: msg?.content ?? '', toolCalls }) };
  } catch {
    return { latency: Date.now() - start, quality: 0 };
  }
}

/** Shape returned to the renderer after a full benchmark run. */
export interface BenchmarkReport {
  models: string[];
  durationMs: number;
  results: { model: string; task: TaskType; latency: number; quality: number }[];
}

/** Probe ONE model against every probe task, upserting into `model_profiles`.
 *  Used standalone right after a model install (so its Model Fit card fills in
 *  without re-benchmarking the whole fleet — a 70B re-probe is minutes) and by
 *  `runBenchmark` for the full sweep. */
export async function benchmarkModel(
  model: string,
  progress?: (msg: string) => void,
): Promise<BenchmarkReport['results']> {
  const db = getDb();
  const upsert = db.prepare(`
    INSERT INTO model_profiles (ollama_name, task_type, latency_ms, quality, benchmarked_at)
    VALUES (?, ?, ?, ?, unixepoch())
    ON CONFLICT(ollama_name, task_type) DO UPDATE SET
      latency_ms = excluded.latency_ms,
      quality = excluded.quality,
      benchmarked_at = excluded.benchmarked_at
  `);
  const results: BenchmarkReport['results'] = [];
  for (const probe of PROBES) {
    progress?.(`${model} · ${probe.task}…`);
    const { latency, quality } = await probeModel(model, probe);
    upsert.run(model, probe.task, latency, quality);
    results.push({ model, task: probe.task, latency, quality });
  }
  return results;
}

/** Probe every installed Ollama model against every probe task. Results are
 *  upserted into `model_profiles` so the LLM client's `taskType` routing
 *  immediately starts using them. `progress` is wired through to the Router
 *  settings panel so the user sees per-model live status. */
export async function runBenchmark(progress?: (msg: string) => void): Promise<BenchmarkReport> {
  const start = Date.now();
  const models = await listOllamaModels();
  if (models.length === 0) {
    return { models: [], durationMs: 0, results: [] };
  }

  const results: BenchmarkReport['results'] = [];
  for (const model of models) {
    results.push(...await benchmarkModel(model, progress));
  }

  return { models, durationMs: Date.now() - start, results };
}

/** All benchmark rows, sorted best→worst within each task type. The Router
 *  settings panel renders this as a per-task leaderboard. */
export function listProfiles(): { ollama_name: string; task_type: TaskType; latency_ms: number; quality: number; benchmarked_at: number }[] {
  return getDb().prepare(`
    SELECT ollama_name, task_type, latency_ms, quality, benchmarked_at
    FROM model_profiles ORDER BY task_type ASC, quality DESC, latency_ms ASC
  `).all() as { ollama_name: string; task_type: TaskType; latency_ms: number; quality: number; benchmarked_at: number }[];
}

/** User-pinned model overrides (one per task type). Empty when running fully
 *  automatic. */
export function listOverrides(): { task_type: TaskType; ollama_name: string }[] {
  return getDb().prepare(`SELECT task_type, ollama_name FROM router_overrides`).all() as { task_type: TaskType; ollama_name: string }[];
}

/** Pin or clear a task-type → model override. Passing `null` clears the pin
 *  and returns the router to auto-select-by-profile mode. */
export function setOverride(taskType: string, ollamaName: string | null): void {
  const db = getDb();
  if (!ollamaName) {
    db.prepare(`DELETE FROM router_overrides WHERE task_type=?`).run(taskType);
    return;
  }
  db.prepare(`
    INSERT INTO router_overrides (task_type, ollama_name) VALUES (?, ?)
    ON CONFLICT(task_type) DO UPDATE SET ollama_name = excluded.ollama_name
  `).run(taskType, ollamaName);
}
