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
import { readManagedRuntime, resolvePinnedVersion, type ManagedRuntime } from './ollamaRuntimeManager';
import { getServerVersion, compareVersions } from './ollamaVersion';

const execFileAsync = promisify(execFile);
const OLLAMA_HOST = 'http://localhost:11434';
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// ── Artha-managed runtime (see ollamaRuntimeManager.ts) ────────────────────
// The userData root is INJECTED by main.ts once the profile is resolved —
// this module must not resolve paths on its own (bootstrap-safety invariant,
// threat model §8b). Until set, no managed runtime is considered.
let managedRoot: string | null = null;
export function setManagedRuntimeRoot(userDataDir: string): void { managedRoot = userDataDir; }
/** The Artha-installed Ollama, if any. */
export function getManagedRuntime(): ManagedRuntime | null {
  return managedRoot ? readManagedRuntime(managedRoot) : null;
}

/** Which binary the server WE started came from (null = we didn't start it). */
export type ServerOrigin = 'managed' | 'system' | 'app';
let serverOrigin: ServerOrigin | null = null;

/** Durable consent: the user chose "let Artha manage Ollama" — persisted in
 *  users.settings_json so a login-item Ollama.app re-taking :11434 next boot
 *  is replaced again WITHOUT re-asking. Off by default; only ever set by the
 *  explicit consent step in the UI (ollama:runtimeSwitch). */
export function managedConsentGranted(): boolean {
  try {
    const row = getDb().prepare(`SELECT settings_json FROM users WHERE user_id='default'`).get() as { settings_json: string } | undefined;
    return JSON.parse(row?.settings_json ?? '{}').ollama_runtime_managed === true;
  } catch { return false; }
}

export type ModelStatusPhase =
  | 'checking' | 'starting' | 'warming' | 'ready' | 'not_installed' | 'no_model' | 'error';
export interface ModelStatus {
  phase: ModelStatusPhase;
  model?: string;
  detail?: string;
  /** Present on 'no_model': whether Ollama exists on this machine. Onboarding
   *  needs the distinction ('no_model' deliberately replaces the install nag
   *  for configure-later users, but the LOCAL setup path must still show the
   *  install card when Ollama is genuinely absent — review finding B1). */
  ollamaInstalled?: boolean;
}

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

/** A system-installed CLI (Homebrew / official installer symlink), if any. */
function findSystemCli(): string | undefined {
  for (const p of CLI_CANDIDATES) {
    try { if (fs.existsSync(p)) return p; } catch { /* ignore */ }
  }
  return undefined;
}
/** The binary to start: the Artha-managed runtime wins when installed (the
 *  user put it there through Artha precisely so Artha would run it), else a
 *  system CLI. */
function findCli(): { path: string; origin: ServerOrigin } | undefined {
  const managed = getManagedRuntime();
  if (managed) return { path: managed.binPath, origin: 'managed' };
  const sys = findSystemCli();
  return sys ? { path: sys, origin: 'system' } : undefined;
}
function macAppInstalled(): boolean {
  try { return fs.existsSync(MAC_APP); } catch { return false; }
}
/** Is Ollama installed at all (managed runtime, system CLI, or macOS app)? */
export function ollamaInstalled(): boolean { return !!findCli() || macAppInstalled(); }

/** Start the Ollama server: prefer a CLI binary (`ollama serve` — managed
 *  first, then system); else launch the macOS menubar app (which starts the
 *  server). Returns whether a start was attempted. */
async function startServer(): Promise<boolean> {
  const cli = findCli();
  if (cli) {
    try {
      // Detached + unref so the daemon outlives a window close; ignore stdio so
      // it doesn't tie to our pipes. We keep the handle to stop it on quit if
      // the user opted in.
      const child = spawn(cli.path, ['serve'], { detached: true, stdio: 'ignore' });
      child.unref();
      serverProc = child;
      startedByArtha = true;
      serverOrigin = cli.origin;
      return true;
    } catch { /* fall through to the app */ }
  }
  if (macAppInstalled()) {
    try {
      await execFileAsync('open', ['-a', 'Ollama']);
      // The menubar app owns its own server lifecycle — mark that we triggered a
      // start, but leave `serverProc` null so we never kill the user's app.
      startedByArtha = true;
      serverOrigin = 'app';
      return true;
    } catch { /* fall through */ }
  }
  return false;
}

/** Poll until the server answers (or not) within `ms`. */
async function waitUp(ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await isUp()) return true;
    await sleep(500);
  }
  return false;
}
async function waitDown(ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (!(await isUp())) return true;
    await sleep(500);
  }
  return false;
}

