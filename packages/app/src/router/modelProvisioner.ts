/**
 * Model provisioner — Artha keeps a fast, tool-capable model installed for
 * the agent role, without asking the user to pick or download anything.
 *
 * Slice 2 of the agent-routing decision (2026-09-05): "auto-install consent
 * ONCE at onboarding". The router (agentRouter.ts) can only choose among what
 * is installed; on a machine where the user's only local model is a 72B, it
 * had to fall back to it ("user-fallback", 5-minute turns). This module closes
 * that gap: when routing lands on a fallback, or on an auto pick weaker than
 * the hardware tier's default, Artha pulls the tier default in the background,
 * registers it, probes its tool calling, and the next run routes to it.
 *
 * Guard-rails, in order:
 *   - consent: users.settings_json.autoModelManagement (default true; the
 *     onboarding "Artha manages models" line and the Router panel toggle both
 *     write it). Off ⇒ never pulls.
 *   - never when the user's pick is cloud (routing leaves cloud alone) or when
 *     no model is configured at all (the user chose "set up later").
 *   - disk: refuses when free space < 2× the estimated download.
 *   - backoff: a failed attempt is not retried for 24 h; state is persisted
 *     under settings_json.agentModelProvision so a crash can't loop it.
 *   - one attempt in flight per process.
 *
 * Pure policy (`planProvision`) + an effectful `ensureAgentModel` runner, like
 * agentRouter.ts, so the decision is unit-tested without Ollama.
 */
import os from 'os';
import fs from 'fs';
import { getDb } from '../db/schema';
import { pullOllamaModel, isModelInstalled } from '../llm/ollamaPull';
import { benchmarkModel } from './benchmark';
import { agentParamCapB, modelParamsB, refreshInstalledModels, resolveAgentRoute, tierDefaultPrefix, type AgentRoute } from './agentRouter';

export interface ProvisionDecision {
  action: 'none' | 'install';
  /** Full Ollama tag to pull when action === 'install'. */
  tag?: string;
  reason: string;
}

export interface ProvisionInput {
  ramGb: number;
  /** Installed Ollama tags. */
  installed: string[];
  /** users.settings_json.autoModelManagement (undefined ⇒ default on). */
  autoManage: boolean | undefined;
  route: Pick<AgentRoute, 'source' | 'model'>;
  /** Free bytes on the volume that holds Ollama's models (null = unknown). */
  freeBytes: number | null;
  /** Last failed attempt for this tag, epoch ms (null = none). */
  lastFailureAt: number | null;
  now?: number;
}

/** The concrete tag for the tier default. The router matches by prefix
 *  (`tierDefaultPrefix`), so any quant of this family counts as installed;
 *  when WE install it, pick the quant the onboarding recommendation uses. */
export function tierDefaultTag(ramGb: number): string {
  const prefix = tierDefaultPrefix(ramGb);
  return `${prefix}-instruct-q4_K_M`;
}

/** Rough on-disk size of a q4 model, GB ≈ 0.6 × params(B) + 0.5. Used only for
 *  the free-space guard, so erring large is the safe direction. */
export function estimatedDownloadGb(tag: string): number {
  const b = modelParamsB(tag);
  return Number.isFinite(b) ? b * 0.6 + 0.5 : 10;
}

const RETRY_AFTER_MS = 24 * 60 * 60 * 1000;

