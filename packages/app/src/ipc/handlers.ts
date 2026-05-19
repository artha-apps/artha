/**
 * IPC Handlers — wires all Electron IPC channels to backend modules.
 * The renderer calls these via the preload bridge (window.artha.*).
 */
import { ipcMain, BrowserWindow, dialog, shell } from 'electron';
import * as path from 'path';
import { app } from 'electron';
import { AgentOrchestrator } from '../agent/orchestrator';
import { MCPRegistry } from '../mcp/registry';
import { RAGIndexer } from '../rag/indexer';
import { generateDocument } from '../docs/generator';
import { exportBundle, importBundle } from '../bundles/bundle';
import { runBenchmark, listProfiles, setOverride, listOverrides } from '../router/benchmark';
import { getDb } from '../db/schema';
import { DEFAULT_WEB_CONFIG, clearWebCache, type WebConfig } from '../tools/web';
import { BrowserController } from '../browser/controller';
import { setBrowserToolEmitter } from '../tools/browser';

let orchestrator: AgentOrchestrator;
const ragIndexer = new RAGIndexer(path.join(app.getPath('userData'), 'rag-indexes'));

export function registerIpcHandlers(window: BrowserWindow): void {
  orchestrator = new AgentOrchestrator(window);

  // Load all enabled MCP servers at startup
  MCPRegistry.getInstance().loadFromDatabase().catch(console.error);

  // ── Agent ──────────────────────────────────────────────────────────────
  ipcMain.handle('agent:sendMessage', async (_e, sessionId: string, content: string) => {
    const db = getDb();
    db.prepare(`INSERT INTO messages (session_id, sender_type, content) VALUES (?, 'user', ?)`).run(sessionId, content);
    await orchestrator.handleMessage(sessionId, content);
  });

  ipcMain.handle('agent:cancelTask', async (_e, workflowId: string) => {
    const db = getDb();
    db.prepare(`UPDATE agent_states SET status='cancelled' WHERE workflow_id=?`).run(workflowId);
    // Stop button must also release any awaited browser handoff or the
    // orchestrator's tool-await would block forever.
    BrowserController.getInstance().cancelHandoff();
  });

  ipcMain.handle('agent:approvePlan', async (_e, workflowId: string, approved: boolean) => {
    await orchestrator.approvePlan(workflowId, approved);
  });

  // ── Sessions ───────────────────────────────────────────────────────────
  ipcMain.handle('sessions:list', () => {
    return getDb().prepare(`SELECT * FROM chat_sessions ORDER BY last_activity DESC`).all();
  });

  ipcMain.handle('sessions:create', () => {
    const db = getDb();
    const id = crypto.randomUUID();
    db.prepare(`INSERT INTO chat_sessions (session_id) VALUES (?)`).run(id);
    return { session_id: id, title: 'New Chat' };
  });

  ipcMain.handle('sessions:delete', (_e, id: string) => {
    getDb().prepare(`DELETE FROM chat_sessions WHERE session_id=?`).run(id);
  });

  ipcMain.handle('sessions:getMessages', (_e, sessionId: string) => {
    return getDb().prepare(`SELECT * FROM messages WHERE session_id=? ORDER BY timestamp ASC`).all(sessionId);
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

  ipcMain.handle('llm:detectHardware', async () => {
    // Basic RAM detection — real GPU detection requires native bindings (Phase 2)
    const totalMem = (await import('os')).totalmem();
    const gbRam = Math.round(totalMem / 1024 / 1024 / 1024);
    const recommendation = gbRam >= 32 ? 'Q8 or F16 models' : gbRam >= 16 ? 'Q8 models (8B)' : 'Q4 models (3B-8B)';
    return { gbRam, recommendation };
  });

  ipcMain.handle('llm:pullModel', async (_e, name: string) => {
    const res = await fetch('http://localhost:11434/api/pull', {
      method: 'POST',
      body: JSON.stringify({ name, stream: false }),
    });
    return res.ok;
  });

  ipcMain.handle('llm:getActiveModel', () => {
    const db = getDb();
    const row = db.prepare(`SELECT ollama_name FROM llm_models WHERE is_active=1 LIMIT 1`).get() as { ollama_name: string } | undefined;
    return row?.ollama_name ?? null;
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

  ipcMain.handle('mcp:getAuditLog', (_e, limit = 200) => {
    return getDb().prepare(
      `SELECT * FROM tool_audit_log ORDER BY ts DESC LIMIT ?`
    ).all(limit);
  });

  // ── RAG ────────────────────────────────────────────────────────────────
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
    return runBenchmark((msg) => window.webContents.send('router:benchmarkProgress', msg));
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
    if (!window.isDestroyed()) {
      window.webContents.send('browser:state', state);
    }
  });

  // Browser tools fire these events through the emitter — surface them to the
  // renderer so the pane can auto-open and the handoff banner can appear.
  setBrowserToolEmitter({
    emit: (channel, payload) => {
      if (!window.isDestroyed()) window.webContents.send(channel, payload);
    },
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

  ipcMain.handle('browser:getState', () => browser.getState());
}
