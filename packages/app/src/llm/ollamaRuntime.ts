/**
 * Ollama runtime lifecycle — Artha turns the local model "on" itself.
 *
 * On launch we detect whether the Ollama server is reachable; if not, we start
 * it on the user's behalf (never instructing them to run a terminal command),
 * then pre-warm the active model into memory so their first message is fast
 * instead of paying a cold load (the old ~2-minute first-response problem).
 * Progress is emitted as `ModelStatus` so the renderer can show a quick,
 * non-blocking banner.
 *
 * Resource policy (see also the `ollama_stop_on_quit` setting):
 *   - The Ollama *server* is a near-free idle daemon, so we leave it running
 *     for instant restarts and to avoid disrupting other tools.
 *   - The loaded *model* is the real RAM cost, so we evict it on quit
 *     (`keep_alive: 0`). Users who want zero background footprint can opt to
 *     fully stop the server we started.
 *   - We only ever stop a server WE started — never one the user (or the macOS
 *     menubar app) was already running.
 */
import { spawn, execFile, type ChildProcess } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import { getDb } from '../db/schema';
import { isOllamaManaged } from './providerKind';

const execFileAsync = promisify(execFile);
const OLLAMA_HOST = 'http://localhost:11434';
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

export type ModelStatusPhase =
  | 'checking' | 'starting' | 'warming' | 'ready' | 'not_installed' | 'no_model' | 'error';
export interface ModelStatus { phase: ModelStatusPhase; model?: string; detail?: string; }

/** Did Artha spawn the server this session? Gates "stop on quit". */
let startedByArtha = false;
/** Handle to the `ollama serve` we spawned (CLI path only), so we can stop it. */
let serverProc: ChildProcess | null = null;
let lastStatus: ModelStatus = { phase: 'checking' };

export function getModelStatus(): ModelStatus { return lastStatus; }
export function didStartOllama(): boolean { return startedByArtha; }

/** Is the Ollama server responding? Short timeout so a missing server fails fast. */
async function isUp(timeoutMs = 1500): Promise<boolean> {
  try {
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), timeoutMs);
    const res = await fetch(`${OLLAMA_HOST}/api/tags`, { signal: c.signal });
    clearTimeout(t);
    return res.ok;
  } catch { return false; }
}

// Electron launched from Finder has a minimal PATH, so probe known install
// locations instead of relying on `ollama` being on PATH.
const CLI_CANDIDATES = [
  '/opt/homebrew/bin/ollama', // Apple Silicon Homebrew
  '/usr/local/bin/ollama',    // Intel Homebrew / official installer symlink
  '/usr/bin/ollama',
  process.env.HOME ? `${process.env.HOME}/.local/bin/ollama` : '',
].filter(Boolean) as string[];

const MAC_APP = '/Applications/Ollama.app';

function findCli(): string | undefined {
  for (const p of CLI_CANDIDATES) {
    try { if (fs.existsSync(p)) return p; } catch { /* ignore */ }
  }
  return undefined;
}
function macAppInstalled(): boolean {
  try { return fs.existsSync(MAC_APP); } catch { return false; }
}
/** Is Ollama installed at all (CLI or macOS app)? */
export function ollamaInstalled(): boolean { return !!findCli() || macAppInstalled(); }

/** Start the Ollama server: prefer the CLI (`ollama serve`); else launch the
 *  macOS menubar app (which starts the server). Returns whether a start was
 *  attempted. */
async function startServer(): Promise<boolean> {
  const cli = findCli();
  if (cli) {
    try {
      // Detached + unref so the daemon outlives a window close; ignore stdio so
      // it doesn't tie to our pipes. We keep the handle to stop it on quit if
      // the user opted in.
      const child = spawn(cli, ['serve'], { detached: true, stdio: 'ignore' });
      child.unref();
      serverProc = child;
      startedByArtha = true;
      return true;
    } catch { /* fall through to the app */ }
  }
  if (macAppInstalled()) {
    try {
      await execFileAsync('open', ['-a', 'Ollama']);
      // The menubar app owns its own server lifecycle — mark that we triggered a
      // start, but leave `serverProc` null so we never kill the user's app.
      startedByArtha = true;
      return true;
    } catch { /* fall through */ }
  }
  return false;
}