/**
 * Stop an Ollama server Artha did NOT start. Only ever called from the
 * consent-gated switch below — the user has explicitly agreed that Artha may
 * replace the copy running on :11434 with its managed one. Graceful first
 * (quit the menubar app), then a TERM to a process that is verifiably
 * `ollama`. Never touches anything that isn't Ollama. Returns whether the
 * port is free afterwards.
 */
async function stopExternalServer(): Promise<boolean> {
  if (process.platform === 'darwin') {
    try { await execFileAsync('osascript', ['-e', 'tell application "Ollama" to quit']); } catch { /* not running as an app */ }
    if (await waitDown(6_000)) return true;
  }
  if (process.platform === 'win32') {
    for (const image of ['ollama app.exe', 'ollama.exe']) {
      try { await execFileAsync('taskkill', ['/IM', image, '/F'], { windowsHide: true }); } catch { /* not running */ }
    }
    return waitDown(6_000);
  }
  // POSIX: find the listener on :11434 and TERM it if it is an ollama process.
  try {
    const { stdout } = await execFileAsync('lsof', ['-tiTCP:11434', '-sTCP:LISTEN']);
    for (const pidStr of stdout.split('\n').map(s => s.trim()).filter(Boolean)) {
      const pid = Number(pidStr);
      if (!Number.isInteger(pid) || pid <= 1) continue;
      try {
        const { stdout: comm } = await execFileAsync('ps', ['-o', 'comm=', '-p', String(pid)]);
        if (!/ollama/i.test(comm)) continue; // a squatter — not ours to kill
        process.kill(pid, 'SIGTERM');
      } catch { /* gone already */ }
    }
  } catch { /* lsof missing or nothing listening */ }
  return waitDown(6_000);
}

export type SwitchResult =
  | { ok: true; version: string }
  | { ok: false; reason: 'no_managed_runtime' | 'external_running' | 'external_still_running' | 'start_failed' | 'version_mismatch'; detail: string };

/**
 * Make the Artha-managed runtime the server on :11434.
 *   - Nothing running → start managed.
 *   - Artha started the current server → stop it, start managed.
 *   - Someone ELSE started it → only with `allowStopExternal` (the consent
 *     click), else return `external_running` so the UI can ask.
 * Verifies the version that answers afterwards is really the managed one.
 */
export async function switchToManagedRuntime(opts: { allowStopExternal: boolean }): Promise<SwitchResult> {
  const managed = getManagedRuntime();
  if (!managed) return { ok: false, reason: 'no_managed_runtime', detail: 'Artha has not installed its own Ollama yet.' };

  if (await isUp()) {
    const current = await getServerVersion(OLLAMA_HOST);
    if (startedByArtha && serverOrigin === 'managed' && current === managed.version) return { ok: true, version: managed.version };
    if (startedByArtha && serverProc?.pid) {
      await stopOllamaIfStarted();
      if (!(await waitDown(6_000))) return { ok: false, reason: 'external_still_running', detail: 'The previous Ollama server did not stop.' };
    } else {
      if (!opts.allowStopExternal) {
        return { ok: false, reason: 'external_running', detail: `Ollama ${current ?? '(unknown version)'} is running outside Artha.` };
      }
      if (!(await stopExternalServer())) {
        return { ok: false, reason: 'external_still_running', detail: 'Artha could not stop the Ollama that is already running on this machine (it may be a system service). Quit it, then try again.' };
      }
    }
  }

  startedByArtha = false; serverProc = null; serverOrigin = null;
  if (!(await startServer()) || serverOrigin !== 'managed') {
    return { ok: false, reason: 'start_failed', detail: 'Could not start the Artha-managed Ollama.' };
  }
  if (!(await waitUp(20_000))) return { ok: false, reason: 'start_failed', detail: 'The Artha-managed Ollama did not start in time.' };
  const v = await getServerVersion(OLLAMA_HOST);
  if (v !== managed.version) {
    return { ok: false, reason: 'version_mismatch', detail: `Expected Ollama ${managed.version} to answer but got ${v ?? 'nothing'}.` };
  }
  return { ok: true, version: v };
}

/** Everything the Models UI needs to explain the engine state honestly. */
export interface RuntimeReport {
  serverReachable: boolean;
  serverVersion: string | null;
  /** True when the running server was started by Artha from its managed copy. */
  serverIsManaged: boolean;
  /** True when a server is up that Artha did not start (menubar app, brew, systemd). */
  externalServerRunning: boolean;
  managed: { version: string } | null;
  pinned: { version: string; source: 'remote' | 'bundled' };
  /** The pinned version is newer than what is answering (or than the managed copy when nothing answers). */
  updateAvailable: boolean;
  platformSupported: boolean;
  consentGranted: boolean;
}

