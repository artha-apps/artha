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

    -- Projects — a working folder that scopes a group of chat sessions and
    -- gives the agent durable context (project root + an optional ARTHA.md).
    CREATE TABLE IF NOT EXISTS projects (
      project_id   TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
      name         TEXT NOT NULL,
      root_path    TEXT NOT NULL,
      rag_index_id TEXT,            -- auto-built RAG index over root_path (Phase 2)
      summary      TEXT,            -- rolling cross-session project memory (Phase 3)
      settings_json TEXT NOT NULL DEFAULT '{}',
      created_at   INTEGER NOT NULL DEFAULT (unixepoch())
    );

    -- Chat sessions
    CREATE TABLE IF NOT EXISTS chat_sessions (
      session_id   TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
      title        TEXT NOT NULL DEFAULT 'New Chat',
      model_id     TEXT,
      project_id   TEXT,   -- NULL = general (no project)
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
      model_id        TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
      name            TEXT NOT NULL,          -- Display name
      ollama_name     TEXT NOT NULL UNIQUE,   -- e.g. llama3:8b-instruct-q4_K_M
      base_url        TEXT NOT NULL DEFAULT 'http://localhost:11434/v1',
      api_key         TEXT NOT NULL DEFAULT 'ollama',
      provider        TEXT NOT NULL DEFAULT 'ollama',
      size_gb         REAL,
      quant_level     TEXT,   -- Q4, Q8, F16, etc.
      hw_profile      TEXT,   -- min RAM required, e.g. '8gb'
      context_window  INTEGER NOT NULL DEFAULT 4096, -- max tokens sent to model
      is_active       INTEGER NOT NULL DEFAULT 0,
      added_at        INTEGER NOT NULL DEFAULT (unixepoch())
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

    -- ── Skills ──────────────────────────────────────────────────────────────
    -- A Skill is a named, described playbook the agent loads when it matches the
    -- user's intent (auto-match by description) or when explicitly invoked with
    -- "/slug" in chat. The instructions column is injected into the ReAct system
    -- prompt; allowed_tools_json optionally scopes which tools the agent may use
    -- while the skill is active (entries ending in "_" are treated as prefixes,
    -- e.g. "fs_" allows every filesystem tool). Empty allowlist = all tools.
    CREATE TABLE IF NOT EXISTS skills (
      skill_id           TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
      slug               TEXT NOT NULL UNIQUE,
      name               TEXT NOT NULL,
      description        TEXT NOT NULL DEFAULT '',
      instructions       TEXT NOT NULL DEFAULT '',
      allowed_tools_json TEXT NOT NULL DEFAULT '[]',
      icon               TEXT NOT NULL DEFAULT '✨',
      is_enabled         INTEGER NOT NULL DEFAULT 1,
      is_builtin         INTEGER NOT NULL DEFAULT 0,
      created_at         INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at         INTEGER NOT NULL DEFAULT (unixepoch())
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

    -- ── Scheduled Tasks ────────────────────────────────────────────────────
    -- Cron-based or one-time future tasks. Each fires by calling the agent
    -- orchestrator with 'prompt' in a new session. status transitions:
    --   enabled -> (fires) -> enabled (repeating) or completed (one-shot)
    CREATE TABLE IF NOT EXISTS scheduled_tasks (
      task_id      TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
      name         TEXT NOT NULL,
      prompt       TEXT NOT NULL,
      cron         TEXT,            -- cron expression, NULL for one-shot
      fire_at      INTEGER,         -- unix epoch for one-shot tasks
      is_enabled   INTEGER NOT NULL DEFAULT 1,
      last_run_at  INTEGER,
      last_status  TEXT,            -- 'ok' | 'error' | null
      run_count    INTEGER NOT NULL DEFAULT 0,
      created_at   INTEGER NOT NULL DEFAULT (unixepoch())
    );

    -- ── Agent Memory ──────────────────────────────────────────────────────
    -- Persistent facts the agent accumulates across sessions.
    -- Injected into the system prompt so the agent "remembers" the user.
    CREATE TABLE IF NOT EXISTS memory_entities (
      entity_id   TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
      name        TEXT NOT NULL,
      entity_type TEXT NOT NULL DEFAULT 'fact',
      content     TEXT NOT NULL,
      tags_json   TEXT NOT NULL DEFAULT '[]',
      source_session_id TEXT,
      project_id  TEXT,   -- NULL = global memory; else scoped to a project (Phase 3)
      created_at  INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at  INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE INDEX IF NOT EXISTS idx_memory_name ON memory_entities(name);
    CREATE INDEX IF NOT EXISTS idx_memory_updated ON memory_entities(updated_at DESC);

    -- ── Persistent Artifacts ──────────────────────────────────────────────
    -- Every file the agent generates (docx, pptx, xlsx, pdf, image) is logged
    -- here so the user can browse, re-open, and delete them from one panel.
    CREATE TABLE IF NOT EXISTS artifacts (
      artifact_id  TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
      session_id   TEXT REFERENCES chat_sessions(session_id) ON DELETE SET NULL,
      name         TEXT NOT NULL,
      file_path    TEXT NOT NULL,
      file_type    TEXT NOT NULL DEFAULT 'file',
      size_bytes   INTEGER,
      created_at   INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE INDEX IF NOT EXISTS idx_artifacts_created ON artifacts(created_at DESC);

    -- ── OAuth tokens ──────────────────────────────────────────────────────
    -- Stores access/refresh tokens for connected cloud providers (Google
    -- Workspace: Gmail/Calendar/Drive). One row per provider. Tokens live only
    -- in the local DB and are sent only to the provider's own endpoints.
    CREATE TABLE IF NOT EXISTS oauth_tokens (
      provider      TEXT PRIMARY KEY,
      access_token  TEXT,
      refresh_token TEXT,
      expires_at    INTEGER,
      scope         TEXT,
      created_at    INTEGER DEFAULT (unixepoch())
    );

    -- Seed default user if none exists
    INSERT OR IGNORE INTO users (user_id, display_name) VALUES ('default', 'User');

    -- Seed built-in skills (idempotent — keyed by slug). These ship enabled and
    -- can be edited or disabled by the user, but not deleted (is_builtin=1).
    INSERT OR IGNORE INTO skills (slug, name, description, instructions, allowed_tools_json, icon, is_builtin)
    VALUES
      (
        'research',
        'Web Research',
        'Research a topic on the web and write a sourced, well-structured summary. Use when the user asks to research, look up, find out about, or gather information on something.',
        'You are operating as the Web Research skill.' || char(10) ||
        '1. Break the question into 2-4 concrete search queries.' || char(10) ||
        '2. Use web_search to find authoritative sources, then web_fetch to read the most relevant ones.' || char(10) ||
        '3. Prefer primary/official sources over aggregators. Cross-check any surprising claim against a second source.' || char(10) ||
        '4. Write a structured answer with short sections and bullet points. Weave the source URL into the prose for every non-obvious fact so citations render.' || char(10) ||
        '5. Never state a fact you did not read from a fetched page.',
        '["web_","browser_navigate","browser_read_dom"]',
        '🔎',
        1
      ),
      (
        'organize',
        'File Organizer',
        'Tidy and reorganize folders — sort by type, archive old files, rename for consistency. Use when the user asks to organize, clean up, sort, or declutter files or folders.',
        'You are operating as the File Organizer skill.' || char(10) ||
        '1. ALWAYS call fs_list_directory on the target folder first to see what exists. Never assume contents.' || char(10) ||
        '2. Propose a clear scheme (e.g. by type, by date) and create destination folders with fs_create_directory.' || char(10) ||
        '3. Move files one at a time with fs_move_file; the destination path MUST include the filename.' || char(10) ||
        '4. After moving, re-list both source and destination to verify the result.' || char(10) ||
        '5. Never delete a file unless the user explicitly asked you to.',
        '["fs_"]',
        '🗂️',
        1
      ),
      (
        'summarize',
        'Document Summarizer',
        'Read one or more local files and produce a concise summary or set of key points. Use when the user asks to summarize, condense, or extract key points from local documents.',
        'You are operating as the Document Summarizer skill.' || char(10) ||
        '1. Use fs_list_directory / fs_search_files to locate the file(s) if a path was not given.' || char(10) ||
        '2. Read each file with fs_read_file before summarizing — never summarize a file you have not read.' || char(10) ||
        '3. Produce a tight summary: a one-line gist, then 3-6 key points as bullets.' || char(10) ||
        '4. Quote sparingly and attribute which file each point came from when summarizing multiple files.',
        '["fs_list_directory","fs_search_files","fs_read_file","fs_get_file_info"]',
        '📝',
        1
      ),
      (
        'report',
        'Report Writer',
        'Research a topic on the web and produce a finished, sourced document (Word, PDF, slides, or spreadsheet). Use when the user asks to write, draft, or produce a report, proposal, brief, or presentation about a topic.',
        'You are operating as the Report Writer skill — your job ends with a real file, not just chat.' || char(10) ||
        '1. If the topic needs current facts, use web_search then web_fetch to gather 2-4 solid sources first.' || char(10) ||
        '2. Decide the best format from the request: docx (prose report/proposal), pdf (shareable report), pptx (presentation), xlsx (data/tables).' || char(10) ||
        '3. Call docs_generate with a detailed "prompt" brief (topic, audience, the sections you want) and a clear "filename".' || char(10) ||
        '4. Pass the facts you gathered into docs_generate "context" so the document is grounded and the sources are cited.' || char(10) ||
        '5. If the request refers to the user''s own files or notes, set use_rag=true on docs_generate to ground and cite their indexed documents.' || char(10) ||
        '6. After the file is created, tell the user the file name and where it was saved. Never claim a document exists unless docs_generate returned success.',
        '["web_","browser_navigate","browser_read_dom","docs_generate","fs_read_file","fs_list_directory"]',
        '📊',
        1
      ),
      (
        'ask',
        'Ask My Files',
        'Answer questions using the user''s own indexed files (their notes, documents, knowledge base). Use when the user asks about their own files, notes, or personal documents.',
        'You are operating as the Ask My Files skill — answer strictly from the user''s indexed files.' || char(10) ||
        '1. Optionally call rag_list_indexes to confirm searchable files exist.' || char(10) ||
        '2. Call rag_search with a focused query built from the user''s question.' || char(10) ||
        '3. Answer only from the returned passages. Cite the source filename(s) in your reply.' || char(10) ||
        '4. If nothing relevant is found, say so plainly — do NOT invent file contents.',
        '["rag_search","rag_list_indexes","fs_read_file"]',
        '📚',
        1
      );
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

  // Migration: add context_window to llm_models for DBs created before this
  // column existed. Default 4096 keeps existing model rows unchanged.
  try {
    const llmCols = db.prepare(`PRAGMA table_info(llm_models)`).all() as { name: string }[];
    if (!llmCols.some(c => c.name === 'context_window')) {
      db.exec(`ALTER TABLE llm_models ADD COLUMN context_window INTEGER NOT NULL DEFAULT 4096`);
    }
  } catch (err) {
    console.warn('[Artha] context_window migration skipped:', err);
  }

  // Migration: add project_id to chat_sessions for DBs created before projects
  // existed. NULL means the session belongs to no project (general chat).
  try {
    const sessCols = db.prepare(`PRAGMA table_info(chat_sessions)`).all() as { name: string }[];
    if (!sessCols.some(c => c.name === 'project_id')) {
      db.exec(`ALTER TABLE chat_sessions ADD COLUMN project_id TEXT`);
    }
  } catch (err) {
    console.warn('[Artha] project_id migration skipped:', err);
  }

  // Migration: add rag_index_id + summary to projects (Phase 2/3 columns) for
  // DBs whose projects table pre-dates them.
  try {
    const projCols = db.prepare(`PRAGMA table_info(projects)`).all() as { name: string }[];
    if (projCols.length) {
      if (!projCols.some(c => c.name === 'rag_index_id')) db.exec(`ALTER TABLE projects ADD COLUMN rag_index_id TEXT`);
      if (!projCols.some(c => c.name === 'summary')) db.exec(`ALTER TABLE projects ADD COLUMN summary TEXT`);
    }
  } catch (err) {
    console.warn('[Artha] projects column migration skipped:', err);
  }

  // Migration: add project_id to memory_entities so memories can be scoped to a
  // project. NULL = global memory available in every conversation.
  try {
    const memCols = db.prepare(`PRAGMA table_info(memory_entities)`).all() as { name: string }[];
    if (memCols.length && !memCols.some(c => c.name === 'project_id')) {
      db.exec(`ALTER TABLE memory_entities ADD COLUMN project_id TEXT`);
    }
  } catch (err) {
    console.warn('[Artha] memory project_id migration skipped:', err);
  }

  console.log('[Artha] Database initialised at', dbPath);
}
