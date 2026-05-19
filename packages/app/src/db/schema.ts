/**
 * SQLite schema — initialised on first launch via better-sqlite3.
 *
 * Design notes:
 *   - WAL mode + sync writes: avoids async/Promise plumbing in the main process
 *     and gives us crash-consistent commits even on hard kill.
 *   - All CREATE TABLE statements are IF NOT EXISTS so launching an upgraded
 *     app over an existing DB never throws.
 *   - Column defaults (DEFAULT (unixepoch()), DEFAULT (lower(hex(...))))
 *     keep INSERT statements short across the codebase.
 *
 * All tables match the PRD v2.0 database schema section.
 */
import Database from 'better-sqlite3';
import * as path from 'path';
import { app } from 'electron';

/** Module-scoped handle so every call site uses the same WAL-mode connection. */
let db: Database.Database | null = null;

/** Returns the open connection. Throws if `initDatabase()` hasn't run yet —
 *  hard failure beats silently opening a second handle. */
export function getDb(): Database.Database {
  if (!db) throw new Error('Database not initialised. Call initDatabase() first.');
  return db;
}

/** Opens (or creates) the SQLite file under Electron's userData dir, applies
 *  pragmas, and runs the full schema bootstrap. Idempotent. */
export async function initDatabase(): Promise<void> {
  const userDataPath = app.getPath('userData');
  const dbPath = path.join(userDataPath, 'artha.db');

  db = new Database(dbPath);
  // WAL gives concurrent reads while we're writing and is the right pick for a
  // single-process app. foreign_keys is off by default in SQLite — turn it on
  // so ON DELETE CASCADE on chat_sessions actually cleans up messages.
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
      message_id     TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
      session_id     TEXT NOT NULL REFERENCES chat_sessions(session_id) ON DELETE CASCADE,
      sender_type    TEXT NOT NULL CHECK(sender_type IN ('user','agent','tool')),
      content        TEXT NOT NULL DEFAULT '',
      tool_calls     TEXT,   -- JSON array of tool calls
      tool_outputs   TEXT,   -- JSON array of tool outputs
      citations_json TEXT,   -- JSON array of {url, title, fetched_at} from web_fetch/web_search
      timestamp      INTEGER NOT NULL DEFAULT (unixepoch())
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

    -- ── Provenance-anchored documents ──────────────────────────────────────
    -- Every generated artifact is registered with a content hash. Each anchor
    -- (section / paragraph / bullet / table-cell / chart-series) inside the
    -- artifact carries a stable ID that resolves to a provenance record below.
    CREATE TABLE IF NOT EXISTS generated_documents (
      doc_id       TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
      session_id   TEXT,
      file_path    TEXT NOT NULL,
      doc_type     TEXT NOT NULL CHECK(doc_type IN ('docx','pptx','xlsx','pdf')),
      title        TEXT NOT NULL DEFAULT '',
      prompt       TEXT NOT NULL DEFAULT '',
      prompt_hash  TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      model        TEXT NOT NULL DEFAULT '',
      receipt_path TEXT,
      created_at   INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS provenance_records (
      record_id    TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
      doc_id       TEXT NOT NULL REFERENCES generated_documents(doc_id) ON DELETE CASCADE,
      anchor_id    TEXT NOT NULL,
      source_type  TEXT NOT NULL CHECK(source_type IN ('rag','tool','llm','user')),
      source_ref   TEXT NOT NULL DEFAULT '',
      excerpt      TEXT NOT NULL DEFAULT '',
      created_at   INTEGER NOT NULL DEFAULT (unixepoch()),
      UNIQUE(doc_id, anchor_id)
    );

    -- ── Time-travel: ReAct step persistence ────────────────────────────────
    CREATE TABLE IF NOT EXISTS agent_runs (
      run_id       TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
      session_id   TEXT NOT NULL,
      workflow_id  TEXT NOT NULL,
      parent_run_id TEXT,
      forked_from_step TEXT,
      goal         TEXT NOT NULL DEFAULT '',
      model        TEXT NOT NULL DEFAULT '',
      status       TEXT NOT NULL DEFAULT 'running'
                   CHECK(status IN ('running','completed','failed','cancelled')),
      created_at   INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS agent_steps (
      step_id      TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
      run_id       TEXT NOT NULL REFERENCES agent_runs(run_id) ON DELETE CASCADE,
      idx          INTEGER NOT NULL,
      kind         TEXT NOT NULL CHECK(kind IN ('system','user','assistant','tool_call','tool_result','final')),
      payload      TEXT NOT NULL DEFAULT '{}',
      messages_snapshot TEXT,
      ts           INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE INDEX IF NOT EXISTS idx_agent_steps_run ON agent_steps(run_id, idx);

    -- ── Adaptive model router ──────────────────────────────────────────────
    -- Per-task-type benchmark profile: latency + a quality heuristic score.
    CREATE TABLE IF NOT EXISTS model_profiles (
      profile_id   TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
      ollama_name  TEXT NOT NULL,
      task_type    TEXT NOT NULL CHECK(task_type IN ('plan','tool_args','synthesis')),
      latency_ms   INTEGER NOT NULL DEFAULT 0,
      quality      REAL NOT NULL DEFAULT 0,
      benchmarked_at INTEGER NOT NULL DEFAULT (unixepoch()),
      UNIQUE(ollama_name, task_type)
    );

    -- User overrides: pin a specific model for a task type (NULL = auto)
    CREATE TABLE IF NOT EXISTS router_overrides (
      task_type    TEXT PRIMARY KEY CHECK(task_type IN ('plan','tool_args','synthesis')),
      ollama_name  TEXT NOT NULL
    );

    -- ── Web fetch cache ────────────────────────────────────────────────────
    -- TTL-bounded cache of fetched URLs. Lets web_fetch return instantly on
    -- repeated reads of the same page within the configured window, and gives
    -- us an at-rest log of what the agent has read from the web.
    CREATE TABLE IF NOT EXISTS web_cache (
      url         TEXT PRIMARY KEY,
      title       TEXT NOT NULL DEFAULT '',
      content     TEXT NOT NULL DEFAULT '',
      content_type TEXT NOT NULL DEFAULT 'text/markdown',
      etag        TEXT,
      fetched_at  INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE INDEX IF NOT EXISTS idx_web_cache_fetched ON web_cache(fetched_at);

    -- Seed default user if none exists
    INSERT OR IGNORE INTO users (user_id, display_name) VALUES ('default', 'User');
  `);

  // Best-effort migration for existing DBs that pre-date citations_json.
  // CREATE TABLE IF NOT EXISTS only creates *new* tables; an existing
  // messages table from a pre-web build needs an explicit ALTER. Swallow
  // errors so a malformed sqlite_master row can't brick boot.
  try {
    const cols = db.prepare(`PRAGMA table_info(messages)`).all() as { name: string }[];
    if (!cols.some(c => c.name === 'citations_json')) {
      db.exec(`ALTER TABLE messages ADD COLUMN citations_json TEXT`);
    }
  } catch (err) {
    console.warn('[Artha] citations_json migration skipped:', err);
  }

  console.log('[Artha] Database initialised at', dbPath);
}