/** Active model row from the DB (mirrors getActiveLLMClient), including
 *  whether its lifecycle is ours to manage. Ollama warm-up/unload/auto-start
 *  must NEVER fire for a cloud/BYOK active model — that used to POST cloud
 *  model names at localhost and show a false "Ollama isn't installed" nag. */
function activeModel(): { name: string; numCtx: number; ollamaManaged: boolean } | undefined {
  try {
    const row = getDb()
      .prepare(`SELECT ollama_name, context_window, provider, base_url FROM llm_models WHERE is_active=1 LIMIT 1`)
      .get() as { ollama_name: string; context_window: number; provider?: string; base_url?: string } | undefined;
    if (!row?.ollama_name) return undefined;
    return {
      name: row.ollama_name,
      numCtx: row.context_window ?? 8192,
      ollamaManaged: isOllamaManaged(row.provider, row.base_url),
    };
  } catch { return undefined; }
}

/** Load the active model into memory with the SAME num_ctx the chat path uses,
 *  so the first real message reuses the resident runner (no cold load/reload). */
async function warm(model: string, numCtx: number): Promise<boolean> {
  try {
    const res = await fetch(`${OLLAMA_HOST}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // Empty prompt = load-only; Ollama returns once the model is resident.
      body: JSON.stringify({ model, prompt: '', keep_alive: '30m', options: { num_ctx: numCtx } }),
    });
    return res.ok;
  } catch { return false; }
}

/**
 * Ensure the local model is ready, emitting status the renderer can surface.
 * Safe to call fire-and-forget on launch — it never blocks the window.
 */
export async function ensureModelReady(emit: (s: ModelStatus) => void): Promise<void> {
  const set = (s: ModelStatus) => { lastStatus = s; try { emit(s); } catch { /* ignore */ } };
  const m = activeModel();
  set({ phase: 'checking', model: m?.name });

  // Cloud/BYOK active model: nothing local to start or warm — the provider is
  // remote and ready by definition. No server auto-start, no warm-up, no
  // install nag. The ONLY localhost traffic allowed on this path is a single
  // read-only reachability probe: if the user ALSO has Ollama running, local
  // embeddings (memory ranking / RAG) still work, so provision the embed
  // model; if Ollama is absent, do nothing and stay quiet.
  if (m && !m.ollamaManaged) {
    set({ phase: 'ready', model: m.name });
    if (await isUp()) void ensureEmbedModel();
    return;
  }

  if (!(await isUp())) {
    // "Install Ollama" is only the right message when a LOCAL model is (or is
    // about to be) the active one. With nothing configured at all, the honest
    // state is 'no_model' — the user should choose a setup path (local model
    // OR their own API key), not be steered to Ollama by default.
    if (!ollamaInstalled()) { set({ phase: m ? 'not_installed' : 'no_model' }); return; }
    set({ phase: 'starting', model: m?.name });
    if (!(await startServer())) { set({ phase: m ? 'not_installed' : 'no_model' }); return; }
    // Cold daemon start is usually a couple seconds; poll up to 20s.
    const deadline = Date.now() + 20_000;
    let up = false;
    while (Date.now() < deadline) {
      if (await isUp()) { up = true; break; }
      await sleep(600);
    }
    if (!up) { set({ phase: 'error', detail: 'Ollama did not start in time.' }); return; }
  }

  // Server up but nothing active: report the truthful empty state (the old
  // 'ready' here let a fresh install look configured when it wasn't). The
  // server is left running for onboarding's model list/pull flows.
  if (!m) { set({ phase: 'no_model' }); return; }
  set({ phase: 'warming', model: m.name });
  await warm(m.name, m.numCtx);
  set({ phase: 'ready', model: m.name });

  // The window is usable now — provision the embedding model in the
  // background. Without it, semantic memory ranking and RAG indexing silently
  // degrade to keyword matching and nothing ever tells the user.
  void ensureEmbedModel();
}

/** The embedding model every semantic feature depends on (memory ranking,
 *  RAG indexes — see agent/contextGather.ts and rag/indexer.ts). */
const EMBED_MODEL = 'nomic-embed-text';

/**
 * Ensure the embedding model is installed, pulling it in the background if
 * missing (~270 MB, one-time). Fire-and-forget + best-effort: a failed pull
 * leaves the existing keyword fallback exactly as it was. Exported so
 * onboarding / RAG panel flows can also trigger it explicitly.
 */
export async function ensureEmbedModel(): Promise<boolean> {
  try {
    const res = await fetch(`${OLLAMA_HOST}/api/tags`);
    const json = await res.json() as { models?: { name: string }[] };
    const installed = (json.models ?? []).some(t => t.name === EMBED_MODEL || t.name.startsWith(`${EMBED_MODEL}:`));
    if (installed) return true;
    console.log(`[Artha] Embedding model ${EMBED_MODEL} missing — pulling in background…`);
    const pull = await fetch(`${OLLAMA_HOST}/api/pull`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: EMBED_MODEL, stream: false }),
    });
    const ok = pull.ok;
    console.log(`[Artha] Embedding model pull ${ok ? 'completed' : 'failed'}.`);
    return ok;
  } catch {
    return false; // Ollama down / offline — keyword fallback carries on
  }
}

/** Whether semantic features (memory ranking, RAG vector search) actually
 *  work right now — they require local Ollama + the embed model. Consumed by
 *  the honest degraded-state notices (Phase A commit 10): before this, a
 *  missing embedder silently produced zero-vector indexes and keyword-only
 *  memory with no indication anywhere. */
export type SemanticStatus =
  | { available: true }
  | { available: false; reason: 'ollama_down' | 'embed_model_missing' };

export async function getSemanticStatus(): Promise<SemanticStatus> {
  try {
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), 1500);
    const res = await fetch(`${OLLAMA_HOST}/api/tags`, { signal: c.signal });
    clearTimeout(t);
    if (!res.ok) return { available: false, reason: 'ollama_down' };
    const json = await res.json() as { models?: { name: string }[] };
    const installed = (json.models ?? []).some(
      t2 => t2.name === EMBED_MODEL || t2.name.startsWith(`${EMBED_MODEL}:`)
    );
    return installed ? { available: true } : { available: false, reason: 'embed_model_missing' };
  } catch {
    return { available: false, reason: 'ollama_down' };
  }
}

/** Evict the active model from memory (`keep_alive: 0`). Best-effort; called on
 *  quit so a multi-GB model isn't left resident after Artha closes. */
export async function unloadActiveModel(): Promise<void> {
  const m = activeModel();
  // Cloud/BYOK model: nothing resident in local Ollama to evict.
  if (!m || !m.ollamaManaged) return;
  try {
    await fetch(`${OLLAMA_HOST}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: m.name, keep_alive: 0 }),
    });
  } catch { /* best-effort */ }
}

/** Stop the Ollama server — ONLY the `ollama serve` process we spawned. If the
 *  server was already running (user/menubar app), this is a no-op. */
export async function stopOllamaIfStarted(): Promise<void> {
  if (!startedByArtha || !serverProc?.pid) return;
  try {
    // Detached child started its own process group; kill the group.
    process.kill(-serverProc.pid, 'SIGTERM');
  } catch {
    try { serverProc.kill('SIGTERM'); } catch { /* best-effort */ }
  } finally {
    serverProc = null;
  }
}
