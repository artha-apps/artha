/**
 * Main process entry point for the Artha Electron app.
 *
 * Responsibilities (in startup order):
 *   1. Open / migrate the local SQLite database.
 *   2. Create the BrowserWindow and bind the BrowserView controller.
 *   3. Register all IPC handlers (agent, LLM, MCP, docs, RAG, web, browser,
 *      scheduler, etc.) so the renderer can communicate over the preload bridge.
 *   4. Initialise the SchedulerService so cron / one-shot tasks can fire.
 *   5. Load the renderer (Vite dev-server in development, dist bundle in prod).
 *   6. Hook auto-update checks (notification-only, no silent install).
 *
 * The single-instance lock at the bottom ensures only one Artha window can run
 * at a time; a second launch attempt brings the existing window to focus.
 */
import { app, BrowserWindow, shell, dialog } from 'electron';
import { autoUpdater } from 'electron-updater';
import * as path from 'path';
import { registerIpcHandlers } from './ipc/handlers';
import { initDatabase, runMigrations, getDb } from './db/schema';
import { BrowserController } from './browser/controller';
import { SchedulerService } from './scheduler/scheduler';
import { initSentry, withTransaction, captureException, setOllamaConnectedTag } from './sentry';
import { startHealthCheckpointing, stopHealthCheckpointing } from './db/health';
import { ensureModelReady, unloadActiveModel, stopOllamaIfStarted } from './llm/ollamaRuntime';

/** Probe whether the local Ollama runtime is reachable. Best-effort with a
 *  short timeout so a missing Ollama can't stall startup. Drives the
 *  `artha.ollama_connected` Sentry tag set on session start. */
async function probeOllamaReachable(): Promise<boolean> {
  try {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 1500);
    const res = await fetch('http://localhost:11434/api/tags', { signal: controller.signal });
    clearTimeout(t);
    return res.ok;
  } catch {
    return false;
  }
}

/** Count installed MCP servers (non-PII) for the `artha.mcp_server_count` tag. */
function countMcpServers(): number {
  try {
    const row = getDb().prepare(`SELECT COUNT(*) AS n FROM tools WHERE mcp_server_uri IS NOT NULL`).get() as { n: number };
    return row?.n ?? 0;
  } catch {
    return 0;
  }
}

const isDev = process.env.NODE_ENV === 'development';

let mainWindow: BrowserWindow | null = null;

/**
 * Initialise telemetry BEFORE Electron's `ready` event fires.
 *
 * `@sentry/electron/main` throws ("Sentry SDK should be initialized before the
 * Electron app 'ready' event is fired") if `Sentry.init` runs post-ready, so
 * this can't live in `createWindow` (which runs after `whenReady`). We open the
 * DB first — `initDatabase()` has no internal awaits, so better-sqlite3 opens
 * the connection synchronously by the time it returns — so `initSentry` can
 * read the opt-out flag in time to honour it.
 *
 * The operational tags start conservative: `ollamaConnected:false` is refreshed
 * by the real probe in `createWindow` (via `setOllamaConnectedTag`); the MCP
 * count is a synchronous DB read. The DB-failure dialog + migrations remain in
 * `createWindow` — this only needs the connection + the settings row.
 */
function initTelemetryBeforeReady(): void {
  // Open the DB synchronously. If better-sqlite3 fails to load its native
  // binding, initDatabase returns a rejected promise (no sync throw) — swallow
  // it here; createWindow re-runs initDatabase and surfaces the error dialog.
  // Either way `db` is set-or-null deterministically before initSentry runs.
  try {
    void initDatabase().catch(() => { /* reported in createWindow */ });
  } catch { /* reported in createWindow */ }
  // countMcpServers + isSentryEnabled (inside initSentry) tolerate a closed DB
  // (try/catch → 0 / disabled), so a failed DB open just leaves Sentry dormant.
  try {
    initSentry({ ollamaConnected: false, mcpServerCount: countMcpServers() });
  } catch (err) {
    console.error('[Artha] Sentry init failed:', err);
  }
}