export async function getRuntimeReport(): Promise<RuntimeReport> {
  const [up, pinned] = await Promise.all([isUp(), resolvePinnedVersion()]);
  const serverVersion = up ? await getServerVersion(OLLAMA_HOST) : null;
  const managed = getManagedRuntime();
  const serverIsManaged = up && startedByArtha && serverOrigin === 'managed';
  const baseline = serverVersion ?? managed?.version ?? null;
  const supported = ['darwin', 'win32', 'linux'].includes(process.platform)
    && ['arm64', 'x64'].includes(process.arch);
  return {
    serverReachable: up,
    serverVersion,
    serverIsManaged,
    externalServerRunning: up && !startedByArtha,
    managed: managed ? { version: managed.version } : null,
    pinned,
    updateAvailable: baseline === null || compareVersions(baseline, pinned.version) < 0,
    platformSupported: supported,
    consentGranted: managedConsentGranted(),
  };
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
 *
 * RETURNS this run's own terminal status. Callers must use the return value
 * rather than `getModelStatus()`: launch-time and user-triggered runs can
 * overlap, and the module-level `lastStatus` reflects whichever run wrote
 * last. Reading the shared value made onboarding show "Starting your local
 * model…" for a runtime that had already failed (validation row 10).
 */
export async function ensureModelReady(emit: (s: ModelStatus) => void): Promise<ModelStatus> {
  const set = (s: ModelStatus): ModelStatus => {
    lastStatus = s;
    try { emit(s); } catch { /* ignore */ }
    return s;
  };
  const m = activeModel();
  set({ phase: 'checking', model: m?.name });

  // Cloud/BYOK active model: nothing local to start or warm — the provider is
  // remote and ready by definition. No server auto-start, no warm-up, no
  // install nag. The ONLY localhost traffic allowed on this path is a single
  // read-only reachability probe: if the user ALSO has Ollama running, local
  // embeddings (memory ranking / RAG) still work, so provision the embed
  // model; if Ollama is absent, do nothing and stay quiet.
  if (m && !m.ollamaManaged) {
    const st = set({ phase: 'ready', model: m.name });
    if (await isUp()) void ensureEmbedModel();
    return st;
  }

  // Durable consent path: the user told Artha to manage Ollama, but something
  // else (typically the login-item menubar app) is answering on :11434 with an
  // OLDER version than Artha's managed copy. Replace it — the consent copy said
  // exactly this would happen. Failure is non-fatal: we carry on with whatever
  // is running and the Models panel shows the honest state.
  if (await isUp()) {
    const managed = getManagedRuntime();
    if (managed && !startedByArtha && managedConsentGranted()) {
      const v = await getServerVersion(OLLAMA_HOST);
      if (v && compareVersions(v, managed.version) < 0) {
        set({ phase: 'starting', model: m?.name, detail: `Switching to Ollama ${managed.version}…` });
        const sw = await switchToManagedRuntime({ allowStopExternal: true });
        if (!sw.ok) console.warn(`[Artha] managed-runtime switch skipped: ${sw.detail}`);
      }
    }
  }

  if (!(await isUp())) {
    // "Install Ollama" is only the right message when a LOCAL model is (or is
    // about to be) the active one. With nothing configured at all, the honest
    // state is 'no_model' — the user should choose a setup path (local model
    // OR their own API key), not be steered to Ollama by default. The
    // ollamaInstalled flag rides along so the local onboarding path can still
    // render its install card (B1).
    if (!ollamaInstalled()) return set({ phase: m ? 'not_installed' : 'no_model', ollamaInstalled: false });
    set({ phase: 'starting', model: m?.name });
    if (!(await startServer())) return set({ phase: m ? 'not_installed' : 'no_model', ollamaInstalled: false });
    // Cold daemon start is usually a couple seconds; poll up to 20s.
    if (!(await waitUp(20_000))) return set({ phase: 'error', detail: 'Ollama did not start in time.' });
  }

  // Server up but nothing active: report the truthful empty state (the old
  // 'ready' here let a fresh install look configured when it wasn't). The
  // server is left running for onboarding's model list/pull flows.
  if (!m) return set({ phase: 'no_model', ollamaInstalled: true });
  set({ phase: 'warming', model: m.name });
  // A failed load (model deleted while its row stayed active, or a squatter
  // answering /api/tags) must NOT be reported as ready — the first message
  // would fail with a raw provider error instead of an actionable state.
  if (!(await warm(m.name, m.numCtx))) {
    return set({
      phase: 'error',
      model: m.name,
      detail: `${m.name} could not be loaded. It may have been removed — pick another model in Settings → Models.`,
    });
  }
  const ready = set({ phase: 'ready', model: m.name });

  // The window is usable now — provision the embedding model in the
  // background. Without it, semantic memory ranking and RAG indexing silently
  // degrade to keyword matching and nothing ever tells the user.
  void ensureEmbedModel();
  return ready;
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
    startedByArtha = false;
    serverOrigin = null;
  }
}
