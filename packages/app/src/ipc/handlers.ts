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
import { runWithContext } from '../agent/runContext';
import { listUndoable, revert } from '../agent/undo';
import { globalSearch } from '../search/global';
import { getBriefing, markBriefingSeen } from '../briefing/briefing';
import { spawnEnv } from '../system/nodePath';
import { MCPRegistry, parseEnvTokens } from '../mcp/registry';
import { sealCredentials, openCredentials, isAtRestEncryptionAvailable, type StoredCredentials } from '../security/secrets';
import {
  sealSecretString, openSecretString, isSecretEncryptionAvailable, SESSION_SENTINEL, SecureStorageUnavailableError,
} from '../security/secretString';
import { setSessionKey, getSessionKey, deleteSessionKey } from '../security/sessionKeys';
import { PROVIDER_PRESETS } from '../llm/providerPresets';
import { discoverModels, testConnection } from '../llm/providerProbe';
import { getEffectiveCapabilities } from '../llm/capabilities';
import { isOllamaManaged } from '../llm/providerKind';
import { usableApiKey } from '../llm/client';
import { SkillRegistry, type SkillInput } from '../skills/registry';
import { CapabilityRegistry, OrchestratorCapabilityExecutor, buildOperatorSkill, getTask, getTaskSteps } from '../bodhi';
import { listPolicies, createPolicy, updatePolicy, deletePolicy, type PolicyInput } from '../bodhi/policy';
import { listReceiptRuns, listReceiptsByRun } from '../bodhi/receipts';
import { parseSkillImport } from '../skills/util';
import { getSkillMetrics, getSkillModelStats, getSkillToolUsage, getSkillFailures } from '../skills/metrics';
import { getDefaultRagIndexer } from '../rag/indexer';
import { listContacts, addContact, listInteractions, logInteraction, deleteContact } from '../tools/crm';
import { listEntities, listRelations, queryGraphDb } from '../bodhi/knowledgeGraph';
import { buildShallowTree } from '../agent/folderTree';
import { generateDocument } from '../docs/generator';
import { exportBundle, importBundle } from '../bundles/bundle';
import { runBenchmark, benchmarkModel, listProfiles, setOverride, listOverrides } from '../router/benchmark';
import { getDb } from '../db/schema';
import { recomputePrimaryProject, getSessionScopes, findOrCreateFolderWorkspace } from '../db/scopes';
import {
  listPacks, savePackFromSession, applyPackToSession,
  getPackForSession, detachPackFromSession, deletePack,
  setPackShared, describeSharedPacks,
} from '../agent/contextPacks';
import { setSentryRuntimeEnabled, setOllamaConnectedTag, setMcpServerCountTag } from '../sentry';
import { ensureModelReady, getModelStatus, getSemanticStatus } from '../llm/ollamaRuntime';
import { getDefaultProfile } from '../llm/profiles';
import { FREE_ENTITLEMENTS } from '../license/entitlements';
import { invalidateEntitlements, parseAndVerify } from '../license/verify';
import { usedSeats } from '../license/seats';
import { getRawLicenseKey, currentEntitlements } from '../license/current';
import { DEFAULT_WEB_CONFIG, clearWebCache, type WebConfig } from '../tools/web';
import { BrowserController } from '../browser/controller';
import { setBrowserToolEmitter } from '../tools/browser';
import { createRateLimiter } from '../net/rateLimiter';
import {
  parseMemoryExport, refineMemoryExport, importMemories, exportMemories,
  type ParsedEntry,
} from '../tools/memoryImport';
import { SchedulerService, type TaskInput } from '../scheduler/scheduler';