async function createWindow(): Promise<void> {
  // Initialise local SQLite database on first launch
  try {
    await initDatabase();
  } catch (err) {
    console.error('[Artha] Database init failed:', err);
    console.error('[Artha] If you see a better-sqlite3 bindings error, run:');
    console.error('[Artha]   npx electron-rebuild -f -w better-sqlite3');
    // Surface the failure loudly. Without this, the window loads but every
    // DB-backed panel (Skills, Models, Sessions, Memory, …) silently renders
    // its empty-state, which looks like "features are missing" rather than a
    // broken database engine.
    dialog.showErrorBox(
      'Artha — database failed to start',
      'The local database engine (better-sqlite3) could not be loaded, so ' +
      'Skills, Models, chat history and other data will appear empty.\n\n' +
      'This usually means the native module needs rebuilding for the current ' +
      'Electron version. From the project directory run:\n\n' +
      '  npx electron-rebuild -f -w better-sqlite3\n\n' +
      `Details: ${err instanceof Error ? err.message : String(err)}`
    );
    // Continue loading the window anyway so the UI is visible.
  }

  // ── Operational resilience ───────────────────────────────────────────────
  // Sentry was already initialised before the 'ready' event (see
  // initTelemetryBeforeReady — @sentry/electron requires pre-ready init). Now
  // that we can probe, refresh the ollama-reachability tag (seeded false at
  // init). Then apply additive migrations inside a Sentry performance
  // transaction (so a slow/failed migration is tracked, not just thrown), and
  // start the 30-minute DB health heartbeat.
  try {
    setOllamaConnectedTag(await probeOllamaReachable());
  } catch (err) {
    console.error('[Artha] Ollama probe failed:', err);
  }
  // Migrations MUST run regardless of Sentry state. withTransaction is a no-op
  // span when Sentry is disabled, so this just runs runMigrations() directly.
  try {
    await withTransaction('db.migrations', 'db.migrate', () => runMigrations());
  } catch (err) {
    console.error('[Artha] Database migrations failed:', err);
    captureException(err);
  }
  startHealthCheckpointing();

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    titleBarStyle: 'hiddenInset',
    // Match the light UI background (artha-bg) so launch doesn't flash a dark
    // panel before React paints. Was leftover from the old dark theme.
    backgroundColor: '#F7F8FA',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
    show: true,
  });

  // The BrowserController owns the agent's BrowserView; bind it to the main
  // window before any IPC handler that might reach for it.
  BrowserController.getInstance().bindWindow(mainWindow);

  // Register all IPC handlers (agent, LLM, MCP, docs, RAG, web, browser, scheduler)
  registerIpcHandlers(mainWindow);

  // Initialise the scheduler after IPC handlers are ready (orchestrator is live).
  // The runner creates a fresh session per task so scheduled runs are isolated.
  SchedulerService.getInstance().init(async (prompt: string) => {
    const { getDb } = await import('./db/schema');
    const db = getDb();
    const sessionId = crypto.randomUUID();
    db.prepare(`INSERT INTO chat_sessions (session_id, title) VALUES (?, ?)`).run(sessionId, `Scheduled: ${prompt.slice(0, 40)}`);
    // Dynamically import to avoid circular deps — orchestrator is already constructed by registerIpcHandlers.
    const { AgentOrchestrator } = await import('./agent/orchestrator');
    const orch = new AgentOrchestrator(mainWindow!);
    await orch.handleMessage(sessionId, prompt);
  }).catch(err => console.error('[Artha] Scheduler init failed:', err));

  // Load renderer
  if (isDev) {
    await mainWindow.loadURL('http://localhost:5173');
  } else {
    await mainWindow.loadFile(
      path.join(__dirname, '../../renderer/dist/index.html')
    );
  }

  mainWindow.once('ready-to-show', () => mainWindow?.show());

  // Turn the local model "on" ourselves: start Ollama if it isn't running and
  // pre-warm the active model so the user's first message is fast (no cold
  // load). Non-blocking — the window is already up; progress streams to the
  // renderer's startup banner via `model:status`.
  ensureModelReady((status) => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.webContents.send('model:status', status);
    if (status.phase === 'ready') setOllamaConnectedTag(true);
  }).catch(err => console.error('[Artha] ensureModelReady failed:', err));

  // Recover from renderer process crashes (e.g. memory pressure from a large
  // local model mid-task) — without this the window just goes black with no
  // recourse. Auto-reload a few times, then stop to avoid a crash loop.
  let rendererCrashes = 0;
  mainWindow.webContents.on('render-process-gone', (_e, details) => {
    console.error('[Artha] Renderer process gone:', details.reason, 'exit', details.exitCode);
    if (details.reason === 'clean-exit') return;
    // Report the crash (reason + exit code only — no PII) so a bad release that
    // silently kills the renderer surfaces in incident monitoring.
    captureException(new Error(`Renderer process gone: ${details.reason} (exit ${details.exitCode})`));
    rendererCrashes++;
    if (rendererCrashes <= 3 && mainWindow && !mainWindow.isDestroyed()) {
      try { mainWindow.reload(); } catch { /* window gone */ }
    }
  });
  mainWindow.webContents.on('unresponsive', () => {
    console.error('[Artha] Renderer became unresponsive');
  });
  mainWindow.webContents.on('did-fail-load', (_e, code, desc) => {
    console.error('[Artha] Renderer failed to load:', code, desc);
  });

  // Open external links in default browser, not Electron
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  // Check for updates from GitHub Releases (production only).
  // Notification-only in v0.1 — user is prompted to download; no silent install.
  if (!isDev) {
    autoUpdater.autoDownload = false;
    autoUpdater.on('error', (err) => {
      console.error('[Artha] Auto-update check failed:', err);
    });
    autoUpdater.on('update-available', (info) => {
      console.log(`[Artha] Update available: ${info.version} (current ${app.getVersion()})`);
      // Tell the renderer so it can show an in-app "update available" banner.
      // This fires async at startup, so the webContents may not be ready/alive —
      // guard both the window and webContents (and try/catch the race) or it
      // throws "Object has been destroyed" in the main process.
      const wc = mainWindow?.webContents;
      if (mainWindow && !mainWindow.isDestroyed() && wc && !wc.isDestroyed()) {
        try { wc.send('update:available', { version: info.version }); } catch { /* ignore */ }
      }
    });
    autoUpdater.on('update-not-available', () => {
      console.log(`[Artha] Up to date (${app.getVersion()})`);
    });
    autoUpdater.checkForUpdatesAndNotify().catch((err) => {
      console.error('[Artha] checkForUpdatesAndNotify rejected:', err);
    });
  }
}

