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
import { getDb } from '../db/schema';

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

  ipcMain.handle('mcp:removeServer', (_e, id: string) => {
    getDb().prepare(`DELETE FROM tools WHERE tool_id=?`).run(id);
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
}
