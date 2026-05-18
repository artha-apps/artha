/**
 * SQLite schema — initialised on first launch via better-sqlite3.
 * All tables match the PRD v2.0 database schema section.
 */
import Database from 'better-sqlite3';
import * as path from 'path';
import { app } from 'electron';

let db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (!db) throw new Error('Database not initialised. Call initDatabase() first.');
  return db;
}

export async function initDatabase(): Promise<void> {
  const userDataPath = app.getPath('userData');
  const dbPath = path.join(userDataPath, 'artha.db');

  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    -- User profiles & app settings
    CREATE TABLE IF NOT EXISTS users (
      user_id    TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
      display_name TEXT NOT NULL DEFAULT 'User',
      settings_json TEXT NOT NULL DEFAULT '{}',
      encryption_key_hash TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    -- Chat sessions
    CREATE TABLE IF NOT EXISTS chat_sessions (
      session_id   TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
      title        TEXT NOT NULL DEFAULT 'New Chat',
      model_id     TEXT,
      start_time   INTEGER NOT NULL DEFAULT (unixepoch()),
      last_activity INTEGER NOT NULL DEFAULT (unixepoch())
    );

    -- Individual messages (includes tool calls/outputs as JSON)
    CREATE TABLE IF NOT EXISTS messages (
      message_id   TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
      session_id   TEXT NOT NULL REFERENCES chat_sessions(session_id) ON DELETE CASCADE,
      sender_type  TEXT NOT NULL CHECK(sender_type IN ('user','agent','tool')),
      content      TEXT NOT NULL DEFAULT '',
      tool_calls   TEXT,   -- JSON array of tool calls
      tool_outputs TEXT,   -- JSON array of tool outputs
      timestamp    INTEGER NOT NULL DEFAULT (unixepoch())
    );

    -- Agentic workflow state (for planning mode & resumption)
    CREATE TABLE IF NOT EXISTS agent_states (
      workflow_id  TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
      session_id   TEXT NOT NULL REFERENCES chat_sessions(session_id) ON DELETE CASCADE,
      plan_json    TEXT NOT NULL DEFAULT '[]',
      current_step INTEGER NOT NULL DEFAULT 0,
      status       TEXT NOT NULL DEFAULT 'pending'
                   CHECK(status IN ('pending','awaiting_approval','running','completed','failed','cancelled')),
      context_json TEXT NOT NULL DEFAULT '{}',
      created_at   INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at   INTEGER NOT NULL DEFAULT (unixepoch())
    );

    -- MCP tool registry (replaces v1.0 execution_path with mcp_server_uri)
    CREATE TABLE IF NOT EXISTS tools (
      tool_id        TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
      name           TEXT NOT NULL UNIQUE,
      description    TEXT NOT NULL DEFAULT '',
      schema_json    TEXT NOT NULL DEFAULT '{}',
      mcp_server_uri TEXT,  -- e.g. npx @modelcontextprotocol/server-filesystem
      permissions_json TEXT NOT NULL DEFAULT '{"fs":[],"network":[]}',
      is_enabled     INTEGER NOT NULL DEFAULT 1,
      installed_at   INTEGER NOT NULL DEFAULT (unixepoch())
    );

    -- Local LLM models
    CREATE TABLE IF NOT EXISTS llm_models (
      model_id       TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
      name           TEXT NOT NULL,          -- Display name
      ollama_name    TEXT NOT NULL UNIQUE,   -- e.g. llama3:8b-instruct-q4_K_M
      base_url       TEXT NOT NULL DEFAULT 'http://localhost:11434/v1',
      api_key        TEXT NOT NULL DEFAULT 'ollama',
      provider       TEXT NOT NULL DEFAULT 'ollama',
      size_gb        REAL,
      quant_level    TEXT,   -- Q4, Q8, F16, etc.
      hw_profile     TEXT,   -- min RAM required, e.g. '8gb'
      is_active      INTEGER NOT NULL DEFAULT 0,
      added_at       INTEGER NOT NULL DEFAULT (unixepoch())
    );

    -- RAG indexes (Phase 1)
    CREATE TABLE IF NOT EXISTS rag_indexes (
      index_id        TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
      name            TEXT NOT NULL,
      directory_path  TEXT NOT NULL,
      embedding_model TEXT NOT NULL DEFAULT 'nomic-embed-text',
      last_indexed    INTEGER,
      doc_count       INTEGER NOT NULL DEFAULT 0,
      created_at      INTEGER NOT NULL DEFAULT (unixepoch())
    );

    -- Reusable workflow templates
    CREATE TABLE IF NOT EXISTS workflow_templates (
      template_id        TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
      name               TEXT NOT NULL,
      prompt_template    TEXT NOT NULL,
      tool_sequence_json TEXT NOT NULL DEFAULT '[]',
      created_at         INTEGER NOT NULL DEFAULT (unixepoch())
    );

    -- Tool invocation audit log
    CREATE TABLE IF NOT EXISTS tool_audit_log (
      id          TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
      session_id  TEXT,
      workflow_id TEXT,
      tool_name   TEXT NOT NULL,
      args_json   TEXT NOT NULL DEFAULT '{}',
      result      TEXT,
      duration_ms INTEGER,
      status      TEXT NOT NULL DEFAULT 'ok' CHECK(status IN ('ok','error')),
      ts          INTEGER NOT NULL DEFAULT (unixepoch())
    );

    -- Seed default user if none exists
    INSERT OR IGNORE INTO users (user_id, display_name) VALUES ('default', 'User');
  `);

  console.log('[Artha] Database initialised at', dbPath);
}