export function planProvision(input: ProvisionInput): ProvisionDecision {
  if (input.autoManage === false) return { action: 'none', reason: 'Automatic model management is off.' };
  const { source, model } = input.route;
  if (source === 'none') return { action: 'none', reason: 'No model configured — the user has not chosen a local setup.' };
  if (source === 'pin') return { action: 'none', reason: 'The user pinned a model for actions.' };
  const prefix = tierDefaultPrefix(input.ramGb);
  if (input.installed.some(n => n.startsWith(prefix))) {
    return { action: 'none', reason: `${prefix} is already installed.` };
  }
  // 'user' means the pick is cloud, or a local model that fits. Neither needs
  // a download: cloud is the user's explicit choice; a fitting local pick is
  // what the router will run anyway.
  if (source === 'user') return { action: 'none', reason: 'The user\'s pick already fits the agent budget.' };
  // 'auto' picked a substitute; only install when the substitute is weaker
  // than the tier default (e.g. a 3B standing in for a 14B on a 64 GB Mac).
  if (source === 'auto' && model) {
    const have = modelParamsB(model);
    const want = modelParamsB(prefix);
    if (Number.isFinite(have) && have >= want * 0.8) {
      return { action: 'none', reason: `${model} is close enough to the tier default.` };
    }
  }
  const tag = tierDefaultTag(input.ramGb);
  const now = input.now ?? Date.now();
  if (input.lastFailureAt && now - input.lastFailureAt < RETRY_AFTER_MS) {
    return { action: 'none', reason: `A download of ${tag} failed recently; retrying tomorrow.` };
  }
  if (modelParamsB(tag) > agentParamCapB(input.ramGb)) {
    return { action: 'none', reason: `${tag} exceeds this machine's agent budget.` };
  }
  const needGb = estimatedDownloadGb(tag) * 2;
  if (input.freeBytes !== null && input.freeBytes < needGb * 1024 ** 3) {
    return { action: 'none', reason: `Not enough free disk for ${tag} (need ~${Math.ceil(needGb)} GB free).` };
  }
  const why = source === 'user-fallback'
    ? 'no installed model fits the agent budget'
    : `${model} is a weak stand-in for the tier default`;
  return { action: 'install', tag, reason: `Installing ${tag} because ${why}.` };
}

// ── Effectful runner ────────────────────────────────────────────────────────

export type ProvisionPhase = 'checking' | 'installing' | 'probing' | 'ready' | 'skipped' | 'failed';

export interface ProvisionEvent {
  phase: ProvisionPhase;
  tag?: string;
  percent?: number;
  reason: string;
}

export interface ProvisionDeps {
  /** Renderer-facing emit (channel, payload). Progress goes to BOTH
   *  `agent:modelProvision` (chip/banner) and `llm:pullProgress` (the Models
   *  panel's existing progress rows), so nothing new is needed to see it. */
  emit: (channel: string, payload: unknown) => void;
  /** OS notification when a model was installed and routing changed. */
  notify?: (title: string, body: string) => void;
  ollamaBase?: string;
}