// ── Single-instance lock ───────────────────────────────────────────────────
// Prevents a second Artha window from opening if the app is already running.
// If a second launch is attempted, focus the existing window instead.
const gotSingleInstanceLock = app.requestSingleInstanceLock();

if (!gotSingleInstanceLock) {
  // Another instance is already running — quit immediately
  app.quit();
} else {
  app.on('second-instance', () => {
    // User tried to open a second instance — bring the existing window forward
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  // Init Sentry BEFORE 'ready' fires (@sentry/electron requirement); createWindow
  // runs after whenReady and is too late. See initTelemetryBeforeReady.
  initTelemetryBeforeReady();
  app.whenReady().then(createWindow);

  app.on('window-all-closed', () => {
    SchedulerService.getInstance().shutdown();
    stopHealthCheckpointing();
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });

  // On quit: free the resident model (the real RAM cost) so nothing heavy
  // lingers after Artha closes. The Ollama *server* stays up for instant
  // restarts UNLESS the user enabled "fully stop on quit" (and only if WE
  // started it — we never stop a server the user was already running).
  // preventDefault + app.exit lets the best-effort unload finish first.
  let quitting = false;
  app.on('before-quit', (e) => {
    if (quitting) return;
    e.preventDefault();
    quitting = true;
    void (async () => {
      try {
        await unloadActiveModel();
        let stopOnQuit = false;
        try {
          const row = getDb()
            .prepare(`SELECT settings_json FROM users WHERE user_id='default'`)
            .get() as { settings_json: string } | undefined;
          stopOnQuit = JSON.parse(row?.settings_json ?? '{}').ollama_stop_on_quit === true;
        } catch { /* default off */ }
        if (stopOnQuit) await stopOllamaIfStarted();
      } catch { /* best-effort */ }
      app.exit(0);
    })();
  });
}
