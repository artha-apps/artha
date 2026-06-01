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

const execFileAsync = promisify(execFile);
const OLLAMA_HOST = 'http://localhost:11434';
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

export type ModelStatusPhase =
  | 'checking' | 'starting' | 'warming' | 'ready' | 'not_installed' | 'error';
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

/** Active model name + context window from the DB (mirrors getActiveLLMClient). */
function activeModel(): { name: string; numCtx: number } | undefined {
  try {
    const row = getDb()
      .prepare(`SELECT ollama_name, context_window FROM llm_models WHERE is_active=1 LIMIT 1`)
      .get() as { ollama_name: string; context_window: number } | undefined;
    if (!row?.ollama_name) return undefined;
    return { name: row.ollama_name, numCtx: row.context_window ?? 8192 };
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

  if (!(await isUp())) {
    if (!ollamaInstalled()) { set({ phase: 'not_installed' }); return; }
    set({ phase: 'starting', model: m?.name });
    if (!(await startServer())) { set({ phase: 'not_installed' }); return; }
    // Cold daemon start is usually a couple seconds; poll up to 20s.
    const deadline = Date.now() + 20_000;
    let up = false;
    while (Date.now() < deadline) {
      if (await isUp()) { up = true; break; }
      await sleep(600);
    }
    if (!up) { set({ phase: 'error', detail: 'Ollama did not start in time.' }); return; }
  }

  if (!m) { set({ phase: 'ready' }); return; } // server up, no active model configured yet
  set({ phase: 'warming', model: m.name });
  await warm(m.name, m.numCtx);
  set({ phase: 'ready', model: m.name });
}

/** Evict the active model from memory (`keep_alive: 0`). Best-effort; called on
 *  quit so a multi-GB model isn't left resident after Artha closes. */
export async function unloadActiveModel(): Promise<void> {
  const m = activeModel();
  if (!m) return;
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