const SETTINGS_KEY = 'agentModelProvision';
interface ProvisionState { tag: string; status: 'installed' | 'failed'; at: number; error?: string }

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function readSettings(db: any): Record<string, unknown> {
  try {
    const row = db.prepare(`SELECT settings_json FROM users WHERE user_id='default'`).get() as { settings_json?: string } | undefined;
    return JSON.parse(row?.settings_json ?? '{}');
  } catch { return {}; }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function writeSetting(db: any, key: string, value: unknown): void {
  const s = readSettings(db);
  s[key] = value;
  db.prepare(`UPDATE users SET settings_json=? WHERE user_id='default'`).run(JSON.stringify(s));
}

async function freeBytesForModels(): Promise<number | null> {
  try {
    const dir = process.env.OLLAMA_MODELS || `${os.homedir()}/.ollama`;
    const target = fs.existsSync(dir) ? dir : os.homedir();
    const st = await fs.promises.statfs(target);
    return Number(st.bavail) * Number(st.bsize);
  } catch { return null; }
}

let inFlight: Promise<ProvisionEvent> | null = null;

/** Decide and, if warranted, install the tier-default agent model. Safe to
 *  call often (startup, after every routed run): it is cheap when nothing is
 *  needed and de-duplicates concurrent callers. Never throws. */
export function ensureAgentModel(deps: ProvisionDeps): Promise<ProvisionEvent> {
  if (inFlight) return inFlight;
  inFlight = run(deps).finally(() => { inFlight = null; });
  return inFlight;
}

async function run(deps: ProvisionDeps): Promise<ProvisionEvent> {
  const emitEvt = (e: ProvisionEvent) => { try { deps.emit('agent:modelProvision', e); } catch { /* renderer gone */ } return e; };
  const base = deps.ollamaBase ?? 'http://localhost:11434';
  let db;
  try { db = getDb(); } catch { return { phase: 'skipped', reason: 'Database not ready.' }; }

  const settings = readSettings(db);
  const installed = await refreshInstalledModels(base);
  const route = resolveAgentRoute(db);
  const ramGb = Math.round(os.totalmem() / 1024 ** 3);
  const tag = tierDefaultTag(ramGb);
  const prev = settings[SETTINGS_KEY] as ProvisionState | undefined;
  const decision = planProvision({
    ramGb,
    installed,
    autoManage: settings.autoModelManagement as boolean | undefined,
    route,
    freeBytes: await freeBytesForModels(),
    lastFailureAt: prev?.tag === tag && prev.status === 'failed' ? prev.at : null,
  });
  if (decision.action !== 'install' || !decision.tag) {
    return { phase: 'skipped', reason: decision.reason };
  }

  const name = decision.tag;
  console.log(`[Artha] model provisioner: ${decision.reason}`);
  emitEvt({ phase: 'installing', tag: name, percent: 0, reason: decision.reason });
  const result = await pullOllamaModel(name, (p) => {
    deps.emit('llm:pullProgress', { name, status: p.status, completed: p.completed, total: p.total, percent: p.percent, auto: true });
    if (p.percent !== undefined) emitEvt({ phase: 'installing', tag: name, percent: p.percent, reason: decision.reason });
  }, { base });

  if (!result.ok || !(await isModelInstalled(name, base))) {
    const error = result.error ?? 'Model not present after download.';
    writeSetting(db, SETTINGS_KEY, { tag: name, status: 'failed', at: Date.now(), error } satisfies ProvisionState);
    deps.emit('llm:pullProgress', { name, status: 'error', error, auto: true });
    console.warn(`[Artha] model provisioner: ${name} failed — ${error}`);
    return emitEvt({ phase: 'failed', tag: name, reason: error });
  }

  // Register (NOT active — the user's pick stays their pick; the router will
  // select this one for actions on its own).
  try {
    const exists = db.prepare(`SELECT 1 FROM llm_models WHERE ollama_name=?`).get(name);
    if (!exists) {
      db.prepare(`INSERT INTO llm_models (name, ollama_name, base_url, api_key, provider, is_active) VALUES (?,?,?,?,?,0)`)
        .run(name, name, `${base}/v1`, 'ollama', 'ollama');
    }
  } catch (err) { console.warn('[Artha] model provisioner: could not register model row:', err); }

  // Prove it can call tools before the router trusts it (a 0 here would make
  // the router skip it — better to know now than mid-task).
  emitEvt({ phase: 'probing', tag: name, percent: 100, reason: `Checking ${name} can call tools…` });
  try { await benchmarkModel(name); } catch (err) { console.warn('[Artha] model provisioner: probe failed:', err); }

  writeSetting(db, SETTINGS_KEY, { tag: name, status: 'installed', at: Date.now() } satisfies ProvisionState);
  await refreshInstalledModels(base);
  deps.emit('llm:pullProgress', { name, status: 'success', percent: 100, auto: true });
  try { deps.emit('agent:modelRouted', resolveAgentRoute(db)); } catch { /* informational */ }
  deps.notify?.('Artha is ready for faster actions', `${name} was installed automatically and will run tasks that use tools.`);
  return emitEvt({ phase: 'ready', tag: name, percent: 100, reason: `${name} installed and checked.` });
}

/** Test seam: forget the in-flight promise. */
export function _resetProvisionerForTests(): void { inFlight = null; }
