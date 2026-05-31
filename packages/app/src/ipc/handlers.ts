/**
 * IPC Handlers — wires all Electron `ipcMain.handle` channels to backend
 * modules. The renderer reaches every handler via the preload bridge
 * (`window.artha.*`). A single exported function, `registerIpcHandlers`,
 * is called once from `main.ts` after the BrowserWindow is created.
 *
 * Handler groups (search for the section banners below):
 *   Agent          — send messages, cancel, plan approval, clarification
 *   Sessions       — list, create, delete, load history
 *   Scopes         — per-chat folder/file sandbox + RAG index management
 *   LLM / Models   — Ollama + BYOK cloud model management
 *   MCP            — install / toggle / remove MCP servers, audit log
 *   Skills         — CRUD for agent playbooks
 *   RAG            — index management (separate from scope-auto-indexes)
 *   Document Gen   — generate and open docx/pptx/xlsx/pdf artifacts
 *   Settings       — read/write the user settings blob
 *   Bundles        — export / import `.artha-bundle` run archives
 *   Router         — adaptive model selection benchmark + overrides
 *   Provenance     — per-anchor source records and signed receipts
 *   Time-travel    — replay / fork any past ReAct step
 *   Web tools      — cache stats and clear
 *   Browser        — BrowserView attach/detach/navigate/handoff
 *   Scheduler      — CRUD for scheduled tasks
 *   Artifacts      — log and browse agent-generated files
 *   Memory         — long-term agent memory CRUD
 *   OAuth          — Google Workspace PKCE token flow
 *   IDE            — generate VS Code / Cursor MCP config files
 *   LAN            — local-network collaboration server lifecycle
 *   Parallel       — fan-out sub-agent runs
 *   Desktop        — screen capture for desktop-control tools
 *   Team           — local team member roster
 *   API keys       — LAN server Bearer token management
 *   Shared memory  — toggle cross-teammate memory injection
 */
import { ipcMain, BrowserWindow, dialog, shell, desktopCapturer } from 'electron';
import * as path from 'path';
import * as http from 'http';
import * as os from 'os';
import { app } from 'electron';
import { AgentOrchestrator } from '../agent/orchestrator';
import { MCPRegistry } from '../mcp/registry';
import { SkillRegistry, type SkillInput } from '../skills/registry';
import { parseSkillImport } from '../skills/util';
import { getDefaultRagIndexer } from '../rag/indexer';
import { buildShallowTree } from '../agent/folderTree';
import { generateDocument } from '../docs/generator';
import { exportBundle, importBundle } from '../bundles/bundle';
import { runBenchmark, listProfiles, setOverride, listOverrides } from '../router/benchmark';
import { getDb } from '../db/schema';
import { recomputePrimaryProject } from '../db/scopes';
import { Entitlements, FREE_ENTITLEMENTS } from '../license/entitlements';
import { getEntitlements, invalidateEntitlements, parseAndVerify } from '../license/verify';
import { DEFAULT_WEB_CONFIG, clearWebCache, type WebConfig } from '../tools/web';
import { BrowserController } from '../browser/controller';
import { setBrowserToolEmitter } from '../tools/browser';
import { SchedulerService, type TaskInput } from '../scheduler/scheduler';

// Module-level orchestrator — created once in `registerIpcHandlers` so every
// IPC channel shares the same ReAct loop and in-flight workflow map.
let orchestrator: AgentOrchestrator;
// Singleton RAG indexer shared by the standalone RAG panel and the scope
// auto-indexer so they write to the same chunk store.
const ragIndexer = getDefaultRagIndexer();

// ── IDE MCP HTTP server ─────────────────────────────────────────────────────
// The IDE Integration panel writes editor configs pointing at
// http://localhost:3847/mcp. This is the server those configs talk to: a tiny
// HTTP bridge that dispatches { tool, args } POSTs to the MCP registry so an
// external editor (VS Code / Cursor agent) can call Artha's tools. Bound to
// loopback only — it's a local bridge, never exposed to the network.
const IDE_MCP_PORT = 3847;
let ideMcpServer: http.Server | null = null;

/**
 * Start the IDE MCP HTTP bridge. Idempotent — returns the current status
 * immediately if the server is already listening.
 */
function startIdeMcpServer(): { running: boolean; url: string } {
  const url = `http://localhost:${IDE_MCP_PORT}/mcp`;
  // Already running → no-op (idempotent, safe to call repeatedly).
  if (ideMcpServer) return { running: true, url };

  const server = http.createServer((req, res) => {
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };

    if (req.method === 'GET' && req.url === '/health') {
      json(200, { status: 'ok' });
      return;
    }

    if (req.method === 'POST' && req.url === '/mcp') {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', async () => {
        try {
          const { tool, args } = JSON.parse(body || '{}') as {
            tool?: string; args?: Record<string, unknown>;
          };
          if (!tool) {
            json(400, { error: 'Request body must include a "tool" field.' });
            return;
          }
          const result = await MCPRegistry.getInstance().invokeTool(tool, args ?? {});
          json(200, { result });
        } catch (err) {
          json(500, { error: err instanceof Error ? err.message : String(err) });
        }
      });
      return;
    }

    json(404, { error: 'Not found' });
  });

  server.on('error', (err) => {
    console.error('[Artha] IDE MCP server error:', err);
    ideMcpServer = null;
  });
  server.listen(IDE_MCP_PORT, '127.0.0.1', () => {
    console.log(`[Artha] IDE MCP server listening on ${url}`);
  });
  ideMcpServer = server;
  return { running: true, url };
}

/** Stop the IDE MCP HTTP bridge. Safe to call when already stopped. */
function stopIdeMcpServer(): { running: boolean } {
  if (ideMcpServer) {
    ideMcpServer.close();
    ideMcpServer = null;
  }
  return { running: false };
}

// ── Licensing helpers ──────────────────────────────────────────────────────
// The raw license key lives on settings_json.license_key. These two helpers
// give every module-level function (LAN server, autostart) read access without
// pulling the inline closures from registerIpcHandlers. Cached entitlements
// in ../license/verify keep this hot path effectively free.
function getRawLicenseKey(): string | null {
  try {
    const row = getDb().prepare(`SELECT settings_json FROM users WHERE user_id='default'`).get() as { settings_json: string } | undefined;
    const k = (JSON.parse(row?.settings_json ?? '{}') as { license_key?: string }).license_key;
    return typeof k === 'string' && k ? k : null;
  } catch { return null; }
}

function currentEntitlements(): Entitlements {
  return getEntitlements(getRawLicenseKey);
}

// ── LAN API-key auth helper ─────────────────────────────────────────────────
// The LAN server requires a Bearer token on every request when at least one
// API key has been registered. We hash incoming tokens with SHA-256 and
// compare against the stored key_hash — the plaintext key is never persisted.
function hashApiKey(key: string): string {
  const { createHash } = require('crypto') as typeof import('crypto');
  return createHash('sha256').update(key).digest('hex');
}

/** Caller identity resolved from a Bearer token. memberId is null for keys
 *  issued before team-mode (no team_members linkage); role defaults to 'admin'
 *  on the no-keys-registered open-access path so future admin-only routes
 *  remain reachable on a fresh box. */
export type LanIdentity = { memberId: string | null; memberName: string | null; role: 'admin' | 'member' };

function authoriseLanRequest(req: http.IncomingMessage): LanIdentity | null {
  try {
    const db = getDb();
    const keys = db.prepare(
      `SELECT key_hash, member_id, role FROM api_keys WHERE is_enabled=1`,
    ).all() as { key_hash: string; member_id: string | null; role: string | null }[];
    // No keys registered → open access (owner hasn't locked down yet). Phase 2
    // SSO will tighten this; for now it preserves the existing dev-friendly
    // behaviour where you can curl /chat immediately after starting the server.
    if (keys.length === 0) return { memberId: null, memberName: null, role: 'admin' };
    const auth = (req.headers['authorization'] ?? '') as string;
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    if (!token) return null;
    const hash = hashApiKey(token);
    const matched = keys.find(k => k.key_hash === hash);
    if (!matched) return null;
    // Best-effort last-used timestamp update.
    try { db.prepare(`UPDATE api_keys SET last_used_at=unixepoch() WHERE key_hash=?`).run(hash); } catch { /* ignore */ }
    let memberName: string | null = null;
    if (matched.member_id) {
      const m = db.prepare(`SELECT display_name FROM team_members WHERE member_id=?`).get(matched.member_id) as { display_name: string } | undefined;
      memberName = m?.display_name ?? null;
    }
    const role: 'admin' | 'member' = matched.role === 'admin' ? 'admin' : 'member';
    return { memberId: matched.member_id, memberName, role };
  } catch {
    return null; // fail closed
  }
}

// ── LAN collaboration server ────────────────────────────────────────────────
// Exposes Artha's skills + agent over the local network (0.0.0.0:7842) so
// teammates can hit it from a browser/curl. Distinct from the IDE bridge
// (loopback :3847). The orchestrator streams its reply to the desktop UI; for
// this headless bridge we forward the persisted agent reply as NDJSON.
const LAN_PORT = 7842;
let lanServer: http.Server | null = null;
let lanLocalIp: string | null = null;

/**
 * Return the first non-internal IPv4 address (the machine's LAN IP).
 * Returns null when no external interface is found (e.g. VMs with no adapters).
 */
function detectLocalIp(): string | null {
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const ni of ifaces[name] ?? []) {
      if (ni.family === 'IPv4' && !ni.internal) return ni.address;
    }
  }
  return null;
}

/** Snapshot of the LAN server's current state — used by all lan:* IPC handlers. */
function lanStatus(): { running: boolean; url: string | null; localIp: string | null } {
  const running = !!lanServer;
  return {
    running,
    localIp: lanLocalIp,
    url: running && lanLocalIp ? `http://${lanLocalIp}:${LAN_PORT}` : null,
  };
}

/**
 * Bind the LAN collaboration server on 0.0.0.0:7842. Idempotent — returns
 * the current status without restarting if already listening.
 *
 * Route summary:
 *   GET  /health — always public; used by monitoring / uptime tools
 *   GET  /       — server manifest (name, version, skill slugs)
 *   GET  /skills — full list of enabled skill objects
 *   POST /chat   — forward a message to the orchestrator; streams NDJSON reply
 */
