/**
 * Agent router — which model runs the tool-calling ("act") loop.
 *
 * Founder decision (2026-09-05): users do not switch models per task, and they
 * must never have to decide mid-query. Artha owns that choice. Before this, the
 * act loop always ran on whatever the picker said, so a 72B model that reads
 * prompts at ~55 tokens/s on an M-series Mac spent ~3 minutes per turn on a
 * basic file move. The auxiliary phases (plan / route / classify) were already
 * routed automatically; this closes the gap for the phase that does the work.
 *
 * Decision order (see `routeAgentModel`):
 *   1. pin      — the user tapped "use my pick anyway"; always honoured.
 *   2. user     — the active model is CLOUD: routing never selects or replaces a
 *                 cloud model on its own (the footer promise "no data leaves
 *                 your machine" must hold unless the user opted in themselves).
 *   3. user     — the active model is local AND eligible (size within this Mac's
 *                 agent budget, not known to fail tool calls).
 *   4. auto     — the tier's recommended model if installed, else the largest
 *                 eligible installed local model.
 *   5. fallback — nothing eligible is installed: use the user's pick anyway and
 *                 say so (slice 2 will install the tier default under consent).
 *
 * Pure function + a thin DB/OS-facing resolver, so the policy is unit-tested
 * without Electron, SQLite, or Ollama.
 */
import os from 'os';
import { isOllamaManaged } from '../llm/providerKind';

export type AgentRouteSource = 'pin' | 'user' | 'auto' | 'user-fallback' | 'none';

export interface AgentRoute {
  /** Model to run the act loop on; null only when nothing is configured. */
  model: string | null;
  source: AgentRouteSource;
  /** Plain-English reason, shown as the chip tooltip / dropdown note. */
  reason: string;
  /** What the picker says (the user's explicit choice), for the revert action. */
  userPick: string | null;
  /** Parameter budget (billions) for the agent role on this machine. */
  capB: number;
}

export interface AgentRouteInput {
  ramGb: number;
  userPick: { name: string; isLocal: boolean } | null;
  pin: string | null;
  /** Local Ollama models Artha knows exist (installed and/or configured). */
  candidates: string[];
  /** Models that scored 0 on the tool-argument benchmark — never an agent. */
  knownBadToolCalls: Set<string>;
}

/** Parameter count (billions) parsed from an Ollama tag ("qwen2.5:14b-instruct-q4"
 *  → 14). Infinity when the tag carries no size: unknown is not eligible for
 *  automatic selection, but a user's explicit pick of such a model is honoured
 *  because we cannot prove it unfit. */
export function modelParamsB(name: string): number {
  const tag = name.includes(':') ? name.slice(name.lastIndexOf(':') + 1) : name;
  const m = tag.match(/(\d+(?:\.\d+)?)\s*b\b/i) ?? name.match(/(\d+(?:\.\d+)?)\s*b\b/i);
  return m ? parseFloat(m[1]) : Infinity;
}

/** Largest model (billions of params) the agent role may use, by system RAM.
 *  Not "what fits" — what stays interactive. Unified-memory Macs can LOAD a 72B
 *  at 128 GB, but prompt evaluation is ~55 tok/s; a 14B does the same turn in
 *  ~20 s. Thresholds mirror the onboarding hardware recommendation. */
export function agentParamCapB(ramGb: number): number {
  if (ramGb >= 64) return 32;
  if (ramGb >= 32) return 15;
  if (ramGb >= 16) return 8;
  return 4;
}

/** The tier's preferred agent model, matched by tag prefix against candidates. */
export function tierDefaultPrefix(ramGb: number): string {
  if (ramGb >= 32) return 'qwen2.5:14b';
  if (ramGb >= 16) return 'qwen2.5:7b';
  return 'llama3.2:3b';
}

const EMBEDDING_LIKE = /embed|nomic|bge|e5-/i;

function eligible(name: string, capB: number, bad: Set<string>): boolean {
  if (bad.has(name)) return false;
  if (EMBEDDING_LIKE.test(name)) return false;
  const b = modelParamsB(name);
  return Number.isFinite(b) && b <= capB;
}