// Module-level orchestrator — created once in `registerIpcHandlers` so every
// IPC channel shares the same ReAct loop and in-flight workflow map.
let orchestrator: AgentOrchestrator;
// Singleton RAG indexer shared by the standalone RAG panel and the scope
// auto-indexer so they write to the same chunk store.
// Resolved LAZILY (not at module load): handlers.ts is imported before
// main.ts applies the QA profile override, so capturing the indexer here
// would bind it to the DEFAULT userData path and write index files
// outside an isolated profile. getDefaultRagIndexer() memoizes on first
// real use, by which time app.setPath('userData') has run.
const ragIndexer = { buildIndex: (id: string, dir: string) => getDefaultRagIndexer().buildIndex(id, dir) };

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
      // Cap the request body. This bridge binds to 127.0.0.1 (localhost-only), so
      // the exposure is lower than the LAN /chat route, but an unbounded body
      // could still OOM the process. Tool-invocation args can legitimately carry
      // more than a chat message (a path + content for fs_write, a doc body), so
      // the ceiling is a generous 1 MB rather than 256 KB.
      // Buffer raw chunks and decode ONCE: `body += chunk` decodes each Buffer to
      // UTF-8 independently (corrupting a multibyte char split across a chunk
      // boundary), and `.length` counts UTF-16 units, not bytes.
      const MAX_MCP_BODY = 1024 * 1024;
      const bodyChunks: Buffer[] = [];
      let bodyBytes = 0;
      let bodyAborted = false;
      req.on('data', (chunk: Buffer) => {
        if (bodyAborted) return;
        bodyBytes += chunk.length;
        if (bodyBytes > MAX_MCP_BODY) {
          bodyAborted = true;
          json(413, { error: 'Request body too large.' });
          req.destroy();
          return;
        }
        bodyChunks.push(chunk);
      });
      req.on('end', async () => {
        if (bodyAborted) return;
        const body = Buffer.concat(bodyChunks).toString('utf8');
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
// getRawLicenseKey/currentEntitlements live in ../license/current (imported
// above) so tool modules — e.g. the docs tool's free-tier document cap — can
// consult entitlements without importing this Electron-heavy module.

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
    // Fail CLOSED: with no keys registered there is no way to authenticate, so
    // deny every request rather than granting open admin access. startLanServer
    // refuses to bind until at least one key exists, so this branch is the
    // belt-and-braces case (e.g. all keys revoked while the server is running).
    if (keys.length === 0) return null;
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

// Per-client throttle on the expensive /chat route (each call runs a full agent
// turn). Burst of 5, then ~1 request every 12s sustained, keyed by client IP.
const lanChatLimiter = createRateLimiter(5, 1 / 12);

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
  // Gate: solo tiers may NOT bind the LAN port. This is the central
  // solo→Team monetisation wall; the persona-onboarding flow paints a clear
  // upgrade CTA when this error string surfaces in the UI.
  const ents = currentEntitlements();
  if (!ents.lanServer) {
    return {
      running: false,
      url: null,
      localIp: null,
      error: 'The LAN/team server requires a Team or Business license. Apply a license in Settings → License.',
    };
  }
  // Fail CLOSED: the server binds 0.0.0.0 (reachable by every device on the
  // network), so it must require authentication. Refuse to start until the user
  // has created at least one API key, rather than exposing an open agent.
  const enabledKeys = (getDb().prepare(`SELECT COUNT(*) AS n FROM api_keys WHERE is_enabled=1`).get() as { n: number }).n;
  if (enabledKeys === 0) {
    return {
      running: false,
      url: null,
      localIp: null,
      error: 'The LAN server needs an API key for authentication. Create one in Settings → API Keys, then start the server. (Anyone on your network can reach it, so it must be locked down.)',
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

    // License guard on every non-health request: an annual Team key that
    // expires while the hub is running must stop serving within one request
    // (getEntitlements re-checks expiry on cache hits, so this is one integer
    // comparison in the common case).
    if (!currentEntitlements().lanServer) {
      json(403, { error: 'The hub license has expired or was removed. Ask the hub admin to renew it in Settings → License.' });
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

    // Shared context packs — the hub's curated context sets teammates can
    // apply to their /chat runs via { packId }. Only is_shared=1 packs are
    // listed; scope paths are hub-local by design (the run executes here).
    if (req.method === 'GET' && url.pathname === '/packs') {
      json(200, describeSharedPacks());
      return;
    }

    if (req.method === 'POST' && url.pathname === '/chat') {
      // Rate-limit per authenticated identity — one /chat = one full agent run,
      // so an unthrottled caller could exhaust CPU or run up cloud-model spend.
      // Keying by member id (not just IP) means one teammate can't DoS the
      // server from rotating/spoofed source addresses on a shared LAN.
      const clientIp = req.socket.remoteAddress ?? 'unknown';
      const limitKey = identity.memberId ?? `ip:${clientIp}`;
      if (!lanChatLimiter.take(limitKey)) {
        json(429, { error: 'Too many requests. Slow down and retry shortly.' });
        return;
      }
      // Cap the request body. A /chat payload is just a short text message, so a
      // 256 KB ceiling is generous — without it an (authenticated) client could
      // stream an unbounded body and OOM the single-process LAN server. Buffer
      // the raw chunks and decode ONCE at the end: `body += chunk` would decode
      // each Buffer to UTF-8 independently and corrupt any multibyte character
      // split across a chunk boundary, and `.length` would measure UTF-16 units
      // rather than bytes (under-counting CJK/emoji payloads against the cap).
      const MAX_CHAT_BODY = 256 * 1024;
      const bodyChunks: Buffer[] = [];
      let bodyBytes = 0;
      let bodyAborted = false;
      req.on('data', (chunk: Buffer) => {
        if (bodyAborted) return;
        bodyBytes += chunk.length;
        if (bodyBytes > MAX_CHAT_BODY) {
          bodyAborted = true;
          json(413, { error: 'Request body too large.' });
          req.destroy();
          return;
        }
        bodyChunks.push(chunk);
      });
      req.on('end', async () => {
        if (bodyAborted) return;
        const body = Buffer.concat(bodyChunks).toString('utf8');
        const db = getDb();
        let sid: string;
        try {
          const parsed = JSON.parse(body || '{}') as { message?: string; sessionId?: string; packId?: string };
          if (!parsed.message) { json(400, { error: 'Request body must include a "message" field.' }); return; }

          // Optional shared context pack. Validated BEFORE any writes so a bad
          // id is a clean 400: the pack must exist AND be shared — the
          // is_shared re-check here means un-sharing wins any race with a
          // client that listed the pack earlier.
          if (parsed.packId) {
            const pack = db.prepare(`SELECT pack_id, is_shared FROM context_packs WHERE pack_id=?`)
              .get(parsed.packId) as { pack_id: string; is_shared: number } | undefined;
            if (!pack || !pack.is_shared) {
              json(400, { error: 'Unknown or non-shared pack id.' });
              return;
            }
          }

          sid = parsed.sessionId ?? '';
          if (!sid) {
            sid = crypto.randomUUID();
            db.prepare(`INSERT INTO chat_sessions (session_id, title) VALUES (?, ?)`).run(sid, `LAN: ${parsed.message.slice(0, 40)}`);
          }

          res.writeHead(200, { 'Content-Type': 'application/x-ndjson', 'Transfer-Encoding': 'chunked' });

          // Apply the pack AFTER the headers: warnings (missing paths, deleted
          // skill/pins) stream as a `meta` NDJSON line rather than failing the
          // request — same degrade-gracefully semantics as the desktop. The
          // run then picks up the pack's skill + SHARED pins through the
          // normal getPackForSession path (pins are is_shared-filtered on LAN).
          if (parsed.packId) {
            const { warnings } = applyPackToSession(parsed.packId, sid);
            if (warnings.length) {
              res.write(JSON.stringify({ type: 'meta', content: `Pack applied with warnings: ${warnings.join(' ')}` }) + '\n');
            }
          }
          // Snapshot the max rowid before the run so we can retrieve only the
          // new agent messages afterwards (the orchestrator streams to the
          // desktop UI but writes final messages to the DB synchronously).
          const before = (db.prepare(`SELECT COALESCE(MAX(rowid), 0) AS m FROM messages WHERE session_id=?`).get(sid) as { m: number }).m;

          // Bind the run to the calling teammate's identity so tool-audit rows
          // are attributable and memory visibility is restricted to shared-only
          // (a LAN run must never see the host's private memories).
          const actor = identity.memberName ?? identity.memberId ?? 'lan:unknown';
          const message = parsed.message;
          await runWithContext({ actor, lan: true }, () =>
            orchestrator.handleMessage(sid, message, []),
          );

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
  ipcMain.handle('agent:sendMessage', async (_e, sessionId: string, content: string, attachments?: { name: string; mime: string; data: string }[], opts?: { modelOverride?: string }) => {
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

    await orchestrator.handleMessage(sessionId, content, attachments, opts ?? {});
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

  // Most marketplace connectors launch via `npx`, which needs Node.js on PATH.
  // The Marketplace uses this to warn (with a fix) before an install fails with
  // a cryptic spawn error.
  ipcMain.handle('system:checkRuntime', async () => {
    const { execFile } = await import('child_process');
    const { promisify } = await import('util');
    const execFileAsync = promisify(execFile);
    const finder = process.platform === 'win32' ? 'where' : 'which';
    // Search the SAME augmented PATH the MCP server spawn uses, so the banner
    // never claims Node is missing when a connector would actually launch fine.
    const env = spawnEnv();
    const has = async (cmd: string) => {
      try { const { stdout } = await execFileAsync(finder, [cmd], { env }); return !!stdout.trim(); }
      catch { return false; }
    };
    return { node: await has('node'), npx: await has('npx') };
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

  // Per-tool-call approval (policy `confirm` tier). The renderer answers the
  // `agent:toolApprovalRequest` event with the user's decision.
  ipcMain.handle('agent:respondToolApproval', (_e, approvalId: string, approved: boolean) => {
    orchestrator.respondToolApproval(approvalId, approved);
  });

  // ── Tool-call policies (governance for function calling) ─────────────────
  // CRUD over per-tool trust tiers evaluated before every function call.
  ipcMain.handle('policies:list', () => listPolicies());
  ipcMain.handle('policies:create', (_e, input: PolicyInput) => createPolicy(input));
  ipcMain.handle('policies:update', (_e, policyId: string, patch: Partial<PolicyInput>) => updatePolicy(policyId, patch));
  ipcMain.handle('policies:delete', (_e, policyId: string) => deletePolicy(policyId));

  // ── Verified tool receipts (provenance for function calls) ───────────────
  // Read-only audit views. `listRuns` drives the panel's left list (one row per
  // run); `listByRun` returns every receipt for a chosen run.
  ipcMain.handle('receipts:listRuns', (_e, limit?: number) => listReceiptRuns(limit ?? 50));
  ipcMain.handle('receipts:listByRun', (_e, runId: string) => listReceiptsByRun(runId));

  // ── Delegate ─────────────────────────────────────────────────────────────
  // Goal-driven execution. Creates an isolated Task session, routes the goal to
  // the best-fit capability (Skill) via Bodhi, and runs it to completion through
  // the SAME orchestrator as Chat (silent — Delegate owns its own UI). Returns
  // the final output + any artifacts the run produced. The plan/approval UX
  // lives on the Delegate surface; this endpoint only executes.
  ipcMain.handle('delegate:run', async (_e, goal: string) => {
    const db = getDb();
    const sessionId = crypto.randomUUID();
    const title = `Delegate: ${goal.slice(0, 38)}${goal.length > 38 ? '…' : ''}`;
    // origin='delegate' keeps this task's backing session out of the Chat sidebar.
    db.prepare(`INSERT INTO chat_sessions (session_id, title, origin) VALUES (?, ?, 'delegate')`).run(sessionId, title);
    db.prepare(`INSERT INTO messages (session_id, sender_type, content) VALUES (?, 'user', ?)`).run(sessionId, goal);

    // Route to a capability; fall back to a skill-less "direct" run when none fits.
    const registry = new CapabilityRegistry(SkillRegistry.getInstance());
    const capability = (await registry.select(goal)) ?? {
      id: 'direct', name: 'Artha', description: '', icon: '✨', kind: 'skill' as const, tools: [],
    };
    const executor = new OrchestratorCapabilityExecutor(orchestrator);
    const result = await executor.invoke(capability, goal, { sessionId });

    const files = db.prepare(
      `SELECT name, file_type FROM artifacts WHERE session_id = ? ORDER BY created_at ASC`
    ).all(sessionId) as { name: string; file_type: string }[];

    return {
      runId: result.runId ?? null,
      sessionId,
      status: result.status,
      output: result.output,
      error: result.error ?? null,
      capability: capability.id,
      files: files.map(f => ({ name: f.name, kind: f.file_type })),
    };
  });

  // The step trace for a Task — lets the Delegate timeline reflect real progress
  // (and supports resuming/observing a run after a reload).
  ipcMain.handle('delegate:steps', (_e, runId: string) => getTaskSteps(runId));

  // Non-blocking start: create the Task session, route to a capability, kick the
  // run off in the background, and return the run id immediately. The renderer
  // polls `delegate:status` instead of blocking on the whole run — so long tasks
  // are observable (and don't hang the UI at "reviewing").
  ipcMain.handle('delegate:start', async (_e, goal: string) => {
    const db = getDb();
    const sessionId = crypto.randomUUID();
    const title = `Delegate: ${goal.slice(0, 38)}${goal.length > 38 ? '…' : ''}`;
    // origin='delegate' keeps this task's backing session out of the Chat sidebar.
    db.prepare(`INSERT INTO chat_sessions (session_id, title, origin) VALUES (?, ?, 'delegate')`).run(sessionId, title);
    db.prepare(`INSERT INTO messages (session_id, sender_type, content) VALUES (?, 'user', ?)`).run(sessionId, goal);

    // Delegate runs in Operator mode: instead of advising, the agent ACTS — it
    // drives the browser, hands control back for login when needed, and finishes
    // the task itself. We always inject the operator playbook (granting full tool
    // access) and fold in any matched capability's task-specific playbook
    // underneath it.
    const registry = new CapabilityRegistry(SkillRegistry.getInstance());
    const capability = await registry.select(goal);
    let taskPlaybook: { name: string; instructions: string } | null = null;
    if (capability?.skillSlug) {
      const resolved = (await SkillRegistry.getInstance().resolve(`/${capability.skillSlug}`)).skill;
      if (resolved) taskPlaybook = { name: resolved.name, instructions: resolved.instructions };
    }
    const skill = buildOperatorSkill(taskPlaybook);

    const runId = orchestrator.startCapability({ sessionId, goal, skill });
    return { runId, sessionId, capability: capability?.id ?? 'delegate-operator' };
  });

  // Poll a running Task: maps the Task status to a Delegate-facing state, and
  // once terminal returns the final agent message + any artifacts produced.
  ipcMain.handle('delegate:status', (_e, runId: string, sessionId: string) => {
    const task = getTask(runId);
    const raw = task?.status ?? 'running';
    const status: 'running' | 'completed' | 'failed' =
      raw === 'completed' ? 'completed' : (raw === 'failed' || raw === 'cancelled') ? 'failed' : 'running';
    const stepCount = getTaskSteps(runId).length;

    let output = '';
    let files: { name: string; kind: string }[] = [];
    if (status !== 'running') {
      const row = getDb()
        .prepare(`SELECT content FROM messages WHERE session_id = ? AND sender_type = 'agent' ORDER BY rowid DESC LIMIT 1`)
        .get(sessionId) as { content: string } | undefined;
      output = row?.content ?? '';
      files = (getDb()
        .prepare(`SELECT name, file_type FROM artifacts WHERE session_id = ? ORDER BY created_at ASC`)
        .all(sessionId) as { name: string; file_type: string }[])
        .map((f) => ({ name: f.name, kind: f.file_type }));
    }
    return { status, output, files, stepCount };
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
      `SELECT project_id, name, root_path, rag_index_id, summary, default_skill_id, created_at
       FROM projects ORDER BY created_at DESC`
    ).all();
  });

  /** Single project lookup — used by the project home view + `@project`
   *  resolution. Returns null if the id is unknown. */
  ipcMain.handle('projects:get', (_e, projectId: string) => {
    return getDb().prepare(
      `SELECT project_id, name, root_path, rag_index_id, summary, default_skill_id, created_at
       FROM projects WHERE project_id=?`
    ).get(projectId) ?? null;
  });

  /** User-edited project summary ("Project memory"). Same 4000-char cap as the
   *  LLM-maintained rolling summary (orchestrator.updateProjectSummary), which
   *  keeps merging user edits with new sessions afterwards. */
  ipcMain.handle('projects:updateSummary', (_e, projectId: string, summary: string) => {
    const text = String(summary ?? '').trim().slice(0, 4000);
    const info = getDb().prepare(
      `UPDATE projects SET summary=? WHERE project_id=?`
    ).run(text || null, projectId);
    return info.changes > 0;
  });

  /** Per-project default skill — auto-activated in this project's chats when
   *  no explicit /slug or auto-match fires (see orchestrator.handleMessage).
   *  null clears the default. The id is not FK-validated: a later-deleted
   *  skill simply stops resolving (getById miss → no skill). */
  ipcMain.handle('projects:setDefaultSkill', (_e, projectId: string, skillId: string | null) => {
    const info = getDb().prepare(
      `UPDATE projects SET default_skill_id=? WHERE project_id=?`
    ).run(skillId, projectId);
    return info.changes > 0;
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

  /**
   * Open-source notices — the bundled `THIRD-PARTY-NOTICES.md`. Referenced by
   * the Terms of Service ("available within the application"), so it must load
   * fully offline: no network, read straight off disk.
   *
   * Packaged: electron-builder copies the file into `process.resourcesPath`
   * (see `extraResources` in the root package.json). Dev: it lives at the repo
   * root. Because dev launches Electron with a direct file path
   * (`electron packages/app/dist/main.js`), `app.getAppPath()` is not a
   * reliable pointer to the root, so we probe the likely locations and return
   * the first that reads. Returns `null` if none exist, so the UI degrades to
   * the GitHub link rather than throwing.
   */
  ipcMain.handle('system:openSourceNotices', () => {
    const fs = require('fs') as typeof import('fs');
    const FILE = 'THIRD-PARTY-NOTICES.md';
    const candidates = [
      path.join(process.resourcesPath, FILE),        // packaged (extraResources)
      path.join(app.getAppPath(), FILE),             // app root when it resolves
      path.join(__dirname, '..', '..', '..', '..', FILE), // dev: dist/ipc → repo root
      path.join(process.cwd(), FILE),                // dev launched from repo root
    ];
    for (const p of candidates) {
      try {
        return fs.readFileSync(p, 'utf-8');
      } catch {
        /* try next candidate */
      }
    }
    return null;
  });

  /** Sessions belonging to one project (or `null` for general/no-project).
   *  Drives the Project home page's "Recent chats" list. Same shape as
   *  `sessions:list` for a drop-in render. */
  ipcMain.handle('sessions:listByProject', (_e, projectId: string | null) => {
    const db = getDb();
    if (projectId === null || projectId === undefined) {
      return db.prepare(`SELECT * FROM chat_sessions WHERE project_id IS NULL AND COALESCE(origin,'chat')='chat' ORDER BY last_activity DESC`).all();
    }
    return db.prepare(`SELECT * FROM chat_sessions WHERE project_id=? AND COALESCE(origin,'chat')='chat' ORDER BY last_activity DESC`).all(projectId);
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
      `SELECT project_id, name, root_path, rag_index_id, summary, default_skill_id, created_at
       FROM projects WHERE project_id=?`
    ).get(projectId) ?? null;
  });

  // Delete a project WITHOUT destroying the user's conversations. Neither
  // chat_sessions.project_id nor memory_entities.project_id has a foreign key
  // to projects, so a bare DELETE would leave them dangling (invisible but
  // still on disk). Instead we detach them — reassigning project_id to NULL
  // moves the chats and scoped memories into the "General" (no-project) bucket
  // so removing a project never loses work. The auto-built RAG index is derived
  // data (rebuildable from the folder) and left as-is. Wrapped in a transaction
  // so a project is never half-deleted. Returns the count of chats that were
  // moved to General, so the renderer can tell the user where they went.
  ipcMain.handle('projects:delete', (_e, projectId: string) => {
    const db = getDb();
    const detachAndDelete = db.transaction((pid: string) => {
      const moved = db.prepare(
        `UPDATE chat_sessions SET project_id=NULL WHERE project_id=?`
      ).run(pid).changes;
      db.prepare(`UPDATE memory_entities SET project_id=NULL WHERE project_id=?`).run(pid);
      db.prepare(`DELETE FROM projects WHERE project_id=?`).run(pid);
      return moved;
    });
    return { movedChats: detachAndDelete(projectId) };
  });

  // ── Sessions ───────────────────────────────────────────────────────────
  ipcMain.handle('sessions:list', () => {
    // Exclude Delegate task sessions — they're an execution backing store, not chats.
    return getDb().prepare(`SELECT * FROM chat_sessions WHERE COALESCE(origin,'chat')='chat' ORDER BY last_activity DESC`).all();
  });

  ipcMain.handle('sessions:create', (_e, projectId?: string | null) => {
    const db = getDb();
    const id = crypto.randomUUID();
    db.prepare(`INSERT INTO chat_sessions (session_id, project_id) VALUES (?, ?)`).run(id, projectId ?? null);
    return { session_id: id, title: 'New Chat', project_id: projectId ?? null };
  });

  // Permanently delete a chat. Deleting the chat_sessions row cascades (via the
  // schema's ON DELETE CASCADE foreign keys, with PRAGMA foreign_keys=ON) to its
  // messages, session_scopes, and agent_states — so the conversation and all of
  // its history are fully removed from disk. Artifacts are preserved (their
  // session_id is set to NULL). Irreversible: there is no soft-delete/undo.
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

  // Rename a chat. Used by the contextual chat header's inline title editor.
  // Title is trimmed and length-capped; an empty title falls back to 'New Chat'.
  ipcMain.handle('sessions:rename', (_e, sessionId: string, title: string) => {
    const clean = (title ?? '').trim().slice(0, 120) || 'New Chat';
    getDb().prepare(`UPDATE chat_sessions SET title=? WHERE session_id=?`).run(clean, sessionId);
    return clean;
  });

  // ── Runs (Activity hub) ──────────────────────────────────────────────────
  // Recent agent runs across ALL sessions — drives the Workflows ▸ Runs activity
  // list. Joins receipt counts + the backing session's title/origin so a run
  // reads as "what it was for". Delegate/scheduled runs are included (their
  // sessions carry origin != 'chat'), which is exactly the background work the
  // transient working-indicator could never surface after the fact.
  ipcMain.handle('runs:listRecent', (_e, limit?: number) => {
    return getDb().prepare(`
      SELECT ar.run_id, ar.session_id, ar.workflow_id, ar.goal, ar.status, ar.model,
             ar.parent_run_id, ar.created_at,
             IFNULL(cs.title, '')  AS session_title,
             IFNULL(cs.origin, 'chat') AS session_origin,
             (SELECT COUNT(*) FROM tool_receipts tr WHERE tr.run_id = ar.run_id) AS calls,
             (SELECT COUNT(*) FROM tool_receipts tr WHERE tr.run_id = ar.run_id AND tr.is_mutation = 1) AS mutations
      FROM agent_runs ar
      LEFT JOIN chat_sessions cs ON cs.session_id = ar.session_id
      ORDER BY ar.created_at DESC
      LIMIT ?
    `).all(Math.min(limit ?? 60, 300));
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
  // findOrCreateFolderWorkspace moved to db/scopes.ts (imported above) so
  // Context Packs and the scope handlers share the same dedupe + auto-index.

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

  /** Copy every scope of one chat into another ("Continue with context").
   *  Folders go through findOrCreateFolderWorkspace so they carry a LIVE rag
   *  index id (the source row's may be stale); files copy as-is. UNIQUE
   *  violations (already attached — e.g. the shared project root) are
   *  skipped, so this merges rather than duplicates. Returns the target's
   *  full scope list. The caller should have attached the project root FIRST
   *  (createChat does) so recomputePrimaryProject keeps it as the primary. */
  ipcMain.handle('scopes:copyFrom', (_e, fromSessionId: string, toSessionId: string) => {
    if (!fromSessionId || !toSessionId || fromSessionId === toSessionId) {
      return getSessionScopes(toSessionId);
    }
    const db = getDb();
    for (const s of getSessionScopes(fromSessionId)) {
      const scopeId = crypto.randomUUID();
      try {
        if (s.kind === 'folder') {
          const { ragIndexId } = findOrCreateFolderWorkspace(s.path);
          db.prepare(`INSERT INTO session_scopes (scope_id, session_id, path, kind, rag_index_id) VALUES (?,?,?,?,?)`)
            .run(scopeId, toSessionId, s.path, 'folder', ragIndexId);
        } else {
          db.prepare(`INSERT INTO session_scopes (scope_id, session_id, path, kind) VALUES (?,?,?,?)`)
            .run(scopeId, toSessionId, s.path, 'file');
        }
      } catch { /* UNIQUE(session_id, path) — already attached, skip */ }
    }
    recomputePrimaryProject(toSessionId);
    return getSessionScopes(toSessionId);
  });

  // ── Context Packs ────────────────────────────────────────────────────────
  // Named, reusable context sets (scopes + skill + pinned memories). Logic in
  // agent/contextPacks.ts; these handlers are thin pass-throughs.
  ipcMain.handle('packs:list', () => listPacks());
  ipcMain.handle('packs:save', (_e, sessionId: string, name: string, overrides?: { skillId?: string | null; memoryIds?: string[] }) => {
    // Free-tier cap on SAVED packs (maxContextPacks; null = unlimited).
    // Applying/detaching existing packs is never gated.
    const ents = currentEntitlements();
    if (ents.maxContextPacks !== null) {
      const count = (getDb().prepare(`SELECT COUNT(*) AS n FROM context_packs`).get() as { n: number }).n;
      if (count >= ents.maxContextPacks) {
        throw new Error(`The Free plan includes ${ents.maxContextPacks} saved context pack${ents.maxContextPacks === 1 ? '' : 's'}. Delete one first, or upgrade to Personal for unlimited packs — artha.space.`);
      }
    }
    return savePackFromSession(sessionId, name, overrides ?? {});
  });
  ipcMain.handle('packs:apply', (_e, packId: string, sessionId: string) =>
    applyPackToSession(packId, sessionId));
  ipcMain.handle('packs:get', (_e, sessionId: string) => getPackForSession(sessionId));
  ipcMain.handle('packs:detach', (_e, sessionId: string) => { detachPackFromSession(sessionId); return true; });
  ipcMain.handle('packs:delete', (_e, packId: string) => { deletePack(packId); return true; });
  /** Toggle LAN sharing. Gated on ENABLE only — un-sharing is always allowed
   *  (mirrors memory:setShared), so a downgraded license can still lock
   *  things back down. */
  ipcMain.handle('packs:setShared', (_e, packId: string, shared: boolean) => {
    if (shared && !currentEntitlements().sharedPacks) {
      throw new Error('Shared context packs require a Team or Business license.');
    }
    setPackShared(packId, shared);
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
      // Keep the non-PII Sentry tag in sync with live reachability (seeded once
      // at launch; this refreshes it whenever the renderer re-probes).
      setOllamaConnectedTag(res.ok);
      return res.ok;
    } catch {
      setOllamaConnectedTag(false);
      return false;
    }
  });

  // Model-startup status (server start + warm). The renderer's startup banner
  // reads this on mount, then live-updates via the `model:status` event the
  // launch path emits.
  ipcMain.handle('model:getStatus', () => getModelStatus());
  // Re-trigger ensure (onboarding "retry" / first run). Streams progress via
  // the same `model:status` event used at launch.
  ipcMain.handle('model:ensure', async () => {
    // Return THIS run's terminal status, not the shared last-writer value —
    // a concurrent launch-time run would otherwise mask a failed start.
    return ensureModelReady((s) => safeSend('model:status', s));
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
      /** Set when any streamed line carries an error — Ollama does not use a
       *  non-200 status for pull failures. */
      let streamError: string | null = null;
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
            if (obj.error) streamError = obj.error;
            emit({ name, status: obj.status ?? 'pulling', completed: obj.completed, total: obj.total, percent, error: obj.error });
          } catch { /* skip partial line */ }
        }
      }

      // Ollama returns HTTP 200 and reports failures as an {"error": …} LINE,
      // then ends the stream normally. This used to fall through to an
      // unconditional success — so a bad tag / 404 manifest / full disk
      // finished onboarding with a broken active model (audit C1).
      if (streamError) {
        emit({ name, status: 'error', error: streamError });
        return false;
      }
      // Don't take the stream's word for it: confirm the tag actually exists.
      try {
        const tags = await fetch('http://localhost:11434/api/tags');
        const json = await tags.json() as { models?: { name: string }[] };
        const present = (json.models ?? []).some(
          m => m.name === name || m.name.startsWith(`${name}:`) || name.startsWith(`${m.name}:`)
        );
        if (!present) {
          emit({ name, status: 'error', error: 'The download finished but the model is not installed. Try again.' });
          return false;
        }
      } catch {
        emit({ name, status: 'error', error: 'Could not confirm the model was installed.' });
        return false;
      }
      emit({ name, status: 'success', percent: 100 });
      return true;
    } catch (err) {
      emit({ name, status: 'error', error: err instanceof Error ? err.message : String(err) });
      return false;
    }
  });

  // Uninstall a local Ollama model — frees the on-disk blobs via Ollama's
  // DELETE /api/delete, then drops any matching llm_models row so a model the
  // user pulled from the catalog can be fully removed from inside the app.
  // (Counterpart to llm:pullModelStream; llm:removeModel only touches the DB.)
  ipcMain.handle('llm:deleteModel', async (_e, name: string) => {
    try {
      const res = await fetch('http://localhost:11434/api/delete', {
        method: 'DELETE',
        body: JSON.stringify({ name }),
      });
      // 404 means Ollama no longer has it — treat as already-gone, not a failure.
      if (!res.ok && res.status !== 404) {
        return { ok: false, error: `Ollama responded ${res.status}` };
      }
      // Clean up the DB row (active flag included) so the model fully
      // disappears — and any in-memory session key with it (L1).
      const row = getDb().prepare(`SELECT model_id FROM llm_models WHERE ollama_name=?`).get(name) as { model_id: string } | undefined;
      getDb().prepare(`DELETE FROM llm_models WHERE ollama_name=?`).run(name);
      if (row) deleteSessionKey(row.model_id);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
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
    // Keep runtime status honest across switches (clears no_model, warms a
    // newly-activated local model, goes quiet for cloud) — M4/M5.
    void ensureModelReady((s) => safeSend('model:status', s));
    return true;
  });

  // Provider preset registry — static data (llm/providerPresets.ts); the
  // renderer renders whatever this returns, so new providers ship data-only.
  ipcMain.handle('llm:listProviderPresets', () => PROVIDER_PRESETS);

  // Resolve key + TARGET for a probe. Two modes, deliberately asymmetric:
  //   - apiKey (pre-save): the renderer supplies both URL and the key it
  //     already holds — nothing stored is at stake.
  //   - modelId (saved row): the key resolves main-side AND the base URL is
  //     taken from the ROW, never from the renderer. Otherwise a compromised
  //     renderer could pair a saved key with an attacker URL and exfiltrate
  //     it through the main process (security review H1).
  const probeTarget = (opts: { baseUrl?: string; apiKey?: string; modelId?: string }):
    { baseUrl?: string; key?: string; error?: string } => {
    if (opts.modelId) {
      const row = getDb().prepare(`SELECT model_id, base_url, api_key FROM llm_models WHERE model_id=?`)
        .get(opts.modelId) as { model_id: string; base_url: string; api_key: string | null } | undefined;
      if (!row) return { error: 'Model not found.' };
      try {
        return { baseUrl: row.base_url, key: usableApiKey(getDb(), row.model_id, row.api_key) };
      } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) };
      }
    }
    if (!opts.baseUrl?.trim()) return { error: 'Base URL is required.' };
    return { baseUrl: opts.baseUrl, key: opts.apiKey };
  };

  // The default execution profile (v0: mode + reserved slots; is_active on
  // llm_models remains authoritative for model choice until Phase B routing).
  ipcMain.handle('llm:getExecutionProfile', () => getDefaultProfile(getDb()) ?? null);

  // Do semantic features (memory ranking / RAG vectors) actually work right
  // now? Drives the honest degraded-state notices instead of silent
  // zero-vector indexes and keyword-only memory.
  ipcMain.handle('llm:semanticStatus', () => getSemanticStatus());

  // Effective capabilities for a provider (static registry ⊕ runtime probes).
  ipcMain.handle('llm:getCapabilities', (_e, opts: { capabilityKey: string; model?: string }) =>
    getEffectiveCapabilities(opts.capabilityKey, opts.model));

  // Model discovery (GET /v1/models) with normalized, key-free errors.
  ipcMain.handle('llm:discoverModels', async (_e, opts: { baseUrl?: string; apiKey?: string; modelId?: string }) => {
    const t = probeTarget(opts);
    if (t.error || !t.baseUrl) return { ok: false, error: { kind: 'auth', retryable: false, message: t.error ?? 'Base URL is required.' } };
    return discoverModels(t.baseUrl, t.key);
  });

  // One cheap completion proving base URL + key + model work together.
  ipcMain.handle('llm:testConnection', async (_e, opts: { baseUrl?: string; apiKey?: string; modelId?: string; model: string }) => {
    const t = probeTarget(opts);
    if (t.error || !t.baseUrl) return { ok: false, error: { kind: 'auth', retryable: false, message: t.error ?? 'Base URL is required.' } };
    return testConnection(t.baseUrl, t.key, opts.model);
  });

  // ── Cloud models (BYOK, opt-in) ──────────────────────────────────────────
  // Cloud providers are just llm_models rows with a non-local base_url + key.
  // The API key is stored in the local SQLite DB and only ever sent to the
  // provider the user explicitly configured. Local Ollama stays the default;
  // nothing here is enabled unless the user adds and activates a cloud model.
  ipcMain.handle('llm:listConfigured', () => {
    // key_state is DERIVED — the api_key value itself never reaches the
    // renderer. 'session' downgrades to 'session_expired' when the in-memory
    // key died with a previous process (honest re-enter state).
    const rows = getDb().prepare(
      `SELECT model_id, name, ollama_name, base_url, provider, context_window, is_active,
              CASE
                WHEN api_key IS NULL OR api_key = '' OR api_key = 'ollama' THEN 'none'
                WHEN api_key LIKE 'v1:enc:%' THEN 'sealed'
                WHEN api_key = '${SESSION_SENTINEL}' THEN 'session'
                ELSE 'locked'
              END AS key_state
       FROM llm_models ORDER BY added_at DESC`
    ).all() as ({ model_id: string; key_state: string } & Record<string, unknown>)[];
    return rows.map(r =>
      r.key_state === 'session' && !getSessionKey(r.model_id)
        ? { ...r, key_state: 'session_expired' }
        : r
    );
  });

  ipcMain.handle('llm:addCloudModel', (_e, m: {
    provider: string; label: string; model: string; baseUrl: string; apiKey: string;
    activate?: boolean; persistence?: 'session';
  }) => {
    const db = getDb();
    const secure = isSecretEncryptionAvailable();
    // Credential policy (Commit 3.5): a key is persisted ONLY keychain-sealed.
    // With no trustworthy keychain, the caller must explicitly opt into
    // session-only (in-memory, gone on restart) — otherwise refuse with
    // remediation. Base64/plaintext persistence does not exist anymore.
    // A BLANK key (keyless providers: remote Ollama, custom endpoints) has
    // nothing to protect — no gate, no sealing, no session mode (H3).
    const hasKey = !!m.apiKey?.trim();
    const sessionOnly = hasKey && m.persistence === 'session';
    if (hasKey && !secure && !sessionOnly) {
      return { error: 'secure_storage_unavailable' as const, message: new SecureStorageUnavailableError().message };
    }
    const storedKey = !hasKey ? '' : sessionOnly ? SESSION_SENTINEL : sealSecretString(m.apiKey);
    const existing = db.prepare(`SELECT model_id, provider, base_url FROM llm_models WHERE ollama_name=?`)
      .get(m.model) as { model_id: string; provider?: string; base_url?: string } | undefined;
    // Never silently convert an installed LOCAL model's row into a remote one
    // just because the names collide (L2) — refuse with a clear message.
    if (existing && isOllamaManaged(existing.provider, existing.base_url)) {
      return {
        error: 'name_conflict' as const,
        message: `"${m.model}" is already an installed local model. Use a different name/tag for the remote entry.`,
      };
    }
    const id = existing?.model_id ?? crypto.randomUUID();
    if (existing) {
      db.prepare(`UPDATE llm_models SET name=?, base_url=?, api_key=?, provider=? WHERE model_id=?`)
        .run(m.label || m.model, m.baseUrl, storedKey, m.provider, id);
    } else {
      db.prepare(`INSERT INTO llm_models (model_id, name, ollama_name, base_url, api_key, provider, is_active)
                  VALUES (?,?,?,?,?,?,0)`)
        .run(id, m.label || m.model, m.model, m.baseUrl, storedKey, m.provider);
    }
    if (sessionOnly) setSessionKey(id, m.apiKey);
    if (m.activate) {
      db.prepare(`UPDATE llm_models SET is_active=0`).run();
      db.prepare(`UPDATE llm_models SET is_active=1 WHERE model_id=?`).run(id);
      // Refresh the runtime status so a lingering no_model banner clears and
      // lifecycle state matches the new active model (M4/M5).
      void ensureModelReady((s) => safeSend('model:status', s));
    }
    return { model_id: id, persistence: sessionOnly ? ('session' as const) : ('persistent' as const) };
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
    void ensureModelReady((s) => safeSend('model:status', s)); // M4/M5
    return true;
  });

  ipcMain.handle('llm:removeModel', (_e, modelId: string) => {
    getDb().prepare(`DELETE FROM llm_models WHERE model_id=?`).run(modelId);
    deleteSessionKey(modelId); // drop any in-memory session key with the row
    return true;
  });

  // ── MCP ────────────────────────────────────────────────────────────────
  // Never SELECT *: that would return the encrypted credentials blob to the
  // renderer. Expose an explicit column list plus a derived `has_credentials`
  // boolean so the UI can show a "configured" state without ever seeing secrets.
  ipcMain.handle('mcp:listTools', () => {
    return getDb().prepare(
      `SELECT tool_id, name, description, schema_json, mcp_server_uri,
              permissions_json, is_enabled, installed_at, conn_status, conn_error,
              (credentials_enc IS NOT NULL) AS has_credentials
         FROM tools ORDER BY name ASC`
    ).all();
  });

  // Recount installed MCP servers and refresh the non-PII Sentry tag so errors
  // can be correlated with how many servers the user has configured. The tag is
  // seeded at launch (initSentry); this keeps it current as servers come/go.
  const refreshMcpServerCountTag = () => {
    const n = (getDb().prepare(
      `SELECT COUNT(*) AS n FROM tools WHERE mcp_server_uri IS NOT NULL`
    ).get() as { n: number } | undefined)?.n ?? 0;
    setMcpServerCountTag(n);
  };

  // One secret the renderer collected at install time. `kind` mirrors the
  // catalog's credential field shape: 'env' values become environment variables,
  // 'arg' values are appended to the server's command line (defaults to 'env').
  type CredentialInput = { key: string; value: string; kind?: 'env' | 'arg' };

  // Fold the renderer's flat credential list (plus any env extracted from inline
  // ENV: tokens in the URI) into the {env, args} shape the spawn needs. Blank
  // values are dropped so an untouched optional field doesn't clobber anything.
  // Returns null when nothing usable was supplied.
  const toStoredCredentials = (creds?: CredentialInput[], extraEnv?: Record<string, string>): StoredCredentials | null => {
    const env: Record<string, string> = { ...(extraEnv ?? {}) };
    const args: string[] = [];
    for (const c of creds ?? []) {
      const value = typeof c?.value === 'string' ? c.value.trim() : '';
      if (!c?.key || !value) continue;
      if (c.kind === 'arg') args.push(value);
      else env[c.key] = value;
    }
    const hasEnv = Object.keys(env).length > 0;
    if (!hasEnv && args.length === 0) return null;
    return { env: hasEnv ? env : undefined, args: args.length ? args : undefined };
  };

  // Install accepts either a bare URI string (legacy / no-auth connectors) or
  // `{ uri, credentials }`. Credentials are encrypted at rest (safeStorage) and
  // injected into the server's child process on connect. Secrets can arrive two
  // ways — a structured credentials[] (Marketplace panel) or inline ENV:KEY=value
  // tokens in the URI (MCP Tools panel) — both are normalized into one encrypted
  // store and a CLEAN uri so no plaintext secret is ever written to the DB,
  // returned to the renderer, or exported in a bundle.
  ipcMain.handle('mcp:installServer', async (_e, arg: string | { uri: string; credentials?: CredentialInput[] }) => {
    const db = getDb();
    const rawUri = typeof arg === 'string' ? arg : arg.uri;
    const credInput = typeof arg === 'string' ? undefined : arg.credentials;
    const { cleanUri, env: uriEnv } = parseEnvTokens(rawUri);
    const id = crypto.randomUUID();
    const name = cleanUri.split('/').pop() ?? cleanUri;
    const stored = toStoredCredentials(credInput, uriEnv);
    const sealed = sealCredentials(stored);
    db.prepare(`INSERT INTO tools (tool_id, name, mcp_server_uri, description, credentials_enc) VALUES (?,?,?,?,?)`)
      .run(id, name, cleanUri, `MCP server: ${cleanUri}`, sealed);
    await MCPRegistry.getInstance().connectServer(id, name, cleanUri, stored ?? undefined);
    refreshMcpServerCountTag();
    return { id, name };
  });

  // Update (or clear) the stored credentials for an already-installed server,
  // then reconnect it so the new keys take effect immediately. Passing an empty
  // list clears the credentials.
  ipcMain.handle('mcp:setCredentials', async (_e, toolId: string, creds?: CredentialInput[]) => {
    const db = getDb();
    const row = db.prepare(`SELECT tool_id, name, mcp_server_uri FROM tools WHERE tool_id=?`)
      .get(toolId) as { tool_id: string; name: string; mcp_server_uri: string | null } | undefined;
    if (!row || !row.mcp_server_uri) return { success: false, error: 'Server not found.' };
    const stored = toStoredCredentials(creds);
    const sealed = sealCredentials(stored);
    db.prepare(`UPDATE tools SET credentials_enc=? WHERE tool_id=?`).run(sealed, toolId);
    try {
      await MCPRegistry.getInstance().connectServer(row.tool_id, row.name, row.mcp_server_uri, stored ?? undefined);
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
    return { success: true };
  });

  // Whether secrets are encrypted by the OS keychain on this machine. The
  // install UI surfaces a warning when false (rare — e.g. Linux without a
  // secret-service/keyring), since credentials then fall back to base64 at rest.
  ipcMain.handle('mcp:credentialEncryptionAvailable', () => isAtRestEncryptionAvailable());

  // Which installed servers currently have stored credentials — lets the UI show
  // a "Configured"/"Update keys" affordance without ever returning the secrets.
  ipcMain.handle('mcp:listConfiguredUris', () => {
    const rows = getDb().prepare(
      `SELECT mcp_server_uri FROM tools WHERE mcp_server_uri IS NOT NULL AND credentials_enc IS NOT NULL`
    ).all() as { mcp_server_uri: string }[];
    return rows.map(r => r.mcp_server_uri);
  });

  // Enable/disable must also start/stop the live process — otherwise a "disabled"
  // server keeps running and its tools stay offered to the agent until restart,
  // and an "enabled" one stays dead until restart. (No-op for built-in shim rows
  // with a NULL mcp_server_uri.)
  ipcMain.handle('mcp:toggleTool', async (_e, toolId: string, enabled: boolean) => {
    const db = getDb();
    db.prepare(`UPDATE tools SET is_enabled=? WHERE tool_id=?`).run(enabled ? 1 : 0, toolId);
    const reg = MCPRegistry.getInstance();
    if (!enabled) {
      await reg.disconnectServer(toolId);
      // Reflect the off state so the panel shows "Disabled", not a stale
      // "connected"/"error" badge from the last run.
      db.prepare(`UPDATE tools SET conn_status='disabled', conn_error=NULL WHERE tool_id=?`).run(toolId);
    } else {
      const row = db.prepare(`SELECT tool_id, name, mcp_server_uri, credentials_enc FROM tools WHERE tool_id=?`)
        .get(toolId) as { tool_id: string; name: string; mcp_server_uri: string | null; credentials_enc: string | null } | undefined;
      if (row?.mcp_server_uri) {
        try {
          await reg.connectServer(row.tool_id, row.name, row.mcp_server_uri, openCredentials(row.credentials_enc));
        } catch (err) {
          console.error(`[MCP] Re-enable failed for ${row.name}:`, err);
        }
      }
    }
    return true;
  });

  // Remove must disconnect first so the child process is killed (it holds the
  // connector's credentials in its env) and its tools stop being offered — then
  // delete the row, which also drops the encrypted credentials.
  ipcMain.handle('mcp:removeServer', async (_e, id: string) => {
    await MCPRegistry.getInstance().disconnectServer(id);
    getDb().prepare(`DELETE FROM tools WHERE tool_id=?`).run(id);
    refreshMcpServerCountTag();
    return true;
  });

  // Retry connecting a server that failed (or to pick up a fixed dependency)
  // without re-entering its API key — the stored credentials are reused.
  // connectServer records the new conn_status; we echo success/error inline so
  // the panel can show the latest failure reason immediately.
  ipcMain.handle('mcp:reconnect', async (_e, toolId: string): Promise<{ success: boolean; error?: string }> => {
    const db = getDb();
    const row = db.prepare(`SELECT tool_id, name, mcp_server_uri, credentials_enc FROM tools WHERE tool_id=?`)
      .get(toolId) as { tool_id: string; name: string; mcp_server_uri: string | null; credentials_enc: string | null } | undefined;
    if (!row || !row.mcp_server_uri) return { success: false, error: 'Server not found.' };
    // Make sure a previously-disabled row is enabled again on an explicit retry.
    db.prepare(`UPDATE tools SET is_enabled=1 WHERE tool_id=?`).run(toolId);
    try {
      await MCPRegistry.getInstance().connectServer(row.tool_id, row.name, row.mcp_server_uri, openCredentials(row.credentials_enc));
      return { success: true };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
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
    // Exporting the org-wide audit trail is an Enterprise entitlement. Free/Pro
    // see their own local activity only via the in-app log; the bulk export that
    // backs compliance reporting is gated.
    if (!currentEntitlements().auditExport) {
      throw new Error('Audit log export requires a Business license.');
    }
    return getDb().prepare(
      `SELECT * FROM tool_audit_log ORDER BY ts DESC LIMIT ?`
    ).all(limit);
  });

  // ── Skills ───────────────────────────────────────────────────────────────
  // Named playbooks the agent loads on intent-match or explicit "/slug".
  const skills = SkillRegistry.getInstance();

  ipcMain.handle('skills:list', () => skills.list());
  ipcMain.handle('skills:listEnabled', () => skills.listEnabled());
  // Per-skill usage metrics for the Skills dashboard (runs, success rate, …).
  ipcMain.handle('skills:metrics', () => getSkillMetrics());
  // Insight drill-downs for one skill (model / tools / failures dimensions).
  ipcMain.handle('skills:modelStats', (_e, skillId: string) => getSkillModelStats(skillId));
  ipcMain.handle('skills:toolUsage', (_e, skillId: string) => getSkillToolUsage(skillId));
  ipcMain.handle('skills:failures', (_e, skillId: string, limit?: number) => getSkillFailures(skillId, limit ?? 10));
  // Pin (or clear with null) the model a skill runs on.
  ipcMain.handle('skills:pinModel', (_e, skillId: string, model: string | null) => {
    skills.setPinnedModel(skillId, model);
    return true;
  });
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

  // ── Undo ───────────────────────────────────────────────────────────────
  // Reverse a reversible filesystem action the agent performed (move / copy /
  // create-dir / trash). In-memory, process-lifetime — see agent/undo.ts.
  ipcMain.handle('undo:list', () => listUndoable());
  ipcMain.handle('undo:revert', (_e, id: string) => revert(id));

  // ── Global search ──────────────────────────────────────────────────────
  // One query across chats, memory, and artifacts. `semantic` opts into an
  // embedding re-rank (slower); the palette typeahead uses the fast keyword
  // path. See search/global.ts.
  ipcMain.handle('search:global', (_e, query: string, semantic?: boolean) =>
    globalSearch(query, { semantic: !!semantic }));

  // ── Briefing ───────────────────────────────────────────────────────────
  // Opt-in digest of activity since the user last looked. See briefing/briefing.ts.
  ipcMain.handle('briefing:get', () => getBriefing());
  ipcMain.handle('briefing:markSeen', () => markBriefingSeen());

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

  /** Probe a single model (used right after an install so its Model Fit card
   *  fills in without a full-fleet re-benchmark). */
  ipcMain.handle('router:benchmarkModel', async (_e, name: string) => {
    return benchmarkModel(name, (msg) => safeSend('router:benchmarkProgress', msg));
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

  ipcMain.handle('scheduler:create', (_e, input: TaskInput) => {
    // Scheduled/recurring tasks are a paid-tier convenience (Free is capped
    // solo). Existing tasks keep running for downgraded users until disabled;
    // only CREATING and RE-ENABLING are gated.
    if (!currentEntitlements().scheduler) {
      throw new Error('Scheduled tasks require a Personal (or higher) license — see artha.space for plans.');
    }
    return sched.create(input);
  });

  ipcMain.handle('scheduler:update', (_e, taskId: string, patch: Partial<TaskInput>) =>
    sched.update(taskId, patch));

  ipcMain.handle('scheduler:toggle', (_e, taskId: string, enabled: boolean) => {
    if (enabled && !currentEntitlements().scheduler) {
      throw new Error('Scheduled tasks require a Personal (or higher) license — see artha.space for plans.');
    }
    return sched.toggle(taskId, enabled);
  });

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
      `SELECT entity_id, name, entity_type, content, tags_json, origin, project_id, is_shared, created_at, updated_at
       FROM memory_entities ORDER BY updated_at DESC`
    ).all();
  });

  /** Pin a memory to a project (or unpin with null). Pinning MOVES the memory
   *  out of the global pool — recall filters `project_id IS NULL OR = current`,
   *  so a pinned memory is only injected inside that project's chats. The UI
   *  must communicate this (it's a move, not a copy). */
  ipcMain.handle('memory:setProject', (_e, entityId: string, projectId: string | null) => {
    const db = getDb();
    const info = db.prepare(
      `UPDATE memory_entities SET project_id=?, updated_at=unixepoch() WHERE entity_id=?`
    ).run(projectId, entityId);
    return info.changes > 0;
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

  // ── CRM ─────────────────────────────────────────────────────────────────────
  // The CrmPanel reads/writes the SAME tables (and the same KG projection) the
  // CRM Agent's crm_* tools use — one source of truth, never a parallel store.
  ipcMain.handle('crm:listContacts', () => listContacts(null));
  ipcMain.handle('crm:addContact', (_e, input: { name: string; company?: string; email?: string; title?: string }) => {
    const { contact } = addContact({
      name: input.name, company: input.company ?? null, email: input.email ?? null, title: input.title ?? null,
    });
    return { contact_id: contact.contact_id };
  });
  ipcMain.handle('crm:listInteractions', (_e, contactId: string) => listInteractions(contactId));
  ipcMain.handle('crm:logInteraction', (_e, input: { contactId: string; kind: string; summary: string }) => {
    const i = logInteraction({ contactId: input.contactId, kind: input.kind, summary: input.summary });
    return { interaction_id: i.interaction_id };
  });
  ipcMain.handle('crm:deleteContact', (_e, contactId: string) => deleteContact(contactId));

  // ── Knowledge Graph ─────────────────────────────────────────────────────────
  // Read-mostly views over the general KG engine. The query handler is a thin
  // pass-through to the engine's pure query so the UI and the agent agree.
  ipcMain.handle('kg:listNodes', (_e, filter?: { kind?: string }) => listEntities({ kind: filter?.kind }));
  ipcMain.handle('kg:listEdges', (_e, nodeId?: string) => listRelations(nodeId));
  ipcMain.handle('kg:query', (_e, q: string) => queryGraphDb(String(q ?? '')));

  // ── Bring-Your-Own-Memory (BYOM) ────────────────────────────────────────────
  // Parse a memory export pasted from another AI, review it, then commit. Parse
  // is split from commit so the renderer can show an editable review step first.
  // `provenanceTag` (e.g. 'source:chatgpt') is folded into each entry's tags.
  ipcMain.handle('memory:importPreview', (_e, raw: string, provenanceTag?: string) => {
    return parseMemoryExport(String(raw ?? ''), provenanceTag);
  });

  // AI-assisted parse — uses the active local model, falls back to the heuristic
  // on any failure. Slower; the UI offers it as an opt-in "Refine with AI".
  ipcMain.handle('memory:importRefine', async (_e, raw: string, provenanceTag?: string) => {
    return refineMemoryExport(String(raw ?? ''), provenanceTag);
  });

  // Commit reviewed entries. Returns { created, skipped } (skipped = duplicates).
  ipcMain.handle('memory:import', (_e, entries: ParsedEntry[], origin?: string) => {
    return importMemories(Array.isArray(entries) ? entries : [], origin ?? 'import');
  });

  // Round-trip — emit global memory in the canonical v1 import format.
  ipcMain.handle('memory:export', () => exportMemories());

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
      // OAuth tokens are only ever persisted keychain-sealed. With no
      // trustworthy keychain, refuse up front (before Google is contacted)
      // rather than fail after consent — same policy as BYOK keys.
      if (!isSecretEncryptionAvailable()) {
        return {
          success: false,
          error: 'Secure key storage is unavailable on this system, so Artha can’t save Google sign-in tokens. Enable a system keychain (e.g. GNOME Keyring / KWallet with Secret Service on Linux) and try again.',
        };
      }
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
            ).run(
              // Sealed before they ever touch the DB (startFlow already
              // verified a trustworthy keychain exists).
              tok.access_token ? sealSecretString(tok.access_token) : null,
              tok.refresh_token ? sealSecretString(tok.refresh_token) : null,
              expiresAt,
              tok.scope ?? GOOGLE_SCOPES.join(' ')
            );
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
      // Stored sealed; open only for the outbound revoke call.
      row.access_token = openSecretString(row.access_token);
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

  // ── Crash reporting (Sentry) ─────────────────────────────────────────────
  // Opt-out telemetry. These three channels back the Settings toggle and the
  // one-time first-run disclosure (renderer: App.tsx + SettingsPanel.tsx).
  //   - `sentry_enabled`        : the opt-out flag, default ON (absent ⇒ on).
  //   - `sentry_disclosure_ack` : whether the first-run notice was dismissed.
  // getSentry reports both. setSentry persists the flag AND flips the runtime
  // kill-switch so disabling stops transmission immediately — without a
  // restart (re-enabling resumes only if Sentry was initialised at launch).
  ipcMain.handle('settings:getSentry', () => {
    const s = readSettings();
    return {
      enabled: s.sentry_enabled !== false,
      disclosureAck: s.sentry_disclosure_ack === true,
    };
  });
  ipcMain.handle('settings:setSentry', (_e, enabled: boolean) => {
    writeSetting('sentry_enabled', !!enabled);
    setSentryRuntimeEnabled(!!enabled);
    return { enabled: !!enabled };
  });
  ipcMain.handle('settings:ackSentryDisclosure', () => {
    writeSetting('sentry_disclosure_ack', true);
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
    // Seat enforcement: the license-encoded seat count caps the roster.
    // Customers lift this by re-issuing a key with a higher `seats`; keyless
    // installs stay at 1.
    const ents = currentEntitlements();
    const used = usedSeats();
    if (used >= ents.seats) {
      throw new Error(`Seat limit reached (${used}/${ents.seats}). Upgrade your license to add more members.`);
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
    // Resolve the member binding FIRST so an unknown memberId gets its own
    // error rather than a misleading seat message.
    let role: 'admin' | 'member' = 'member';
    if (memberId) {
      const m = db.prepare(`SELECT role FROM team_members WHERE member_id=?`).get(memberId) as { role: string } | undefined;
      if (!m) throw new Error(`Unknown member_id "${memberId}".`);
      role = m.role === 'admin' ? 'admin' : 'member';
    }
    // Seat enforcement: a key bound to an existing member shares that member's
    // seat; only an UNBOUND key claims a seat of its own (usedSeats union).
    if (!memberId) {
      const ents = currentEntitlements();
      const used = usedSeats();
      if (used >= ents.seats) {
        throw new Error(`Seat limit reached (${used}/${ents.seats}). Upgrade your license to issue more keys.`);
      }
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
    // Sharing memory across LAN sessions is a Pro/Enterprise capability. Gate the
    // enable path so a Free user can't mark memories shared (they have no LAN
    // server to inject them into anyway); always allow turning sharing OFF.
    if (shared && !currentEntitlements().sharedMemory) {
      throw new Error('Shared memory requires a Team or Business license.');
    }
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