function startLanServer(): { running: boolean; url: string | null; localIp: string | null; error?: string } {
  if (lanServer) return lanStatus();
  // Gate: Free tier may NOT bind the LAN port. This is the central Free→Pro
  // monetisation wall; the persona-onboarding flow paints a clear upgrade CTA
  // when this error string surfaces in the UI.
  const ents = currentEntitlements();
  if (!ents.lanServer) {
    return {
      running: false,
      url: null,
      localIp: null,
      error: 'The LAN/team server requires a Pro or Enterprise license. Apply a license in Settings → License.',
    };
  }
  lanLocalIp = detectLocalIp();

  const server = http.createServer((req, res) => {
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    const url = new URL(req.url ?? '/', `http://localhost:${LAN_PORT}`);

    // /health is always public so monitoring tools don't need a key
    if (req.method === 'GET' && url.pathname === '/health') {
      json(200, { status: 'ok', uptime: process.uptime(), auth_required: (() => {
        try { return (getDb().prepare(`SELECT COUNT(*) AS n FROM api_keys WHERE is_enabled=1`).get() as { n: number }).n > 0; } catch { return false; }
      })() });
      return;
    }

    // All other routes require a valid Bearer token if any keys exist. The
    // resolved identity is captured for future per-member context; admin-only
    // routes (none yet in Phase 1) will require `role === 'admin'` when
    // currentEntitlements().rbac is true.
    const identity = authoriseLanRequest(req);
    if (!identity) {
      json(401, { error: 'Unauthorized. Include a valid Bearer token in the Authorization header.' });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/') {
      const skills = SkillRegistry.getInstance().listEnabled() as { slug: string }[];
      json(200, { name: 'Artha', version: '0.1.1', status: 'online', skills: skills.map(s => s.slug) });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/skills') {
      json(200, SkillRegistry.getInstance().listEnabled());
      return;
    }

    if (req.method === 'POST' && url.pathname === '/chat') {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', async () => {
        const db = getDb();
        let sid: string;
        try {
          const parsed = JSON.parse(body || '{}') as { message?: string; sessionId?: string };
          if (!parsed.message) { json(400, { error: 'Request body must include a "message" field.' }); return; }
          sid = parsed.sessionId ?? '';
          if (!sid) {
            sid = crypto.randomUUID();
            db.prepare(`INSERT INTO chat_sessions (session_id, title) VALUES (?, ?)`).run(sid, `LAN: ${parsed.message.slice(0, 40)}`);
          }

          res.writeHead(200, { 'Content-Type': 'application/x-ndjson', 'Transfer-Encoding': 'chunked' });
          // Snapshot the max rowid before the run so we can retrieve only the
          // new agent messages afterwards (the orchestrator streams to the
          // desktop UI but writes final messages to the DB synchronously).
          const before = (db.prepare(`SELECT COALESCE(MAX(rowid), 0) AS m FROM messages WHERE session_id=?`).get(sid) as { m: number }).m;

          await orchestrator.handleMessage(sid, parsed.message, []);

          // Replay all agent replies written during this run as NDJSON lines.
          const rows = db.prepare(
            `SELECT content FROM messages WHERE session_id=? AND sender_type='agent' AND rowid > ? ORDER BY rowid ASC`
          ).all(sid, before) as { content: string }[];
          for (const r of rows) res.write(JSON.stringify({ type: 'token', content: r.content }) + '\n');
          res.write(JSON.stringify({ type: 'done', content: '' }) + '\n');
          res.end();
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (!res.headersSent) res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
          res.write(JSON.stringify({ type: 'error', content: msg }) + '\n');
          res.end();
        }
      });
      return;
    }

    json(404, { error: 'Not found' });
  });

  server.on('error', (err) => {
    console.error('[Artha] LAN server error:', err);
    lanServer = null;
  });
  server.listen(LAN_PORT, '0.0.0.0', () => {
    console.log(`[Artha] LAN server listening on http://${lanLocalIp ?? '0.0.0.0'}:${LAN_PORT}`);
  });
  lanServer = server;
  return lanStatus();
}

/** Close the LAN server gracefully. Returns the updated status. */
function stopLanServer(): { running: boolean; url: string | null; localIp: string | null } {
  if (lanServer) {
    lanServer.close();
    lanServer = null;
  }
  return lanStatus();
}

/**
 * Register every `ipcMain.handle` channel and perform one-time startup work:
 *   - Instantiate the AgentOrchestrator bound to `window`.
 *   - Load enabled MCP servers from the DB.
 *   - Start the IDE MCP HTTP bridge.
 *   - Auto-start the LAN server if the user opted in.
 *   - Back-fill legacy "New Chat" session titles.
 *
 * Must be called exactly once, after the BrowserWindow is created.
 */