export function routeAgentModel(input: AgentRouteInput): AgentRoute {
  const capB = agentParamCapB(input.ramGb);
  const userPick = input.userPick?.name ?? null;

  if (input.pin) {
    return { model: input.pin, source: 'pin', userPick, capB,
      reason: `Pinned by you. Artha would otherwise choose automatically.` };
  }
  if (!input.userPick) {
    return { model: null, source: 'none', userPick, capB, reason: 'No model configured.' };
  }
  if (!input.userPick.isLocal) {
    return { model: userPick, source: 'user', userPick, capB,
      reason: `${userPick} is a cloud model you chose explicitly. Artha never switches to or from cloud on its own.` };
  }
  const bad = input.knownBadToolCalls;
  const pickB = modelParamsB(input.userPick.name);
  const pickTooBig = Number.isFinite(pickB) && pickB > capB;
  const pickBad = bad.has(input.userPick.name);
  if (!pickTooBig && !pickBad) {
    return { model: userPick, source: 'user', userPick, capB, reason: `${userPick} is your pick and fits this Mac's agent budget.` };
  }

  // Auto: tier default if installed, else the largest eligible local model.
  const pool = [...new Set(input.candidates)].filter(n => eligible(n, capB, bad));
  const prefix = tierDefaultPrefix(input.ramGb);
  const tierDefault = pool.find(n => n.startsWith(prefix));
  const best = tierDefault ?? [...pool].sort((a, b) => modelParamsB(b) - modelParamsB(a))[0];
  const why = pickBad
    ? `${userPick} failed Artha's tool-calling check`
    : `${userPick} is too large to run the agent loop quickly on this Mac (${input.ramGb} GB RAM, agent budget ~${capB}B)`;
  if (best) {
    return { model: best, source: 'auto', userPick, capB, reason: `${why}. Using ${best} for actions; tap to use your pick anyway.` };
  }
  return { model: userPick, source: 'user-fallback', userPick, capB,
    reason: `${why}, but no smaller tool-capable model is installed. Using it anyway — expect slow turns.` };
}

// ── DB / OS-facing resolver ─────────────────────────────────────────────────

/** Installed Ollama tags, refreshed in the background so the synchronous
 *  router can see models the user pulled but never "added" in Settings. */
let installedTags: string[] = [];
let installedAt = 0;
let refreshing: Promise<void> | null = null;

export async function refreshInstalledModels(base = 'http://localhost:11434'): Promise<string[]> {
  if (!refreshing) {
    refreshing = (async () => {
      try {
        const res = await fetch(`${base}/api/tags`);
        const json = await res.json() as { models?: { name: string }[] };
        installedTags = (json.models ?? []).map(m => m.name).filter(Boolean);
        installedAt = Date.now();
      } catch { /* Ollama down — keep the last list */ }
      finally { refreshing = null; }
    })();
  }
  await refreshing;
  return installedTags;
}

/** better-sqlite3 Database (typed loosely, as resolveTransport does, so the
 *  pure router stays free of the driver's generics). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = any;

const PIN_KEY = 'agentModelPin';

export function readAgentPin(db: Db): string | null {
  try {
    const row = db.prepare(`SELECT settings_json FROM users WHERE user_id='default'`).get() as { settings_json?: string } | undefined;
    const v = JSON.parse(row?.settings_json ?? '{}')[PIN_KEY];
    return typeof v === 'string' && v ? v : null;
  } catch { return null; }
}

export function writeAgentPin(db: Db, pin: string | null): void {
  const row = db.prepare(`SELECT settings_json FROM users WHERE user_id='default'`).get() as { settings_json?: string } | undefined;
  const settings = JSON.parse(row?.settings_json ?? '{}');
  if (pin) settings[PIN_KEY] = pin; else delete settings[PIN_KEY];
  db.prepare(`UPDATE users SET settings_json=? WHERE user_id='default'`).run(JSON.stringify(settings));
}

/** Route the agent role from live state: active model, pin, RAM, known-bad
 *  benchmark rows, and every local model Artha knows about. Synchronous (the
 *  LLM client resolves transports synchronously); kicks a background refresh
 *  of installed tags when the cache is older than a minute. */
export function resolveAgentRoute(db: Db): AgentRoute {
  if (Date.now() - installedAt > 60_000) void refreshInstalledModels();
  const active = db.prepare(`SELECT ollama_name, provider, base_url FROM llm_models WHERE is_active=1 LIMIT 1`).get() as
    { ollama_name?: string; provider?: string; base_url?: string } | undefined;
  const userPick = active?.ollama_name
    ? { name: active.ollama_name, isLocal: isOllamaManaged(active.provider, active.base_url) }
    : null;
  const configured = (db.prepare(`SELECT ollama_name FROM llm_models WHERE provider='ollama'`).all() as { ollama_name: string }[]).map(r => r.ollama_name);
  let profiled: string[] = [];
  let bad = new Set<string>();
  try {
    profiled = (db.prepare(`SELECT DISTINCT ollama_name FROM model_profiles`).all() as { ollama_name: string }[]).map(r => r.ollama_name);
    bad = new Set((db.prepare(`SELECT ollama_name FROM model_profiles WHERE task_type='tool_args' AND quality <= 0`).all() as { ollama_name: string }[]).map(r => r.ollama_name));
  } catch { /* benchmark tables are optional evidence */ }
  return routeAgentModel({
    ramGb: Math.round(os.totalmem() / 1024 ** 3),
    userPick,
    pin: readAgentPin(db),
    candidates: [...configured, ...profiled, ...installedTags],
    knownBadToolCalls: bad,
  });
}