export function registerIpcHandlers(window: BrowserWindow): void {
  orchestrator = new AgentOrchestrator(window);

  // Safe push to the renderer. Guards window AND webContents (a reload destroys
  // webContents while the window lives) and swallows the destroy-mid-send race,
  // so a closing/reloading window can't crash main with "Object has been destroyed".
  const safeSend = (channel: string, payload?: unknown): void => {
    if (window.isDestroyed()) return;
    const wc = window.webContents;
    if (!wc || wc.isDestroyed()) return;
    try { wc.send(channel, payload); } catch { /* torn down mid-send */ }
  };

  // Load all enabled MCP servers at startup
  MCPRegistry.getInstance().loadFromDatabase().catch(console.error);

  // Start the IDE MCP HTTP bridge so editor configs (.vscode/.cursor mcp.json
  // pointing at localhost:3847/mcp) have a live server to reach immediately.
  startIdeMcpServer();

  // Auto-start the LAN collaboration server if the user opted in AND their
  // license unlocks it. A Free user who flipped autostart on then downgraded
  // will silently no-op here instead of crashing or binding the port.
  try {
    if (currentEntitlements().lanServer) {
      const row = getDb().prepare(`SELECT settings_json FROM users WHERE user_id='default'`).get() as { settings_json: string } | undefined;
      if (JSON.parse(row?.settings_json ?? '{}').lan_autostart) startLanServer();
    }
  } catch (err) {
    console.warn('[Artha] LAN autostart check failed:', err);
  }

  // One-time migration: older sessions were stored as "New Chat" with no
  // auto-title; back-fill their title from the first user message so the
  // sidebar isn't a wall of identical entries.
  try {
    const db = getDb();
    const untitled = db.prepare(
      `SELECT session_id FROM chat_sessions WHERE title='New Chat'`
    ).all() as { session_id: string }[];
    for (const { session_id } of untitled) {
      const first = db.prepare(
        `SELECT content FROM messages WHERE session_id=? AND sender_type='user' ORDER BY timestamp ASC LIMIT 1`
      ).get(session_id) as { content: string } | undefined;
      if (first?.content) {
        const title = first.content.trim().slice(0, 40).replace(/\n/g, ' ')
          + (first.content.length > 40 ? '…' : '');
        db.prepare(`UPDATE chat_sessions SET title=? WHERE session_id=?`).run(title, session_id);
      }
    }
  } catch (err) {
    console.warn('[Artha] Session retitle migration failed:', err);
  }

  // ── Agent ──────────────────────────────────────────────────────────────
  // Persist the user message synchronously, then hand off to the orchestrator.
  // Side-effect: the *first* message of a session also sets the session title
  // (truncated to 40 chars) and pushes a `session:titleUpdated` event so the
  // sidebar updates without a full reload.
  ipcMain.handle('agent:sendMessage', async (_e, sessionId: string, content: string, attachments?: { name: string; mime: string; data: string }[]) => {
    const db = getDb();
    db.prepare(`INSERT INTO messages (session_id, sender_type, content) VALUES (?, 'user', ?)`).run(sessionId, content);

    // Auto-title session from first user message (if still "New Chat")
    const session = db.prepare(`SELECT title FROM chat_sessions WHERE session_id=?`).get(sessionId) as { title: string } | undefined;
    if (session?.title === 'New Chat') {
      const title = content.trim().slice(0, 40).replace(/\n/g, ' ') + (content.length > 40 ? '…' : '');
      db.prepare(`UPDATE chat_sessions SET title=?, last_activity=unixepoch() WHERE session_id=?`).run(title, sessionId);
      safeSend('session:titleUpdated', { sessionId, title });
    } else {
      db.prepare(`UPDATE chat_sessions SET last_activity=unixepoch() WHERE session_id=?`).run(sessionId);
    }

    await orchestrator.handleMessage(sessionId, content, attachments);
  });

  ipcMain.handle('dialog:pickImage', async () => {
    const result = await dialog.showOpenDialog(window, {
      title: 'Attach image',
      properties: ['openFile'],
      filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp'] }],
    });
    if (result.canceled || !result.filePaths[0]) return null;
    const fs = await import('fs');
    const filePath = result.filePaths[0];
    const ext = filePath.split('.').pop()?.toLowerCase() ?? 'png';
    const mimeMap: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };
    const mime = mimeMap[ext] ?? 'image/png';
    const data = fs.readFileSync(filePath).toString('base64');
    const name = filePath.split('/').pop() ?? 'image';
    return { name, mime, data, path: filePath };
  });

  // PDF → image pages using `pdftoppm` (Poppler). Renders each page at 150 DPI
  // as a PNG, returns them as base64 image attachments ready for the vision
  // pipeline. Caps at 20 pages to avoid flooding the context window.
  ipcMain.handle('dialog:pickPdf', async () => {
    const result = await dialog.showOpenDialog(window, {
      title: 'Attach PDF',
      properties: ['openFile'],
      filters: [{ name: 'PDF', extensions: ['pdf'] }],
    });
    if (result.canceled || !result.filePaths[0]) return null;
    const fs = await import('fs');
    const os = await import('os');
    const { execFile } = await import('child_process');
    const { promisify } = await import('util');
    const execFileAsync = promisify(execFile);

    const pdfPath = result.filePaths[0];
    const pdfName = pdfPath.split('/').pop()?.replace(/\.pdf$/i, '') ?? 'document';
    const tmpDir = fs.mkdtempSync(`${os.tmpdir()}/artha-pdf-`);
    const outPrefix = `${tmpDir}/page`;

    try {
      // -r 150: 150 DPI  -png: PNG output  -l 20: max 20 pages
      await execFileAsync('pdftoppm', ['-r', '150', '-png', '-l', '20', pdfPath, outPrefix]);
    } catch (err) {
      console.warn('[Artha] pdftoppm failed:', err);
      return null;
    }

    const pages = fs.readdirSync(tmpDir)
      .filter(f => f.endsWith('.png'))
      .sort()
      .map(f => {
        const data = fs.readFileSync(`${tmpDir}/${f}`).toString('base64');
        const pageNum = f.match(/(\d+)\.png$/)?.[1] ?? '?';
        return { name: `${pdfName}-page${pageNum}.png`, mime: 'image/png', data };
      });

    // Cleanup temp files
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }

    return pages.length > 0 ? { pdfName, pages } : null;
  });

  // PDF reading depends on Poppler's `pdftoppm`. The renderer calls this before
  // opening the PDF picker so it can surface an install hint instead of silently
  // failing when Poppler is missing.
  ipcMain.handle('system:checkPoppler', async () => {
    try {
      const { execFile } = await import('child_process');
      const { promisify } = await import('util');
      const execFileAsync = promisify(execFile);
      const { stdout } = await execFileAsync('which', ['pdftoppm']);
      const found = stdout.trim();
      return found ? { installed: true, path: found } : { installed: false };
    } catch {
      return { installed: false };
    }
  });

  // Update the DB *before* signalling the orchestrator so that even if the
  // ReAct loop hasn't yet observed the cancel flag, the persisted state is
  // already correct for any UI re-render.
  ipcMain.handle('agent:cancelTask', async (_e, workflowId: string) => {
    const db = getDb();
    db.prepare(`UPDATE agent_states SET status='cancelled' WHERE workflow_id=?`).run(workflowId);
    orchestrator.cancelWorkflow(workflowId);
    // Stop button must also release any awaited browser handoff or the
    // orchestrator's tool-await would block forever.
    BrowserController.getInstance().cancelHandoff();
  });

  ipcMain.handle('agent:approvePlan', async (_e, workflowId: string, approved: boolean) => {
    await orchestrator.approvePlan(workflowId, approved);
  });

  ipcMain.handle('agent:clarifyRespond', (_e, workflowId: string, answers: string[] | null) => {
    orchestrator.clarifyRespond(workflowId, answers);
  });

  // ── Projects ───────────────────────────────────────────────────────────
  // Projects are user-visible containers around a folder: a root path + an
  // auto-built RAG index + a rolling cross-session memory summary. The data
  // model has existed since v3→v6 migrations; these handlers surface it to
  // the renderer for the project switcher, list, and `@project` references.

  /** List every project, newest first. Drives the switcher dropdown and the
   *  sidebar Projects section. */
  ipcMain.handle('projects:list', () => {
    return getDb().prepare(
      `SELECT project_id, name, root_path, rag_index_id, summary, created_at
       FROM projects ORDER BY created_at DESC`
    ).all();
  });

  /** Single project lookup — used by the project home view + `@project`
   *  resolution. Returns null if the id is unknown. */
  ipcMain.handle('projects:get', (_e, projectId: string) => {
    return getDb().prepare(
      `SELECT project_id, name, root_path, rag_index_id, summary, created_at
       FROM projects WHERE project_id=?`
    ).get(projectId) ?? null;
  });

  /** Shallow, depth-2 directory tree for a folder. Drives the Code tab's
   *  file pane without exposing arbitrary fs access — caller must already
   *  know the path (typically the active project's root). Returns '' on
   *  empty/unreadable paths so the caller can render an empty-state. */
  ipcMain.handle('fs:tree', (_e, rootPath: string, maxEntries?: number) => {
    return buildShallowTree(rootPath, { maxEntries: maxEntries ?? 80, maxDepth: 2 });
  });

  /** Reveal a path in Finder / Explorer / nautilus. Used by the Project
   *  home page. No-op on invalid paths. */
  ipcMain.handle('system:revealInFolder', (_e, p: string) => {
    if (!p) return;
    try { shell.showItemInFolder(p); } catch { /* ignore — path missing */ }
  });

  ipcMain.handle('system:appInfo', () => ({
    version: app.getVersion(),
    electron: process.versions.electron,
    node: process.versions.node,
    chrome: process.versions.chrome,
    platform: `${process.platform} ${process.arch}`,
  }));

  /** Sessions belonging to one project (or `null` for general/no-project).
   *  Drives the Project home page's "Recent chats" list. Same shape as
   *  `sessions:list` for a drop-in render. */
  ipcMain.handle('sessions:listByProject', (_e, projectId: string | null) => {
    const db = getDb();
    if (projectId === null || projectId === undefined) {
      return db.prepare(`SELECT * FROM chat_sessions WHERE project_id IS NULL ORDER BY last_activity DESC`).all();
    }
    return db.prepare(`SELECT * FROM chat_sessions WHERE project_id=? ORDER BY last_activity DESC`).all(projectId);
  });

  /** Create a project from a folder pick. Delegates to the same
   *  `findOrCreateFolderWorkspace()` used when a chat attaches a folder, so
   *  one project per folder is preserved and a RAG index is auto-built. */
  ipcMain.handle('projects:create', async () => {
    const win = BrowserWindow.getFocusedWindow();
    if (!win) return null;
    const res = await dialog.showOpenDialog(win, {
      title: 'Pick a folder for the new project',
      properties: ['openDirectory'],
    });
    if (res.canceled || !res.filePaths.length) return null;
    const rootPath = res.filePaths[0];
    const { projectId } = findOrCreateFolderWorkspace(rootPath);
    return getDb().prepare(
      `SELECT project_id, name, root_path, rag_index_id, summary, created_at
       FROM projects WHERE project_id=?`
    ).get(projectId) ?? null;
  });

  // ── Sessions ───────────────────────────────────────────────────────────
  ipcMain.handle('sessions:list', () => {
    return getDb().prepare(`SELECT * FROM chat_sessions ORDER BY last_activity DESC`).all();
  });

  ipcMain.handle('sessions:create', (_e, projectId?: string | null) => {
    const db = getDb();
    const id = crypto.randomUUID();
    db.prepare(`INSERT INTO chat_sessions (session_id, project_id) VALUES (?, ?)`).run(id, projectId ?? null);
    return { session_id: id, title: 'New Chat', project_id: projectId ?? null };
  });

  ipcMain.handle('sessions:delete', (_e, id: string) => {
    getDb().prepare(`DELETE FROM chat_sessions WHERE session_id=?`).run(id);
  });

  ipcMain.handle('sessions:getMessages', (_e, sessionId: string) => {
    const rows = getDb().prepare(
      `SELECT * FROM messages WHERE session_id=? ORDER BY timestamp ASC`
    ).all(sessionId) as Record<string, unknown>[];
    return rows.map(r => {
      let citations: unknown = undefined;
      if (typeof r.citations_json === 'string' && r.citations_json) {
        try { citations = JSON.parse(r.citations_json); } catch { /* skip */ }
      }
      return {
        id: r.message_id,
        sessionId: r.session_id,
        senderType: r.sender_type,
        content: r.content,
        timestamp: r.timestamp,
        citations,
      };
    });
  });

  // ── Scopes ───────────────────────────────────────────────────────────────
  // A scope is a folder or individual file attached to ONE chat. The agent is
  // made aware of it (context injection in the orchestrator) and confined to it
  // (hard sandbox in the filesystem tools). A folder scope mirrors a row in
  // `projects` (deduped by absolute path) so it carries an auto-built RAG index
  // + cross-session memory shared across any chat that opens the same folder.

  /**
   * Find the existing `projects` row for `rootPath`, or insert one together
   * with a new `rag_indexes` row.  The RAG index is built in the background
   * so the folder picker returns immediately.
   *
   * Deduplication is by exact `root_path` — two chats that open the same
   * folder reuse the same project + index, sharing context and memory.
   */
  function findOrCreateFolderWorkspace(rootPath: string): { projectId: string; ragIndexId: string } {
    const db = getDb();
    const existing = db.prepare(`SELECT project_id, rag_index_id FROM projects WHERE root_path=? ORDER BY created_at ASC LIMIT 1`)
      .get(rootPath) as { project_id: string; rag_index_id: string | null } | undefined;
    if (existing) {
      let indexId = existing.rag_index_id;
      if (!indexId) {
        indexId = crypto.randomUUID();
        const name = path.basename(rootPath) || rootPath;
        db.prepare(`INSERT INTO rag_indexes (index_id, name, directory_path) VALUES (?,?,?)`).run(indexId, `Folder: ${name}`, rootPath);
        db.prepare(`UPDATE projects SET rag_index_id=? WHERE project_id=?`).run(indexId, existing.project_id);
        ragIndexer.buildIndex(indexId, rootPath).catch(err => console.warn('[Artha] folder index build failed:', err));
      }
      return { projectId: existing.project_id, ragIndexId: indexId };
    }
    const name = path.basename(rootPath) || rootPath;
    const projectId = crypto.randomUUID();
    const indexId = crypto.randomUUID();
    db.prepare(`INSERT INTO rag_indexes (index_id, name, directory_path) VALUES (?,?,?)`).run(indexId, `Folder: ${name}`, rootPath);
    db.prepare(`INSERT INTO projects (project_id, name, root_path, rag_index_id) VALUES (?,?,?,?)`).run(projectId, name, rootPath, indexId);
    // Build in the background — embedding a large folder is slow and we don't
    // want to block the picker returning.
    ragIndexer.buildIndex(indexId, rootPath).catch(err => console.warn('[Artha] folder index build failed:', err));
    return { projectId, ragIndexId: indexId };
  }

  ipcMain.handle('scopes:list', (_e, sessionId: string) => {
    return getDb().prepare(`SELECT * FROM session_scopes WHERE session_id=? ORDER BY added_at ASC, rowid ASC`).all(sessionId);
  });

  /** Programmatic sibling of `scopes:addFolder` — no dialog, takes an absolute
   *  path. Used to auto-attach the active project's root folder to a fresh
   *  session so chats inside a project default to that project's sandbox. */
  ipcMain.handle('scopes:addFolderPath', (_e, sessionId: string, rootPath: string) => {
    if (!sessionId || !rootPath) return null;
    const db = getDb();
    const { ragIndexId } = findOrCreateFolderWorkspace(rootPath);
    const scopeId = crypto.randomUUID();
    try {
      db.prepare(`INSERT INTO session_scopes (scope_id, session_id, path, kind, rag_index_id) VALUES (?,?,?,?,?)`)
        .run(scopeId, sessionId, rootPath, 'folder', ragIndexId);
    } catch {
      // UNIQUE(session_id, path) violation — already attached. Idempotent
      // return so the caller can treat both "added" and "already there"
      // identically.
      return db.prepare(`SELECT * FROM session_scopes WHERE session_id=? AND path=?`).get(sessionId, rootPath);
    }
    recomputePrimaryProject(sessionId);
    return db.prepare(`SELECT * FROM session_scopes WHERE scope_id=?`).get(scopeId);
  });

  ipcMain.handle('scopes:addFolder', async (_e, sessionId: string) => {
    const result = await dialog.showOpenDialog(window, {
      properties: ['openDirectory'],
      title: 'Add a folder to this chat',
    });
    if (result.canceled || !result.filePaths[0]) return null;
    const rootPath = result.filePaths[0];
    const db = getDb();
    const { ragIndexId } = findOrCreateFolderWorkspace(rootPath);
    const scopeId = crypto.randomUUID();
    try {
      db.prepare(`INSERT INTO session_scopes (scope_id, session_id, path, kind, rag_index_id) VALUES (?,?,?,?,?)`)
        .run(scopeId, sessionId, rootPath, 'folder', ragIndexId);
    } catch {
      // UNIQUE(session_id, path) — folder already attached to this chat.
      return db.prepare(`SELECT * FROM session_scopes WHERE session_id=? AND path=?`).get(sessionId, rootPath);
    }
    recomputePrimaryProject(sessionId);
    return db.prepare(`SELECT * FROM session_scopes WHERE scope_id=?`).get(scopeId);
  });

  ipcMain.handle('scopes:addFile', async (_e, sessionId: string) => {
    const result = await dialog.showOpenDialog(window, {
      properties: ['openFile', 'multiSelections'],
      title: 'Add file(s) to this chat',
    });
    if (result.canceled || !result.filePaths.length) return [];
    const db = getDb();
    const added: unknown[] = [];
    for (const filePath of result.filePaths) {
      const scopeId = crypto.randomUUID();
      try {
        db.prepare(`INSERT INTO session_scopes (scope_id, session_id, path, kind) VALUES (?,?,?,?)`)
          .run(scopeId, sessionId, filePath, 'file');
        added.push(db.prepare(`SELECT * FROM session_scopes WHERE scope_id=?`).get(scopeId));
      } catch { /* already attached — skip */ }
    }
    return added;
  });

  ipcMain.handle('scopes:remove', (_e, scopeId: string) => {
    const db = getDb();
    const row = db.prepare(`SELECT session_id FROM session_scopes WHERE scope_id=?`).get(scopeId) as { session_id: string } | undefined;
    db.prepare(`DELETE FROM session_scopes WHERE scope_id=?`).run(scopeId);
    if (row) recomputePrimaryProject(row.session_id);
    return true;
  });

  // Rebuild the RAG index for a folder scope. Returns the chunk count.
  ipcMain.handle('scopes:reindex', async (_e, scopeId: string) => {
    const db = getDb();
    const row = db.prepare(`SELECT path, kind, rag_index_id FROM session_scopes WHERE scope_id=?`)
      .get(scopeId) as { path: string; kind: string; rag_index_id: string | null } | undefined;
    if (!row || row.kind !== 'folder') return 0;
    const { ragIndexId } = findOrCreateFolderWorkspace(row.path);
    if (row.rag_index_id !== ragIndexId) db.prepare(`UPDATE session_scopes SET rag_index_id=? WHERE scope_id=?`).run(ragIndexId, scopeId);
    return ragIndexer.buildIndex(ragIndexId, row.path);
  });

  // ── LLM / Models ───────────────────────────────────────────────────────
  ipcMain.handle('llm:listModels', async () => {
    try {
      const res = await fetch('http://localhost:11434/api/tags');
      const json = await res.json() as { models: { name: string; size: number }[] };
      return json.models ?? [];
    } catch {
      return [];
    }
  });

  ipcMain.handle('llm:detectHardware', async (): Promise<{
    gbRam: number;
    recommendation: string;
    recommendedModel: string;
    gpuName: string | null;
    vramGb: number | null;
  }> => {
    try {
      const totalMem = (await import('os')).totalmem();
      const gbRam = Math.round(totalMem / 1024 / 1024 / 1024);
      const recommendation = gbRam >= 32 ? 'Q8 or F16 models' : gbRam >= 16 ? 'Q8 models (8B)' : 'Q4 models (3B-8B)';
      // A concrete starter model sized to the machine — qwen2.5 is strong at the
      // tool-calling the agent leans on; llama3.2:3b is the safe low-RAM default.
      const recommendedModel = gbRam >= 32
        ? 'qwen2.5:14b-instruct-q4_K_M'
        : gbRam >= 16
          ? 'qwen2.5:7b-instruct-q4_K_M'
          : 'llama3.2:3b-instruct-q4_K_M';

      // ── GPU detection ──────────────────────────────────────────────────────
      // Best-effort: shell out to the platform's introspection tool. Any failure
      // (tool missing, parse error, no GPU) degrades to nulls rather than
      // breaking the whole hardware probe.
      let gpuName: string | null = null;
      let vramGb: number | null = null;
      try {
        const { execFile } = await import('child_process');
        const { promisify } = await import('util');
        const execFileAsync = promisify(execFile);

        if (process.platform === 'darwin') {
          const { stdout } = await execFileAsync('system_profiler', ['SPDisplaysDataType', '-json']);
          const parsed = JSON.parse(stdout) as {
            SPDisplaysDataType?: {
              _name?: string; spdisplays_vram?: string; sppci_model?: string;
              spdisplays_ndrvs?: { _name?: string }[];
            }[];
          };
          const gpu = parsed.SPDisplaysDataType?.[0];
          if (gpu) {
            // On Apple Silicon the chip name lives on the top entry
            // (sppci_model / _name); spdisplays_ndrvs[0]._name is the fallback.
            gpuName = gpu.sppci_model ?? gpu._name ?? gpu.spdisplays_ndrvs?.[0]?._name ?? null;
            // spdisplays_vram looks like "18 GB" or "1536 MB" — normalise to GB.
            if (gpu.spdisplays_vram) {
              const m = gpu.spdisplays_vram.match(/([\d.]+)\s*(GB|MB)/i);
              if (m) {
                const val = parseFloat(m[1]);
                vramGb = m[2].toUpperCase() === 'MB' ? Math.round(val / 1024) : Math.round(val);
              }
            }
          }
        } else if (process.platform === 'win32' || process.platform === 'linux') {
          const { stdout } = await execFileAsync('nvidia-smi', [
            '--query-gpu=name,memory.total', '--format=csv,noheader,nounits',
          ]);
          const firstLine = stdout.split('\n').map(l => l.trim()).filter(Boolean)[0];
          if (firstLine) {
            const [name, memMb] = firstLine.split(',').map(s => s.trim());
            gpuName = name || null;
            const mb = Number(memMb);
            if (Number.isFinite(mb) && mb > 0) vramGb = Math.round(mb / 1024);
          }
        }
      } catch {
        gpuName = null;
        vramGb = null;
      }

      return { gbRam, recommendation, recommendedModel, gpuName, vramGb };
    } catch {
      return { gbRam: 8, recommendation: 'Q4 models (3B-8B)', recommendedModel: 'llama3.2:3b-instruct-q4_K_M', gpuName: null, vramGb: null };
    }
  });

  // Check whether the local Ollama runtime is reachable — drives onboarding.
  ipcMain.handle('llm:checkOllama', async () => {
    try {
      const res = await fetch('http://localhost:11434/api/tags');
      return res.ok;
    } catch {
      return false;
    }
  });

  ipcMain.handle('llm:pullModel', async (_e, name: string) => {
    const res = await fetch('http://localhost:11434/api/pull', {
      method: 'POST',
      body: JSON.stringify({ name, stream: false }),
    });
    return res.ok;
  });

  // Streaming pull — Ollama returns NDJSON progress lines; we forward each as a
  // `llm:pullProgress` event so onboarding can show a real download bar.
  ipcMain.handle('llm:pullModelStream', async (_e, name: string) => {
    const emit = (payload: unknown) => safeSend('llm:pullProgress', payload);
    try {
      const res = await fetch('http://localhost:11434/api/pull', {
        method: 'POST',
        body: JSON.stringify({ name, stream: true }),
      });
      if (!res.ok || !res.body) {
        emit({ name, status: 'error', error: `Ollama responded ${res.status}` });
        return false;
      }
      const reader = (res.body as ReadableStream<Uint8Array>).getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const obj = JSON.parse(line) as { status?: string; completed?: number; total?: number; error?: string };
            const percent = obj.total && obj.completed ? Math.round((obj.completed / obj.total) * 100) : undefined;
            emit({ name, status: obj.status ?? 'pulling', completed: obj.completed, total: obj.total, percent, error: obj.error });
          } catch { /* skip partial line */ }
        }
      }
      emit({ name, status: 'success', percent: 100 });
      return true;
    } catch (err) {
      emit({ name, status: 'error', error: err instanceof Error ? err.message : String(err) });
      return false;
    }
  });

  ipcMain.handle('llm:getActiveModel', () => {
    const db = getDb();
    const row = db.prepare(`SELECT ollama_name FROM llm_models WHERE is_active=1 LIMIT 1`).get() as { ollama_name: string } | undefined;
    return row?.ollama_name ?? null;
  });

  // Opens the public download page in the user's browser — used by the in-app
  // "update available" banner (notification-only; we don't silent-install).
  ipcMain.handle('updates:openDownload', () => {
    shell.openExternal('https://artha.space');
  });

  ipcMain.handle('llm:setActiveModel', (_e, modelName: string) => {
    const db = getDb();
    // Upsert by ollama_name so any model from the Ollama list can be activated
    const existing = db.prepare(`SELECT model_id FROM llm_models WHERE ollama_name=?`).get(modelName) as { model_id: string } | undefined;
    db.prepare(`UPDATE llm_models SET is_active=0`).run();
    if (existing) {
      db.prepare(`UPDATE llm_models SET is_active=1 WHERE model_id=?`).run(existing.model_id);
    } else {
      const id = crypto.randomUUID();
      db.prepare(`INSERT INTO llm_models (model_id, name, ollama_name, base_url, api_key, is_active) VALUES (?,?,?,?,?,1)`)
        .run(id, modelName, modelName, 'http://localhost:11434/v1', 'ollama');
    }
    return true;
  });

  // ── Cloud models (BYOK, opt-in) ──────────────────────────────────────────
  // Cloud providers are just llm_models rows with a non-local base_url + key.
  // The API key is stored in the local SQLite DB and only ever sent to the
  // provider the user explicitly configured. Local Ollama stays the default;
  // nothing here is enabled unless the user adds and activates a cloud model.
  ipcMain.handle('llm:listConfigured', () => {
    return getDb().prepare(
      `SELECT model_id, name, ollama_name, base_url, provider, context_window, is_active
       FROM llm_models ORDER BY added_at DESC`
    ).all();
  });

  ipcMain.handle('llm:addCloudModel', (_e, m: {
    provider: string; label: string; model: string; baseUrl: string; apiKey: string; activate?: boolean;
  }) => {
    const db = getDb();
    const existing = db.prepare(`SELECT model_id FROM llm_models WHERE ollama_name=?`).get(m.model) as { model_id: string } | undefined;
    const id = existing?.model_id ?? crypto.randomUUID();
    if (existing) {
      db.prepare(`UPDATE llm_models SET name=?, base_url=?, api_key=?, provider=? WHERE model_id=?`)
        .run(m.label || m.model, m.baseUrl, m.apiKey, m.provider, id);
    } else {
      db.prepare(`INSERT INTO llm_models (model_id, name, ollama_name, base_url, api_key, provider, is_active)
                  VALUES (?,?,?,?,?,?,0)`)
        .run(id, m.label || m.model, m.model, m.baseUrl, m.apiKey, m.provider);
    }
    if (m.activate) {
      db.prepare(`UPDATE llm_models SET is_active=0`).run();
      db.prepare(`UPDATE llm_models SET is_active=1 WHERE model_id=?`).run(id);
    }
    return { model_id: id };
  });

  // Clamp to [512, 128 000] so a user typo can't break the model call (most
  // Ollama models top out at 128 K; 512 is the practical floor for any reply).
  ipcMain.handle('llm:setContextWindow', (_e, modelId: string, tokens: number) => {
    const clamped = Math.max(512, Math.min(128_000, Math.round(tokens)));
    getDb().prepare(`UPDATE llm_models SET context_window=? WHERE model_id=?`).run(clamped, modelId);
    return clamped;
  });

  ipcMain.handle('llm:setActiveModelById', (_e, modelId: string) => {
    const db = getDb();
    db.prepare(`UPDATE llm_models SET is_active=0`).run();
    db.prepare(`UPDATE llm_models SET is_active=1 WHERE model_id=?`).run(modelId);
    return true;
  });

  ipcMain.handle('llm:removeModel', (_e, modelId: string) => {
    getDb().prepare(`DELETE FROM llm_models WHERE model_id=?`).run(modelId);
    return true;
  });

  // ── MCP ────────────────────────────────────────────────────────────────
  ipcMain.handle('mcp:listTools', () => {
    return getDb().prepare(`SELECT * FROM tools ORDER BY name ASC`).all();
  });

  ipcMain.handle('mcp:installServer', async (_e, uri: string) => {
    const db = getDb();
    const id = crypto.randomUUID();
    const name = uri.split('/').pop() ?? uri;
    db.prepare(`INSERT INTO tools (tool_id, name, mcp_server_uri, description) VALUES (?,?,?,?)`)
      .run(id, name, uri, `MCP server: ${uri}`);
    await MCPRegistry.getInstance().connectServer(id, name, uri);
    return { id, name };
  });

  ipcMain.handle('mcp:toggleTool', (_e, toolId: string, enabled: boolean) => {
    getDb().prepare(`UPDATE tools SET is_enabled=? WHERE tool_id=?`).run(enabled ? 1 : 0, toolId);
    return true;
  });

  ipcMain.handle('mcp:removeServer', (_e, id: string) => {
    getDb().prepare(`DELETE FROM tools WHERE tool_id=?`).run(id);
    return true;
  });

  // Installed MCP servers persist in the `tools` table keyed by their install
  // URI (mcp_server_uri). The Marketplace uses this to restore the "Installed"
  // badge across panel navigations instead of relying on in-memory state.
  ipcMain.handle('mcp:listInstalledIds', () => {
    const rows = getDb().prepare(
      `SELECT mcp_server_uri FROM tools WHERE mcp_server_uri IS NOT NULL`
    ).all() as { mcp_server_uri: string }[];
    return rows.map(r => r.mcp_server_uri);
  });

  ipcMain.handle('mcp:getAuditLog', (_e, limit = 200) => {
    return getDb().prepare(
      `SELECT * FROM tool_audit_log ORDER BY ts DESC LIMIT ?`
    ).all(limit);
  });

  // ── Skills ───────────────────────────────────────────────────────────────
  // Named playbooks the agent loads on intent-match or explicit "/slug".
  const skills = SkillRegistry.getInstance();

  ipcMain.handle('skills:list', () => skills.list());
  ipcMain.handle('skills:listEnabled', () => skills.listEnabled());
  ipcMain.handle('skills:create', (_e, input: SkillInput) => skills.create(input));
  ipcMain.handle('skills:update', (_e, skillId: string, patch: Partial<SkillInput>) =>
    skills.update(skillId, patch)
  );
  ipcMain.handle('skills:toggle', (_e, skillId: string, enabled: boolean) => {
    skills.toggle(skillId, enabled);
    return true;
  });
  ipcMain.handle('skills:remove', (_e, skillId: string) => skills.remove(skillId));

  // Export one skill to a portable .artha-skill.json file.
  ipcMain.handle('skills:export', async (_e, skillId: string) => {
    const data = skills.serialize(skillId);
    if (!data) return null;
    const result = await dialog.showSaveDialog(window, {
      defaultPath: `${data.slug}.artha-skill.json`,
      filters: [{ name: 'Artha Skill', extensions: ['json'] }],
    });
    if (result.canceled || !result.filePath) return null;
    const fs = require('fs') as typeof import('fs');
    fs.writeFileSync(result.filePath, JSON.stringify({ schema: 'artha-skill/v1', skill: data }, null, 2));
    return result.filePath;
  });

  // Import skill(s) from a JSON file. Tolerates several payload shapes and
  // assigns collision-free slugs so imports never overwrite existing skills.
  ipcMain.handle('skills:import', async () => {
    const result = await dialog.showOpenDialog(window, {
      filters: [{ name: 'Artha Skill', extensions: ['json'] }],
      properties: ['openFile'],
    });
    if (result.canceled || !result.filePaths[0]) return null;
    const fs = require('fs') as typeof import('fs');
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(result.filePaths[0], 'utf-8'));
    } catch {
      throw new Error('That file is not valid JSON.');
    }
    const items = parseSkillImport(parsed);
    for (const item of items) skills.importSkill(item);
    return { count: items.length };
  });

  // ── RAG ────────────────────────────────────────────────────────────────
  // Native folder picker for choosing a directory to index.
  ipcMain.handle('dialog:selectDirectory', async () => {
    const result = await dialog.showOpenDialog(window, {
      properties: ['openDirectory'],
      title: 'Choose a folder to index',
    });
    if (result.canceled || !result.filePaths[0]) return null;
    return result.filePaths[0];
  });

  ipcMain.handle('rag:listIndexes', () => {
    return getDb().prepare(`SELECT * FROM rag_indexes ORDER BY created_at DESC`).all();
  });

  ipcMain.handle('rag:createIndex', async (_e, name: string, dirPath: string) => {
    const db = getDb();
    const id = crypto.randomUUID();
    db.prepare(`INSERT INTO rag_indexes (index_id, name, directory_path) VALUES (?,?,?)`).run(id, name, dirPath);
    const count = await ragIndexer.buildIndex(id, dirPath);
    return { id, count };
  });

  ipcMain.handle('rag:deleteIndex', (_e, id: string) => {
    getDb().prepare(`DELETE FROM rag_indexes WHERE index_id=?`).run(id);
  });

  ipcMain.handle('rag:rebuildIndex', async (_e, id: string) => {
    const row = getDb().prepare(`SELECT directory_path FROM rag_indexes WHERE index_id=?`).get(id) as { directory_path: string } | undefined;
    if (!row) return;
    return ragIndexer.buildIndex(id, row.directory_path);
  });

  // ── Document Generation ─────────────────────────────────────────────────
  ipcMain.handle('docs:generate', async (_e, type: string, prompt: string, outPath: string) => {
    // If no outPath provided, show save dialog
    let finalPath = outPath;
    if (!finalPath) {
      const result = await dialog.showSaveDialog(window, {
        defaultPath: `artha-document.${type}`,
        filters: [{ name: type.toUpperCase(), extensions: [type] }],
      });
      if (result.canceled || !result.filePath) return null;
      finalPath = result.filePath;
    }
    return generateDocument({ type: type as 'docx' | 'pptx' | 'xlsx' | 'pdf', prompt, outPath: finalPath });
  });

  ipcMain.handle('docs:openFile', (_e, filePath: string) => {
    shell.openPath(filePath);
  });

  // ── Settings ───────────────────────────────────────────────────────────
  ipcMain.handle('settings:get', () => {
    const row = getDb().prepare(`SELECT settings_json FROM users WHERE user_id='default'`).get() as { settings_json: string };
    return JSON.parse(row?.settings_json ?? '{}');
  });

  ipcMain.handle('settings:set', (_e, patch: Record<string, unknown>) => {
    const db = getDb();
    const existing = JSON.parse((db.prepare(`SELECT settings_json FROM users WHERE user_id='default'`).get() as { settings_json: string })?.settings_json ?? '{}');
    db.prepare(`UPDATE users SET settings_json=? WHERE user_id='default'`).run(JSON.stringify({ ...existing, ...patch }));
  });

  // ── License ────────────────────────────────────────────────────────────
  // Offline Ed25519-signed keys gate Pro/Enterprise capabilities. The raw key
  // is stored on settings_json.license_key; verification is local-only (see
  // ../license/verify). The renderer never receives the raw key back after
  // apply — only the derived entitlements + organisation + expiry.
  ipcMain.handle('license:get', () => {
    const ents = currentEntitlements();
    return {
      entitlements: ents,
      hasKey: !!getRawLicenseKey(),
    };
  });

  ipcMain.handle('license:apply', (_e, rawKey: string) => {
    const trimmed = (rawKey ?? '').trim();
    if (!trimmed) {
      return { ok: false, error: 'License key is empty.' };
    }
    const payload = parseAndVerify(trimmed);
    if (!payload) {
      return { ok: false, error: 'Invalid or expired license key. Check that you pasted the full line.' };
    }
    const db = getDb();
    const existing = JSON.parse((db.prepare(`SELECT settings_json FROM users WHERE user_id='default'`).get() as { settings_json: string })?.settings_json ?? '{}');
    db.prepare(`UPDATE users SET settings_json=? WHERE user_id='default'`)
      .run(JSON.stringify({ ...existing, license_key: trimmed }));
    invalidateEntitlements();
    return { ok: true, entitlements: currentEntitlements() };
  });

  ipcMain.handle('license:clear', () => {
    const db = getDb();
    const existing = JSON.parse((db.prepare(`SELECT settings_json FROM users WHERE user_id='default'`).get() as { settings_json: string })?.settings_json ?? '{}');
    delete existing.license_key;
    db.prepare(`UPDATE users SET settings_json=? WHERE user_id='default'`).run(JSON.stringify(existing));
    invalidateEntitlements();
    return { ok: true, entitlements: FREE_ENTITLEMENTS };
  });

  // ── Bundles ─────────────────────────────────────────────────────────────
  ipcMain.handle('bundles:export', async (_e, runId: string, docId?: string) => {
    const result = await dialog.showSaveDialog(window, {
      defaultPath: `workflow-${runId.slice(0, 8)}.artha-bundle`,
      filters: [{ name: 'Artha Bundle', extensions: ['artha-bundle'] }],
    });
    if (result.canceled || !result.filePath) return null;
    return exportBundle({ runId, outPath: result.filePath, docId });
  });

  ipcMain.handle('bundles:import', async () => {
    const result = await dialog.showOpenDialog(window, {
      filters: [{ name: 'Artha Bundle', extensions: ['artha-bundle'] }],
      properties: ['openFile'],
    });
    if (result.canceled || !result.filePaths[0]) return null;
    const importsDir = path.join(app.getPath('userData'), 'imported-bundles');
    return importBundle(result.filePaths[0], importsDir);
  });

  ipcMain.handle('bundles:openExtracted', (_e, dir: string) => {
    shell.openPath(dir);
  });

  // ── Router ──────────────────────────────────────────────────────────────
  // Adaptive per-task-type model selection. `benchmark` probes every installed
  // Ollama model on the three canonical tasks (plan / tool_args / synthesis)
  // and records latency + a quality heuristic; `setOverride` lets the user pin
  // a specific model for a task type, bypassing auto-selection.
  ipcMain.handle('router:benchmark', async () => {
    return runBenchmark((msg) => safeSend('router:benchmarkProgress', msg));
  });

  ipcMain.handle('router:listProfiles', () => listProfiles());
  ipcMain.handle('router:listOverrides', () => listOverrides());
  ipcMain.handle('router:setOverride', (_e, taskType: string, ollamaName: string | null) =>
    setOverride(taskType, ollamaName)
  );

  // ── Provenance ──────────────────────────────────────────────────────────
  ipcMain.handle('provenance:listDocs', () => {
    return getDb().prepare(
      `SELECT doc_id, file_path, doc_type, title, model, content_hash, created_at
       FROM generated_documents ORDER BY created_at DESC LIMIT 200`
    ).all();
  });

  ipcMain.handle('provenance:listAnchors', (_e, docId: string) => {
    return getDb().prepare(
      `SELECT anchor_id, source_type, source_ref, excerpt
       FROM provenance_records WHERE doc_id=? ORDER BY rowid ASC`
    ).all(docId);
  });

  // The receipt is a sidecar JSON file written by the document generator next
  // to the artifact. It's the canonical signed record of "what produced this
  // file" — returned to the renderer so the user can audit before sharing.
  ipcMain.handle('provenance:getReceipt', (_e, docId: string) => {
    const row = getDb().prepare(
      `SELECT receipt_path FROM generated_documents WHERE doc_id=?`
    ).get(docId) as { receipt_path: string } | undefined;
    if (!row?.receipt_path) return null;
    try {
      const fs = require('fs') as typeof import('fs');
      return JSON.parse(fs.readFileSync(row.receipt_path, 'utf-8'));
    } catch {
      return null;
    }
  });

  // ── Time-travel ─────────────────────────────────────────────────────────
  // `has_snapshot` is a 0/1 flag the UI uses to disable the "Fork" button for
  // steps that didn't capture a full messages array (only assistant/system
  // steps with snapshots can be replayed).
  ipcMain.handle('timetravel:listRuns', (_e, sessionId?: string) => {
    const db = getDb();
    if (sessionId) {
      return db.prepare(
        `SELECT run_id, session_id, workflow_id, parent_run_id, forked_from_step,
                goal, model, status, created_at
         FROM agent_runs WHERE session_id=? ORDER BY created_at DESC LIMIT 200`
      ).all(sessionId);
    }
    return db.prepare(
      `SELECT run_id, session_id, workflow_id, parent_run_id, forked_from_step,
              goal, model, status, created_at
       FROM agent_runs ORDER BY created_at DESC LIMIT 200`
    ).all();
  });

  ipcMain.handle('timetravel:getSteps', (_e, runId: string) => {
    return getDb().prepare(
      `SELECT step_id, idx, kind, payload, ts,
              CASE WHEN messages_snapshot IS NULL THEN 0 ELSE 1 END AS has_snapshot
       FROM agent_steps WHERE run_id=? ORDER BY idx ASC`
    ).all(runId);
  });

  ipcMain.handle('timetravel:fork', async (_e, stepId: string, modelOverride?: string) => {
    return orchestrator.forkFromStep(stepId, modelOverride ? { modelOverride } : undefined);
  });

  // ── Web tools ──────────────────────────────────────────────────────────
  // Settings live inside the `web` key on the user's settings_json blob.
  // getWebConfig fills in defaults so the renderer never has to.
  ipcMain.handle('settings:getWebConfig', (): WebConfig => {
    const db = getDb();
    const row = db.prepare(`SELECT settings_json FROM users WHERE user_id='default'`).get() as { settings_json: string } | undefined;
    const settings = JSON.parse(row?.settings_json ?? '{}') as { web?: Partial<WebConfig> };
    return { ...DEFAULT_WEB_CONFIG, ...(settings.web ?? {}) };
  });

  ipcMain.handle('settings:setWebConfig', (_e, patch: Partial<WebConfig>) => {
    const db = getDb();
    const row = db.prepare(`SELECT settings_json FROM users WHERE user_id='default'`).get() as { settings_json: string } | undefined;
    const settings = JSON.parse(row?.settings_json ?? '{}') as { web?: Partial<WebConfig> };
    const nextWeb = { ...DEFAULT_WEB_CONFIG, ...(settings.web ?? {}), ...patch };
    db.prepare(`UPDATE users SET settings_json=? WHERE user_id='default'`)
      .run(JSON.stringify({ ...settings, web: nextWeb }));
    return nextWeb;
  });

  ipcMain.handle('web:clearCache', () => clearWebCache());

  ipcMain.handle('web:getCacheStats', () => {
    const db = getDb();
    const row = db.prepare(
      `SELECT COUNT(*) AS count, COALESCE(SUM(LENGTH(content)),0) AS bytes FROM web_cache`
    ).get() as { count: number; bytes: number };
    return row;
  });

  // ── Browser (BrowserView co-pilot) ──────────────────────────────────────
  // The renderer owns the pane geometry; main owns the actual webContents.
  // A tiny event bridge keeps the URL bar / wheel indicator in sync.
  const browser = BrowserController.getInstance();

  browser.on('state', (state) => {
    safeSend('browser:state', state);
  });

  // Browser tools fire these events through the emitter — surface them to the
  // renderer so the pane can auto-open and the handoff banner can appear.
  setBrowserToolEmitter({
    emit: (channel, payload) => safeSend(channel, payload),
  });

  ipcMain.handle('browser:attach', (_e, bounds: { x: number; y: number; width: number; height: number }) => {
    browser.attach(bounds);
    return browser.getState();
  });

  ipcMain.handle('browser:detach', () => {
    browser.detach();
    return browser.getState();
  });

  ipcMain.handle('browser:setBounds', (_e, bounds: { x: number; y: number; width: number; height: number }) => {
    browser.setBounds(bounds);
  });

  ipcMain.handle('browser:navigate', async (_e, url: string) => {
    const wc = browser.getWebContents();
    const { navigate } = await import('../browser/actions');
    const r = await navigate(wc, url);
    return r;
  });

  ipcMain.handle('browser:back', () => {
    const wc = browser.getWebContents();
    if (wc.canGoBack()) wc.goBack();
  });
  ipcMain.handle('browser:forward', () => {
    const wc = browser.getWebContents();
    if (wc.canGoForward()) wc.goForward();
  });
  ipcMain.handle('browser:reload', () => browser.getWebContents().reload());
  ipcMain.handle('browser:stop', () => browser.getWebContents().stop());

  ipcMain.handle('browser:takeWheel', () => {
    browser.setDrivingMode('user');
    return browser.getState();
  });

  ipcMain.handle('browser:resumeAgent', () => {
    browser.resumeAgent();
    return browser.getState();
  });

  ipcMain.handle('browser:cancelHandoff', () => {
    browser.cancelHandoff();
    return browser.getState();
  });

  ipcMain.handle('browser:recover', () => {
    browser.recover();
    return browser.getState();
  });

  ipcMain.handle('browser:getState', () => browser.getState());

  // ── Scheduler ─────────────────────────────────────────────────────────────
  // CRUD for scheduled_tasks. The SchedulerService instance is a singleton;
  // these handlers are thin wrappers that delegate to it.
  const sched = SchedulerService.getInstance();

  ipcMain.handle('scheduler:list', () => sched.list());

  ipcMain.handle('scheduler:create', (_e, input: TaskInput) => sched.create(input));

  ipcMain.handle('scheduler:update', (_e, taskId: string, patch: Partial<TaskInput>) =>
    sched.update(taskId, patch));

  ipcMain.handle('scheduler:toggle', (_e, taskId: string, enabled: boolean) =>
    sched.toggle(taskId, enabled));

  ipcMain.handle('scheduler:remove', (_e, taskId: string) => {
    sched.remove(taskId);
    return true;
  });

  // ── Artifacts ─────────────────────────────────────────────────────────────
  // Log and browse files the agent has generated. Callers (docs generator, any
  // tool that creates a file) write a row; the ArtifactsPanel reads them back.
  ipcMain.handle('artifacts:list', () => {
    return getDb().prepare(
      `SELECT artifact_id, session_id, name, file_path, file_type, size_bytes, created_at
       FROM artifacts ORDER BY created_at DESC LIMIT 500`
    ).all();
  });

  ipcMain.handle('artifacts:log', (_e, entry: { sessionId?: string; name: string; filePath: string; fileType: string; sizeBytes?: number }) => {
    const db = getDb();
    const id = db.prepare(
      `INSERT INTO artifacts (session_id, name, file_path, file_type, size_bytes)
       VALUES (?, ?, ?, ?, ?) RETURNING artifact_id`
    ).get(entry.sessionId ?? null, entry.name, entry.filePath, entry.fileType, entry.sizeBytes ?? null) as { artifact_id: string };
    return id?.artifact_id ?? null;
  });

  ipcMain.handle('artifacts:delete', (_e, artifactId: string) => {
    getDb().prepare(`DELETE FROM artifacts WHERE artifact_id=?`).run(artifactId);
    return true;
  });

  ipcMain.handle('artifacts:open', async (_e, filePath: string) => {
    await shell.openPath(filePath);
    return true;
  });

  // ── Memory ────────────────────────────────────────────────────────────────
  ipcMain.handle('memory:list', () => {
    const db = getDb();
    return db.prepare(
      `SELECT entity_id, name, entity_type, content, tags_json, created_at, updated_at
       FROM memory_entities ORDER BY updated_at DESC`
    ).all();
  });

  ipcMain.handle('memory:delete', (_e, entityId: string) => {
    const db = getDb();
    const info = db.prepare(`DELETE FROM memory_entities WHERE entity_id=?`).run(entityId);
    return info.changes > 0;
  });

  ipcMain.handle('memory:clear', () => {
    const db = getDb();
    db.prepare(`DELETE FROM memory_entities`).run();
    return true;
  });

  // ── Cloud OAuth (Google Workspace) ─────────────────────────────────────────
  // Google client id is stored on the user settings blob (same place as every
  // other app setting). It's an installed-app "Desktop" OAuth client, so the
  // flow uses PKCE — no client secret required.
  const readSettings = (): Record<string, unknown> => {
    const row = getDb().prepare(`SELECT settings_json FROM users WHERE user_id='default'`).get() as { settings_json: string } | undefined;
    return JSON.parse(row?.settings_json ?? '{}');
  };
  const writeSetting = (key: string, value: unknown) => {
    const db = getDb();
    const settings = readSettings();
    settings[key] = value;
    db.prepare(`UPDATE users SET settings_json=? WHERE user_id='default'`).run(JSON.stringify(settings));
  };

  ipcMain.handle('settings:getGoogleClientId', () => {
    return (readSettings().google_client_id as string | undefined) ?? '';
  });
  ipcMain.handle('settings:setGoogleClientId', (_e, id: string) => {
    writeSetting('google_client_id', (id ?? '').trim());
    return true;
  });

  const GOOGLE_SCOPES = [
    'https://www.googleapis.com/auth/gmail.readonly',
    'https://www.googleapis.com/auth/calendar.readonly',
    'https://www.googleapis.com/auth/drive.readonly',
  ];
  const OAUTH_REDIRECT = 'http://localhost:9742/oauth/callback';
  const OAUTH_PORT = 9742;

  ipcMain.handle('oauth:startFlow', async (_e, opts: { provider: string }): Promise<{ success: boolean; error?: string }> => {
    try {
      if (opts?.provider !== 'google') return { success: false, error: `Unsupported provider: ${opts?.provider}` };
      const db = getDb();
      const clientId = readSettings().google_client_id as string | undefined;
      if (!clientId) return { success: false, error: 'No Google Client ID configured. Add it in the Cloud panel’s Setup section first.' };
      const clientSecret = readSettings().google_client_secret as string | undefined; // optional

      const nodeCrypto = await import('crypto');
      const codeVerifier = nodeCrypto.randomBytes(32).toString('base64url');
      const codeChallenge = nodeCrypto.createHash('sha256').update(codeVerifier).digest('base64url');
      const state = nodeCrypto.randomBytes(16).toString('hex');

      const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
      authUrl.searchParams.set('client_id', clientId);
      authUrl.searchParams.set('redirect_uri', OAUTH_REDIRECT);
      authUrl.searchParams.set('response_type', 'code');
      authUrl.searchParams.set('scope', GOOGLE_SCOPES.join(' '));
      authUrl.searchParams.set('access_type', 'offline');
      authUrl.searchParams.set('prompt', 'consent');
      authUrl.searchParams.set('code_challenge', codeChallenge);
      authUrl.searchParams.set('code_challenge_method', 'S256');
      authUrl.searchParams.set('state', state);

      // Spin up a local HTTP server on OAUTH_PORT (9742) to receive the redirect
      // from Google, then open a modal popup for the user to log in.  `settled`
      // guards against the server, popup-close, and timeout all racing to call
      // resolve().  The server closes itself as soon as it receives one callback.
      return await new Promise<{ success: boolean; error?: string }>((resolve) => {
        let settled = false;
        let popup: BrowserWindow | null = new BrowserWindow({
          width: 800, height: 600, modal: true, parent: window, title: 'Connect Google',
          webPreferences: { contextIsolation: true, nodeIntegration: false },
        });
        const server = http.createServer(async (req, res) => {
          const url = new URL(req.url ?? '', OAUTH_REDIRECT);
          if (url.pathname !== '/oauth/callback') { res.writeHead(404); res.end(); return; }
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end('<html><body style="font-family:system-ui;padding:48px;text-align:center"><h2>Artha — Google connected</h2><p>You can close this window and return to Artha.</p></body></html>');
          const err = url.searchParams.get('error');
          const code = url.searchParams.get('code');
          const returnedState = url.searchParams.get('state');
          if (err) return finish({ success: false, error: err });
          if (returnedState !== state) return finish({ success: false, error: 'OAuth state mismatch — aborting.' });
          if (!code) return finish({ success: false, error: 'No authorization code returned.' });
          try {
            const body = new URLSearchParams({
              code, client_id: clientId, redirect_uri: OAUTH_REDIRECT,
              grant_type: 'authorization_code', code_verifier: codeVerifier,
            });
            if (clientSecret) body.set('client_secret', clientSecret);
            const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
              method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body,
            });
            const tok = await tokenRes.json() as { access_token?: string; refresh_token?: string; expires_in?: number; scope?: string; error?: string; error_description?: string };
            if (!tokenRes.ok) return finish({ success: false, error: tok.error_description || tok.error || `Token exchange failed (${tokenRes.status}).` });
            const expiresAt = Math.floor(Date.now() / 1000) + (tok.expires_in ?? 3600);
            db.prepare(
              `INSERT INTO oauth_tokens (provider, access_token, refresh_token, expires_at, scope)
               VALUES ('google', ?, ?, ?, ?)
               ON CONFLICT(provider) DO UPDATE SET
                 access_token=excluded.access_token,
                 refresh_token=COALESCE(excluded.refresh_token, oauth_tokens.refresh_token),
                 expires_at=excluded.expires_at, scope=excluded.scope`
            ).run(tok.access_token ?? null, tok.refresh_token ?? null, expiresAt, tok.scope ?? GOOGLE_SCOPES.join(' '));
            finish({ success: true });
          } catch (e) {
            finish({ success: false, error: e instanceof Error ? e.message : String(e) });
          }
        });
        const finish = (r: { success: boolean; error?: string }) => {
          if (settled) return;
          settled = true;
          try { server.close(); } catch { /* ignore */ }
          if (popup && !popup.isDestroyed()) popup.close();
          popup = null;
          resolve(r);
        };
        server.on('error', (e) => finish({ success: false, error: e.message }));
        server.listen(OAUTH_PORT, '127.0.0.1', () => { popup?.loadURL(authUrl.toString()); });
        popup.on('closed', () => finish({ success: false, error: 'Window closed before authorization completed.' }));
        // 3-minute hard timeout — enough for any human to complete the login
        // flow, but prevents the promise from hanging indefinitely if something
        // goes wrong after the user walks away.
        setTimeout(() => finish({ success: false, error: 'OAuth timed out.' }), 180_000);
      });
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle('oauth:getStatus', () => {
    return getDb().prepare(`SELECT provider, expires_at FROM oauth_tokens`).all() as { provider: string; expires_at: number }[];
  });

  ipcMain.handle('oauth:revoke', async (_e, provider: string) => {
    const db = getDb();
    const row = db.prepare(`SELECT access_token FROM oauth_tokens WHERE provider=?`).get(provider) as { access_token: string | null } | undefined;
    db.prepare(`DELETE FROM oauth_tokens WHERE provider=?`).run(provider);
    if (row?.access_token) {
      try {
        await fetch('https://oauth2.googleapis.com/revoke', {
          method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ token: row.access_token }),
        });
      } catch { /* best-effort — row is already gone locally */ }
    }
    return true;
  });

  // ── IDE Integration ───────────────────────────────────────────────────────
  // Generate and write an MCP server config for VS Code (.vscode/mcp.json) or
  // Cursor (.cursor/mcp.json) so the user can talk to Artha's tools from their
  // editor. The caller passes the project folder; we pick / create the right
  // config subdirectory and write the file, then reveal it in Finder.
  ipcMain.handle('ide:generateMcpConfig', async (_e, opts: {
    projectPath: string;
    ide: 'vscode' | 'cursor';
    port?: number;
  }) => {
    const fs = await import('fs');
    const { projectPath, ide, port = 3847 } = opts;

    const subdir   = ide === 'vscode' ? '.vscode' : '.cursor';
    const confDir  = path.join(projectPath, subdir);
    const confFile = path.join(confDir, 'mcp.json');

    if (!fs.existsSync(confDir)) fs.mkdirSync(confDir, { recursive: true });

    const config = {
      mcpServers: {
        artha: {
          url: `http://localhost:${port}/mcp`,
          description: 'Artha local AI agent — filesystem, web, docs, RAG, memory tools',
        },
      },
    };

    fs.writeFileSync(confFile, JSON.stringify(config, null, 2), 'utf8');
    await shell.showItemInFolder(confFile);
    return confFile;
  });

  // Pick a project folder then generate config — convenience wrapper used by
  // the IDE Integration panel's "Browse…" flow.
  ipcMain.handle('ide:pickProjectAndGenerate', async (_e, ide: 'vscode' | 'cursor', port: number) => {
    const result = await dialog.showOpenDialog({
      properties: ['openDirectory'],
      title: 'Select your project folder',
    });
    if (result.canceled || !result.filePaths.length) return null;
    const projectPath = result.filePaths[0];

    // Re-use the generate handler logic inline.
    const fs = await import('fs');
    const subdir   = ide === 'vscode' ? '.vscode' : '.cursor';
    const confDir  = path.join(projectPath, subdir);
    const confFile = path.join(confDir, 'mcp.json');
    if (!fs.existsSync(confDir)) fs.mkdirSync(confDir, { recursive: true });
    const config = {
      mcpServers: {
        artha: {
          url: `http://localhost:${port}/mcp`,
          description: 'Artha local AI agent — filesystem, web, docs, RAG, memory tools',
        },
      },
    };
    fs.writeFileSync(confFile, JSON.stringify(config, null, 2), 'utf8');
    await shell.showItemInFolder(confFile);
    return confFile;
  });

  // Start / stop the local MCP HTTP bridge that editor configs point at. Start
  // is idempotent (no-op if already running); both return the current status so
  // the panel can render its running indicator.
  ipcMain.handle('ide:startMcpServer', () => startIdeMcpServer());
  ipcMain.handle('ide:stopMcpServer', () => stopIdeMcpServer());

  // ── LAN collaboration server ──────────────────────────────────────────────
  ipcMain.handle('lan:start', () => startLanServer());
  ipcMain.handle('lan:stop', () => stopLanServer());
  ipcMain.handle('lan:getStatus', () => lanStatus());
  ipcMain.handle('lan:setAutostart', (_e, enabled: boolean) => {
    writeSetting('lan_autostart', !!enabled);
    return true;
  });
  ipcMain.handle('lan:getAutostart', () => !!readSettings().lan_autostart);

  // ── Parallel subagents ────────────────────────────────────────────────────
  ipcMain.handle('agent:runParallel', (_e, opts: { sessionId: string; goal: string; subTasks: string[] }) => {
    return orchestrator.runParallel(opts.sessionId, opts.goal, opts.subTasks);
  });

  // ── Desktop control ───────────────────────────────────────────────────────
  // Bridges the main-process desktopCapturer into the tool system + renderer.
  // Returns a base64 PNG (no data: prefix) of the primary screen.
  ipcMain.handle('desktop:capture', async () => {
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: 1920, height: 1080 },
    });
    const first = sources[0];
    if (!first) throw new Error('No screen source available.');
    return first.thumbnail.toPNG().toString('base64');
  });
  ipcMain.handle('settings:getDesktopControl', () => !!readSettings().desktop_control_enabled);
  ipcMain.handle('settings:setDesktopControl', (_e, enabled: boolean) => {
    writeSetting('desktop_control_enabled', !!enabled);
    return true;
  });

  // ── Team members ──────────────────────────────────────────────────────────
  // Local team roster used in the Team panel. No auth of its own — the admin
  // UI is only accessible on the machine running Artha. Remote access is
  // controlled by LAN API keys (see below).
  ipcMain.handle('team:listMembers', () => {
    return getDb().prepare(
      `SELECT member_id, display_name, email, role, joined_at FROM team_members ORDER BY joined_at ASC`
    ).all();
  });

  ipcMain.handle('team:addMember', (_e, m: { displayName: string; email?: string; role?: 'admin' | 'member' }) => {
    const db = getDb();
    // Seat enforcement: the license-encoded seat count caps the team roster.
    // Pro/Enterprise customers can lift this by re-issuing a key with a higher
    // `seats`; Free customers stay at 1.
    const ents = currentEntitlements();
    const count = (db.prepare(`SELECT COUNT(*) AS n FROM team_members`).get() as { n: number }).n;
    if (count >= ents.seats) {
      throw new Error(`Seat limit reached (${count}/${ents.seats}). Upgrade your license to add more members.`);
    }
    const id = crypto.randomUUID();
    db.prepare(
      `INSERT INTO team_members (member_id, display_name, email, role) VALUES (?, ?, ?, ?)`
    ).run(id, m.displayName.trim(), m.email?.trim() ?? null, m.role ?? 'member');
    return { member_id: id };
  });

  ipcMain.handle('team:updateMember', (_e, memberId: string, patch: { displayName?: string; email?: string; role?: 'admin' | 'member' }) => {
    const db = getDb();
    if (patch.displayName !== undefined) db.prepare(`UPDATE team_members SET display_name=? WHERE member_id=?`).run(patch.displayName.trim(), memberId);
    if (patch.email !== undefined) db.prepare(`UPDATE team_members SET email=? WHERE member_id=?`).run(patch.email.trim() || null, memberId);
    if (patch.role !== undefined) db.prepare(`UPDATE team_members SET role=? WHERE member_id=?`).run(patch.role, memberId);
    return true;
  });

  ipcMain.handle('team:removeMember', (_e, memberId: string) => {
    getDb().prepare(`DELETE FROM team_members WHERE member_id=?`).run(memberId);
    return true;
  });

  // ── LAN API keys ──────────────────────────────────────────────────────────
  // Generate, list, and revoke Bearer tokens for the LAN collaboration server.
  // The plaintext key is returned ONCE on creation and never stored — only the
  // SHA-256 hash lives in the DB. Lost keys must be revoked and regenerated.
  ipcMain.handle('apikeys:list', () => {
    return getDb().prepare(
      `SELECT key_id, name, created_at, last_used_at, is_enabled FROM api_keys ORDER BY created_at DESC`
    ).all();
  });

  // Accepts either the legacy string-only form (`apikeys:create("My key")`) or
  // the new object form that binds the key to a teammate
  // (`apikeys:create({ name, memberId })`). The bound member's role is cached
  // on the row so LAN auth can resolve identity without a join.
  ipcMain.handle('apikeys:create', (_e, args: string | { name: string; memberId?: string }): { key_id: string; plaintext: string } => {
    const name = (typeof args === 'string' ? args : args?.name) ?? 'API Key';
    const memberId = typeof args === 'object' && args ? (args.memberId ?? null) : null;
    const db = getDb();
    // Seat enforcement: a "seat" = one enabled API key.
    const ents = currentEntitlements();
    const enabledCount = (db.prepare(`SELECT COUNT(*) AS n FROM api_keys WHERE is_enabled=1`).get() as { n: number }).n;
    if (enabledCount >= ents.seats) {
      throw new Error(`Seat limit reached (${enabledCount}/${ents.seats}). Upgrade your license to issue more keys.`);
    }
    let role: 'admin' | 'member' = 'member';
    if (memberId) {
      const m = db.prepare(`SELECT role FROM team_members WHERE member_id=?`).get(memberId) as { role: string } | undefined;
      if (!m) throw new Error(`Unknown member_id "${memberId}".`);
      role = m.role === 'admin' ? 'admin' : 'member';
    }
    const { randomBytes } = require('crypto') as typeof import('crypto');
    const plaintext = randomBytes(32).toString('base64url'); // 43-char URL-safe token
    const keyHash = hashApiKey(plaintext);
    const id = crypto.randomUUID();
    db.prepare(
      `INSERT INTO api_keys (key_id, name, key_hash, member_id, role) VALUES (?, ?, ?, ?, ?)`,
    ).run(id, name.trim() || 'API Key', keyHash, memberId, role);
    return { key_id: id, plaintext };
  });

  ipcMain.handle('apikeys:toggle', (_e, keyId: string, enabled: boolean) => {
    getDb().prepare(`UPDATE api_keys SET is_enabled=? WHERE key_id=?`).run(enabled ? 1 : 0, keyId);
    return true;
  });

  ipcMain.handle('apikeys:revoke', (_e, keyId: string) => {
    getDb().prepare(`DELETE FROM api_keys WHERE key_id=?`).run(keyId);
    return true;
  });

  // ── Shared memories ───────────────────────────────────────────────────────
  // Toggle is_shared on a memory entity. Shared memories are injected into LAN
  // server sessions so remote teammates get the same persistent context.
  ipcMain.handle('memory:setShared', (_e, entityId: string, shared: boolean) => {
    getDb().prepare(`UPDATE memory_entities SET is_shared=? WHERE entity_id=?`).run(shared ? 1 : 0, entityId);
    return true;
  });

  ipcMain.handle('memory:listShared', () => {
    return getDb().prepare(
      `SELECT entity_id, name, entity_type, content, tags_json, is_shared, created_at, updated_at
       FROM memory_entities WHERE is_shared=1 ORDER BY updated_at DESC`
    ).all();
  });
}
