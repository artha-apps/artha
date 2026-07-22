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
import { sealPlaintextApiKeys } from '../security/secretString';

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
  // Idempotent: telemetry bootstrap opens the DB before Electron's 'ready'
  // event (so Sentry can read the opt-out flag in time), then createWindow
  // calls this again post-ready. Second call is a no-op — never open twice.
  if (db) return;
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

    -- Per-chat scope: the folders and individual files a single chat session is
    -- bound to. The agent is context-aware of these and (hard sandbox) may only
    -- read/write inside them. kind='folder' rows mirror a row in projects
    -- (deduped by path) so the folder gets an auto RAG index + cross-session
    -- memory; kind='file' rows are standalone (inlined into context, no index).
    CREATE TABLE IF NOT EXISTS session_scopes (
      scope_id     TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
      session_id   TEXT NOT NULL REFERENCES chat_sessions(session_id) ON DELETE CASCADE,
      path         TEXT NOT NULL,
      kind         TEXT NOT NULL CHECK(kind IN ('folder','file')),
      rag_index_id TEXT,            -- folder workspaces only; mirrors projects.rag_index_id
      added_at     INTEGER NOT NULL DEFAULT (unixepoch()),
      UNIQUE(session_id, path)
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

    -- ── DB health heartbeat (disaster recovery) ───────────────────────────
    -- A single-row (id='default') heartbeat updated every 30 minutes. On a
    -- crash report, checkpointed_at reveals exactly how long since the app was
    -- last known healthy. See db/health.ts.
    CREATE TABLE IF NOT EXISTS db_health (
      id              TEXT PRIMARY KEY DEFAULT 'default',
      checkpointed_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    -- MCP tool registry (replaces v1.0 execution_path with mcp_server_uri)
    CREATE TABLE IF NOT EXISTS tools (
      tool_id        TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
      name           TEXT NOT NULL UNIQUE,
      description    TEXT NOT NULL DEFAULT '',
      schema_json    TEXT NOT NULL DEFAULT '{}',
      mcp_server_uri TEXT,  -- e.g. npx @modelcontextprotocol/server-filesystem
      -- Encrypted connector credentials (API keys / tokens / connection strings).
      -- Opaque blob produced by security/secrets.ts (safeStorage-backed); NULL
      -- when the connector needs no auth. Handed to the server's child process
      -- as env vars / args at spawn time, never logged or exposed to the model.
      credentials_enc TEXT,
      -- Last connection outcome for this MCP server, so the UI can show honest
      -- state instead of implying every installed row is live. NULL = never
      -- attempted; 'connected' = handshake ok; 'error' = spawn/handshake failed
      -- (conn_error holds the message); 'disabled' = turned off by the user.
      -- The row is kept on failure (credentials persist + auto-retry on next
      -- launch); status is what lets the panel offer a Retry instead of lying.
      conn_status    TEXT,
      conn_error     TEXT,
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
      -- A capability is realised either as a stateless 'skill' (playbook + tool
      -- scope) or promoted to a first-class 'agent'. Same row shape — the kind
      -- is the only difference, so "promote a skill to an agent" is a flag.
      kind               TEXT NOT NULL DEFAULT 'skill' CHECK(kind IN ('skill','agent')),
      -- Per-skill model pin (ollama_name). NULL = auto-route via the model
      -- router; set, it overrides the model for this skill's ReAct loop. Driven
      -- by the dashboard's empirical "best model for this skill" recommendation.
      pinned_model       TEXT,
      created_at         INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at         INTEGER NOT NULL DEFAULT (unixepoch())
    );

    -- ── Skill runs (per-invocation metrics ledger) ─────────────────────────
    -- One row each time a skill is actually executed (Chat, Delegate, or an
    -- invoked capability). Backs the Skills dashboard: run count, success rate,
    -- avg tool calls / duration, and how the skill was reached (explicit "/slug",
    -- auto-match, or delegated invoke). Local-only telemetry — never transmitted.
    -- run_id links to agent_runs so tool_receipts can be counted per invocation.
    CREATE TABLE IF NOT EXISTS skill_runs (
      skill_run_id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
      skill_id     TEXT NOT NULL,
      slug         TEXT NOT NULL DEFAULT '',
      run_id       TEXT,            -- mirrors agent_runs.run_id for this invocation
      session_id   TEXT,
      goal         TEXT NOT NULL DEFAULT '',
      status       TEXT NOT NULL DEFAULT 'ok'
                   CHECK(status IN ('ok','error','cancelled')),
      matched_via  TEXT NOT NULL DEFAULT 'auto'
                   CHECK(matched_via IN ('explicit','auto','invoke')),
      tool_calls   INTEGER NOT NULL DEFAULT 0,
      tool_errors  INTEGER NOT NULL DEFAULT 0,
      duration_ms  INTEGER NOT NULL DEFAULT 0,
      created_at   INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE INDEX IF NOT EXISTS idx_skill_runs_skill ON skill_runs(skill_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_skill_runs_created ON skill_runs(created_at DESC);

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
      actor       TEXT NOT NULL DEFAULT 'local',
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

    -- ── Tool-call policies (governance for function calling) ────────────────
    -- Per-tool trust tiers evaluated before every function call (see
    -- bodhi/policy.ts). pattern follows the Skills allowlist convention (exact
    -- name, a prefix ending in "_", or "*"). tier decides what happens:
    -- auto=run silently, confirm=ask first, dry_run=describe but don't execute,
    -- forbid=block. scope='outside_roots' applies a rule only to calls whose
    -- path arguments fall outside the chat's sandbox folders.
    CREATE TABLE IF NOT EXISTS tool_policies (
      policy_id   TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
      pattern     TEXT NOT NULL,
      tier        TEXT NOT NULL DEFAULT 'confirm' CHECK(tier IN ('auto','confirm','dry_run','forbid')),
      scope       TEXT NOT NULL DEFAULT 'always'  CHECK(scope IN ('always','outside_roots')),
      note        TEXT NOT NULL DEFAULT '',
      is_enabled  INTEGER NOT NULL DEFAULT 1,
      created_at  INTEGER NOT NULL DEFAULT (unixepoch())
    );

    -- ── Verified tool receipts (provenance for function calls) ──────────────
    -- One row per tool call (including policy-blocked / dry-run calls). Carries
    -- a plain-English effect, a content hash of the result, the governing policy
    -- tier, and status, so the user gets a verifiable audit trail of what the
    -- agent did (see bodhi/receipts.ts). Local-only; never transmitted.
    CREATE TABLE IF NOT EXISTS tool_receipts (
      receipt_id  TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
      run_id      TEXT,
      session_id  TEXT,
      workflow_id TEXT,
      idx         INTEGER NOT NULL DEFAULT 0,
      tool_name   TEXT NOT NULL,
      args_json   TEXT NOT NULL DEFAULT '{}',
      effect      TEXT NOT NULL DEFAULT '',
      result_hash TEXT NOT NULL DEFAULT '',
      status      TEXT NOT NULL DEFAULT 'ok' CHECK(status IN ('ok','error','blocked','skipped')),
      tier        TEXT NOT NULL DEFAULT 'auto',
      is_mutation INTEGER NOT NULL DEFAULT 0,
      duration_ms INTEGER NOT NULL DEFAULT 0,
      ts          INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE INDEX IF NOT EXISTS idx_tool_receipts_run ON tool_receipts(run_id, idx);

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

    -- ── Team members ──────────────────────────────────────────────────────
    -- Local team roster. Each member has a display name, optional email, and
    -- a role (admin | member). "admin" can manage members and API keys;
    -- "member" can query the LAN server but cannot change team settings.
    -- This table is local-only — no cloud sync. The LAN server uses api_keys
    -- for authentication; team_members is metadata for the admin UI only.
    CREATE TABLE IF NOT EXISTS team_members (
      member_id    TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
      display_name TEXT NOT NULL,
      email        TEXT,
      role         TEXT NOT NULL DEFAULT 'member'
                   CHECK(role IN ('admin', 'member')),
      joined_at    INTEGER NOT NULL DEFAULT (unixepoch())
    );

    -- ── LAN API keys ──────────────────────────────────────────────────────
    -- Bearer tokens issued for the LAN collaboration server. The actual key
    -- is shown to the user once on creation and never stored in plaintext —
    -- only a SHA-256 hex digest is persisted here. The LAN server hashes
    -- incoming tokens and compares against key_hash.
    -- member_id / role link a key to its team_members row so the LAN server
    -- can resolve "which teammate is calling" from the Bearer token alone.
    -- role is cached here to avoid a join on every authorised request; it's
    -- kept in sync by apikeys:create when the key is issued for a member.
    CREATE TABLE IF NOT EXISTS api_keys (
      key_id       TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
      name         TEXT NOT NULL,
      key_hash     TEXT NOT NULL UNIQUE,
      member_id    TEXT,
      role         TEXT,
      created_at   INTEGER NOT NULL DEFAULT (unixepoch()),
      last_used_at INTEGER,
      is_enabled   INTEGER NOT NULL DEFAULT 1
    );

    -- ── Knowledge Graph (Bodhi engine) ────────────────────────────────────
    -- General-purpose typed entities + directed typed relations — the real
    -- "Knowledge Graph" layer of the intelligence stack. Domain producers (the
    -- CRM Agent today; Email/Calendar later) PROJECT their rows in here via a
    -- stable (source, kind, external_id) key so re-projection is idempotent.
    -- Distinct from memory_entities (a flat fact bag with no relation concept).
    CREATE TABLE IF NOT EXISTS kg_entities (
      entity_id   TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
      kind        TEXT NOT NULL,                  -- 'person' | 'company' | 'deal' | … (open vocab)
      name        TEXT NOT NULL,                  -- display label
      external_id TEXT,                           -- producer's own id (e.g. crm contact_id); NULL = ad-hoc
      source      TEXT NOT NULL DEFAULT 'manual', -- 'crm' | 'manual' | … which producer owns it
      props_json  TEXT NOT NULL DEFAULT '{}',     -- arbitrary structured attributes
      project_id  TEXT,                           -- NULL = global; mirrors memory_entities scoping
      created_at  INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at  INTEGER NOT NULL DEFAULT (unixepoch())
    );
    -- Idempotent re-projection key: one node per (source, kind, external_id).
    CREATE UNIQUE INDEX IF NOT EXISTS idx_kg_entity_ext
      ON kg_entities(source, kind, external_id) WHERE external_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_kg_entity_name ON kg_entities(name);
    CREATE INDEX IF NOT EXISTS idx_kg_entity_kind ON kg_entities(kind);

    CREATE TABLE IF NOT EXISTS kg_relations (
      relation_id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
      src_id      TEXT NOT NULL REFERENCES kg_entities(entity_id) ON DELETE CASCADE,
      dst_id      TEXT NOT NULL REFERENCES kg_entities(entity_id) ON DELETE CASCADE,
      rel_type    TEXT NOT NULL,                  -- 'works_at' | 'owns_deal' | 'interacted_with' | …
      props_json  TEXT NOT NULL DEFAULT '{}',
      created_at  INTEGER NOT NULL DEFAULT (unixepoch())
    );
    -- One edge of a given type between two nodes (idempotent linking).
    CREATE UNIQUE INDEX IF NOT EXISTS idx_kg_rel_unique ON kg_relations(src_id, dst_id, rel_type);
    CREATE INDEX IF NOT EXISTS idx_kg_rel_src ON kg_relations(src_id);
    CREATE INDEX IF NOT EXISTS idx_kg_rel_dst ON kg_relations(dst_id);

    -- ── CRM (local-only; backs the CRM Agent capability) ───────────────────
    -- Plain local SQLite — no cloud, no API keys. Writes also project into the
    -- Knowledge Graph above so relationships are queryable.
    CREATE TABLE IF NOT EXISTS crm_companies (
      company_id  TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
      name        TEXT NOT NULL,
      domain      TEXT,
      notes       TEXT NOT NULL DEFAULT '',
      project_id  TEXT,
      created_at  INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at  INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_crm_company_name ON crm_companies(name, IFNULL(project_id,''));

    CREATE TABLE IF NOT EXISTS crm_contacts (
      contact_id  TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
      name        TEXT NOT NULL,
      email       TEXT,
      phone       TEXT,
      company_id  TEXT REFERENCES crm_companies(company_id) ON DELETE SET NULL,
      title       TEXT,
      notes       TEXT NOT NULL DEFAULT '',
      project_id  TEXT,
      created_at  INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at  INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE INDEX IF NOT EXISTS idx_crm_contact_name ON crm_contacts(name);
    CREATE INDEX IF NOT EXISTS idx_crm_contact_email ON crm_contacts(email);

    CREATE TABLE IF NOT EXISTS crm_deals (
      deal_id     TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
      title       TEXT NOT NULL,
      company_id  TEXT REFERENCES crm_companies(company_id) ON DELETE SET NULL,
      contact_id  TEXT REFERENCES crm_contacts(contact_id) ON DELETE SET NULL,
      stage       TEXT NOT NULL DEFAULT 'lead',
      amount      REAL,
      project_id  TEXT,
      created_at  INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at  INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE INDEX IF NOT EXISTS idx_crm_deal_contact ON crm_deals(contact_id);

    CREATE TABLE IF NOT EXISTS crm_interactions (
      interaction_id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
      contact_id  TEXT REFERENCES crm_contacts(contact_id) ON DELETE CASCADE,
      kind        TEXT NOT NULL DEFAULT 'note',   -- call | email | meeting | note
      summary     TEXT NOT NULL DEFAULT '',
      occurred_at INTEGER NOT NULL DEFAULT (unixepoch()),
      created_at  INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE INDEX IF NOT EXISTS idx_crm_interaction_contact ON crm_interactions(contact_id);

    -- Context Packs: named, reusable context sets a user can apply to any chat.
    -- scopes_json = [{path, kind}] (copied physically into session_scopes on
    -- apply); skill_id + memory_ids_json are injected BY REFERENCE at run time
    -- (pack edits propagate; deleted skills/memories degrade gracefully). A
    -- session records the applied pack in chat_sessions.context_pack_id
    -- (migration v16→v17) so the UI can show an active-pack chip. is_shared=1
    -- lists the pack on the LAN hub (GET /packs, POST /chat {packId}) — gated
    -- by the sharedPacks (Team/Business) entitlement.
    CREATE TABLE IF NOT EXISTS context_packs (
      pack_id         TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
      name            TEXT NOT NULL,
      scopes_json     TEXT NOT NULL DEFAULT '[]',
      skill_id        TEXT,
      memory_ids_json TEXT NOT NULL DEFAULT '[]',
      is_shared       INTEGER NOT NULL DEFAULT 0,
      created_at      INTEGER NOT NULL DEFAULT (unixepoch())
    );

    -- Seed default user if none exists
    INSERT OR IGNORE INTO users (user_id, display_name) VALUES ('default', 'User');

    -- Seed built-in skills (idempotent — keyed by slug). These ship enabled and
    -- can be edited or disabled by the user, but not deleted (is_builtin=1).
    INSERT OR IGNORE INTO skills (slug, name, description, instructions, allowed_tools_json, icon, is_builtin, kind)
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
        1,
        'skill'
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
        1,
        'skill'
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
        1,
        'skill'
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
        1,
        'skill'
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
        1,
        'skill'
      ),
      (
        'crm',
        'CRM Agent',
        'Manage contacts, companies, deals, and interactions in your local CRM, and reason over who-knows-whom. Use when the user wants to add or find a contact, log a call/email/meeting, track a deal, or ask about their relationships and network.',
        'You are the CRM Agent — you maintain a local, private CRM and the relationship graph behind it.' || char(10) ||
        '1. To record a person, call crm_add_contact with their name (and email/company/title if known). Companies are created automatically.' || char(10) ||
        '2. Log every call, email, or meeting with crm_log_interaction against the contact, with a short summary.' || char(10) ||
        '3. Track opportunities with crm_add_deal, tied to a contact or company.' || char(10) ||
        '4. To answer "who/what do we know" questions, use crm_find for records and kg_query / kg_search to traverse the relationship graph (works_at, owns_deal, interacted_with).' || char(10) ||
        '5. Never invent a contact, deal, or interaction — only report what the tools actually returned.',
        '["crm_","kg_"]',
        '👥',
        1,
        'agent'
      );

    -- Seed ONE safe default tool policy so the governance feature is visible and
    -- valuable out of the box: confirm before deleting a file. Seeded only when
    -- no policies exist yet, so a user who clears the list isn't fought with.
    INSERT INTO tool_policies (pattern, tier, scope, note)
    SELECT 'fs_delete_file', 'confirm', 'always',
           'Ask before deleting any file (default — edit or remove in Settings → Tool Policies).'
    WHERE NOT EXISTS (SELECT 1 FROM tool_policies);
  `);

  console.log('[Artha] Database schema ready at', dbPath);
}

/**
 * Apply additive ALTER TABLE migrations. Split out from `initDatabase` so the
 * caller can wrap it in a Sentry performance transaction (disaster-recovery:
 * migration failures are then tracked as transactions, not just errors). Every
 * block is individually guarded + idempotent, so it is safe to run on every
 * launch and a single bad block can't prevent boot.
 */
export function runMigrations(): void {
  const db = getDb();

  // ── Additive column migrations ───────────────────────────────────────────
  // SQLite's CREATE TABLE IF NOT EXISTS never modifies existing tables, so any
  // column added after the initial release must be back-filled with ALTER TABLE.
  // Each block below follows the same pattern:
  //   1. PRAGMA table_info() to check whether the column already exists.
  //   2. ALTER TABLE … ADD COLUMN (safe — SQLite allows this at any time).
  //   3. Swallow errors so a corrupt sqlite_master row can't prevent boot.

  // Migration v1→v2: citations_json on messages — records web source URLs
  // returned by web_search/web_fetch so the renderer can render citation chips.
  try {
    const cols = db.prepare(`PRAGMA table_info(messages)`).all() as { name: string }[];
    if (!cols.some(c => c.name === 'citations_json')) {
      db.exec(`ALTER TABLE messages ADD COLUMN citations_json TEXT`);
    }
  } catch (err) {
    console.warn('[Artha] citations_json migration skipped:', err);
  }

  // Migration v2→v3: context_window on llm_models — user-configurable max
  // tokens passed to the model; default 4096 keeps existing rows unchanged.
  try {
    const llmCols = db.prepare(`PRAGMA table_info(llm_models)`).all() as { name: string }[];
    if (!llmCols.some(c => c.name === 'context_window')) {
      db.exec(`ALTER TABLE llm_models ADD COLUMN context_window INTEGER NOT NULL DEFAULT 4096`);
    }
  } catch (err) {
    console.warn('[Artha] context_window migration skipped:', err);
  }

  // Migration v3→v4: project_id on chat_sessions — links a session to a
  // project workspace (NULL = general chat with no folder scope).
  try {
    const sessCols = db.prepare(`PRAGMA table_info(chat_sessions)`).all() as { name: string }[];
    if (!sessCols.some(c => c.name === 'project_id')) {
      db.exec(`ALTER TABLE chat_sessions ADD COLUMN project_id TEXT`);
    }
  } catch (err) {
    console.warn('[Artha] project_id migration skipped:', err);
  }

  // Migration v4→v5: rag_index_id + summary on projects — Phase 2/3 columns
  // for auto-built RAG indexes and rolling cross-session project memory.
  try {
    const projCols = db.prepare(`PRAGMA table_info(projects)`).all() as { name: string }[];
    if (projCols.length) {
      if (!projCols.some(c => c.name === 'rag_index_id')) db.exec(`ALTER TABLE projects ADD COLUMN rag_index_id TEXT`);
      if (!projCols.some(c => c.name === 'summary')) db.exec(`ALTER TABLE projects ADD COLUMN summary TEXT`);
    }
  } catch (err) {
    console.warn('[Artha] projects column migration skipped:', err);
  }

  // Migration v5→v6: project_id on memory_entities — scopes a memory to one
  // project (NULL = global, injected in every conversation).
  try {
    const memCols = db.prepare(`PRAGMA table_info(memory_entities)`).all() as { name: string }[];
    if (memCols.length && !memCols.some(c => c.name === 'project_id')) {
      db.exec(`ALTER TABLE memory_entities ADD COLUMN project_id TEXT`);
    }
  } catch (err) {
    console.warn('[Artha] memory project_id migration skipped:', err);
  }

  // Migration v6→v7: is_shared on memory_entities — when 1, the memory is also
  // injected into LAN server sessions so remote teammates share the same context.
  try {
    const memCols2 = db.prepare(`PRAGMA table_info(memory_entities)`).all() as { name: string }[];
    if (memCols2.length && !memCols2.some(c => c.name === 'is_shared')) {
      db.exec(`ALTER TABLE memory_entities ADD COLUMN is_shared INTEGER NOT NULL DEFAULT 0`);
    }
  } catch (err) {
    console.warn('[Artha] memory is_shared migration skipped:', err);
  }

  // Migration v7→v8: member_id + role on api_keys — link a Bearer-token key to
  // the team_members row that owns it, so the LAN server can resolve identity
  // (and role for RBAC on Enterprise) from the token alone. Nullable for keys
  // issued before team mode existed.
  try {
    const akCols = db.prepare(`PRAGMA table_info(api_keys)`).all() as { name: string }[];
    if (akCols.length) {
      if (!akCols.some(c => c.name === 'member_id')) db.exec(`ALTER TABLE api_keys ADD COLUMN member_id TEXT`);
      if (!akCols.some(c => c.name === 'role')) db.exec(`ALTER TABLE api_keys ADD COLUMN role TEXT`);
    }
  } catch (err) {
    console.warn('[Artha] api_keys member_id/role migration skipped:', err);
  }

  // Migration v8→v9: reasoning_steps on messages — stores the agent's internal
  // chain-of-thought trace produced by the <think> phase (JSON array of steps,
  // each optionally carrying a context_score). Surfaced in the UI as an
  // expandable "Thinking" disclosure; NULL for messages from before this column.
  try {
    const msgCols = db.prepare(`PRAGMA table_info(messages)`).all() as { name: string }[];
    if (msgCols.length && !msgCols.some(c => c.name === 'reasoning_steps')) {
      db.exec(`ALTER TABLE messages ADD COLUMN reasoning_steps TEXT`);
    }
  } catch (err) {
    console.warn('[Artha] reasoning_steps migration skipped:', err);
  }

  // Migration v9→v10: origin on chat_sessions — distinguishes user chats from
  // sessions created as the backing store for a Delegate task. Delegate sessions
  // must NOT appear in the Chat sidebar / session lists. Existing rows default
  // to 'chat'; previously-created Delegate task sessions are back-filled by their
  // title prefix so the sidebar is clean on upgrade.
  try {
    const sessCols = db.prepare(`PRAGMA table_info(chat_sessions)`).all() as { name: string }[];
    if (sessCols.length && !sessCols.some(c => c.name === 'origin')) {
      db.exec(`ALTER TABLE chat_sessions ADD COLUMN origin TEXT NOT NULL DEFAULT 'chat'`);
      db.exec(`UPDATE chat_sessions SET origin='delegate' WHERE title LIKE 'Delegate: %'`);
    }
  } catch (err) {
    console.warn('[Artha] chat_sessions origin migration skipped:', err);
  }

  // Migration v10→v11: origin on memory_entities — distinguishes how a memory got
  // here. 'agent' = written by the ReAct loop (the historical default); 'import'
  // = bulk-loaded by the user via Bring-Your-Own-Memory (paste from another AI).
  // Lets the UI badge/filter imported rows and undo a whole import. Defaults to
  // 'agent' so every pre-existing row keeps its original meaning.
  try {
    const memCols3 = db.prepare(`PRAGMA table_info(memory_entities)`).all() as { name: string }[];
    if (memCols3.length && !memCols3.some(c => c.name === 'origin')) {
      db.exec(`ALTER TABLE memory_entities ADD COLUMN origin TEXT NOT NULL DEFAULT 'agent'`);
    }
  } catch (err) {
    console.warn('[Artha] memory origin migration skipped:', err);
  }

  // Migration v11→v12: kind on skills — promotes the capability model from
  // skills-only to skills + first-class agents. Existing rows back-fill to
  // 'skill'; the seeded CRM Agent ships as 'agent'. Additive, constant default.
  try {
    const skillCols = db.prepare(`PRAGMA table_info(skills)`).all() as { name: string }[];
    if (skillCols.length && !skillCols.some(c => c.name === 'kind')) {
      db.exec(`ALTER TABLE skills ADD COLUMN kind TEXT NOT NULL DEFAULT 'skill'`);
    }
  } catch (err) {
    console.warn('[Artha] skills kind migration skipped:', err);
  }

  // Migration v13→v14: pinned_model on skills — lets a skill pin a specific
  // model (ollama_name) for its ReAct loop, set from the dashboard's empirical
  // per-skill model recommendation. NULL (the default) keeps auto-routing.
  try {
    const skillCols2 = db.prepare(`PRAGMA table_info(skills)`).all() as { name: string }[];
    if (skillCols2.length && !skillCols2.some(c => c.name === 'pinned_model')) {
      db.exec(`ALTER TABLE skills ADD COLUMN pinned_model TEXT`);
    }
  } catch (err) {
    console.warn('[Artha] skills pinned_model migration skipped:', err);
  }

  // Cleanup: drop orphan skill_runs whose skill_id has no skills row. These were
  // written by early builds for the synthetic Delegate operator (slug
  // 'delegate-operator', never a real skill) — they never surface in the
  // dashboard (it joins FROM skills) and would otherwise just accumulate. Safe +
  // idempotent: skills is always seeded before migrations run, and the dashboard
  // ignores these rows, so this only removes invisible dead data. After the
  // forward fix (recordSkillInvocation skips non-DB skills) no new ones appear,
  // so this deletes the backlog once and finds nothing thereafter.
  try {
    const hasSkillRuns = db.prepare(
      `SELECT 1 FROM sqlite_master WHERE type='table' AND name='skill_runs'`
    ).get();
    if (hasSkillRuns) {
      db.exec(`DELETE FROM skill_runs WHERE skill_id NOT IN (SELECT skill_id FROM skills)`);
    }
  } catch (err) {
    console.warn('[Artha] orphan skill_runs cleanup skipped:', err);
  }

  // Migration v12→v13: actor on tool_audit_log — records WHO initiated each tool
  // call ('local' = the desktop user; a team-member name/id for LAN requests).
  // Required for the B2B compliance story ("which teammate ran what tool").
  // Existing rows default to 'local' so pre-team history stays attributable.
  try {
    const auditCols = db.prepare(`PRAGMA table_info(tool_audit_log)`).all() as { name: string }[];
    if (auditCols.length && !auditCols.some(c => c.name === 'actor')) {
      db.exec(`ALTER TABLE tool_audit_log ADD COLUMN actor TEXT NOT NULL DEFAULT 'local'`);
    }
  } catch (err) {
    console.warn('[Artha] tool_audit_log actor migration skipped:', err);
  }

  // Migration v13→v14: credentials_enc on tools — encrypted per-connector
  // secrets (API keys/tokens/connection strings) for MCP servers that need
  // auth. NULL for no-auth connectors and for servers installed before this
  // column existed (they keep working; user re-enters keys to enable auth).
  try {
    const toolCols = db.prepare(`PRAGMA table_info(tools)`).all() as { name: string }[];
    if (toolCols.length && !toolCols.some(c => c.name === 'credentials_enc')) {
      db.exec(`ALTER TABLE tools ADD COLUMN credentials_enc TEXT`);
    }
  } catch (err) {
    console.warn('[Artha] tools credentials_enc migration skipped:', err);
  }

  // Migration v14→v15: conn_status + conn_error on tools — per-server connection
  // health so the UI can distinguish "installed and live" from "installed but
  // failed to connect" (and offer Retry) instead of showing every row as
  // connected. Both nullable; existing rows reconcile on the next connect.
  try {
    const toolCols = db.prepare(`PRAGMA table_info(tools)`).all() as { name: string }[];
    if (toolCols.length) {
      if (!toolCols.some(c => c.name === 'conn_status')) db.exec(`ALTER TABLE tools ADD COLUMN conn_status TEXT`);
      if (!toolCols.some(c => c.name === 'conn_error')) db.exec(`ALTER TABLE tools ADD COLUMN conn_error TEXT`);
    }
  } catch (err) {
    console.warn('[Artha] tools conn_status/conn_error migration skipped:', err);
  }

  // Migration v15→v16: default_skill_id on projects — a per-project default
  // skill that auto-activates in the project's chats when the user didn't
  // invoke one explicitly (/slug) and auto-match found nothing. Nullable;
  // NULL = no default (existing behaviour). Part of the Project Context Hub.
  try {
    const projCols2 = db.prepare(`PRAGMA table_info(projects)`).all() as { name: string }[];
    if (projCols2.length && !projCols2.some(c => c.name === 'default_skill_id')) {
      db.exec(`ALTER TABLE projects ADD COLUMN default_skill_id TEXT`);
    }
  } catch (err) {
    console.warn('[Artha] projects default_skill_id migration skipped:', err);
  }

  // Migration v16→v17: context_pack_id on chat_sessions — which Context Pack
  // (if any) is applied to this chat. By-reference: the orchestrator reads the
  // pack's skill + pinned memories through this id at run time; scopes were
  // copied physically at apply time. Nullable; NULL = no pack.
  try {
    const sessCols2 = db.prepare(`PRAGMA table_info(chat_sessions)`).all() as { name: string }[];
    if (sessCols2.length && !sessCols2.some(c => c.name === 'context_pack_id')) {
      db.exec(`ALTER TABLE chat_sessions ADD COLUMN context_pack_id TEXT`);
    }
  } catch (err) {
    console.warn('[Artha] chat_sessions context_pack_id migration skipped:', err);
  }

  // Migration v17→v18: embedding on memory_entities — cached nomic-embed-text
  // vector (JSON float array) computed once at write time. Semantic memory
  // ranking previously re-embedded every candidate on EVERY message (up to 40
  // sequential Ollama calls per turn); with the cache each turn embeds only
  // the query. NULL = not yet embedded (lazily backfilled during ranking).
  try {
    const memCols4 = db.prepare(`PRAGMA table_info(memory_entities)`).all() as { name: string }[];
    if (memCols4.length && !memCols4.some(c => c.name === 'embedding')) {
      db.exec(`ALTER TABLE memory_entities ADD COLUMN embedding TEXT`);
    }
  } catch (err) {
    console.warn('[Artha] memory embedding migration skipped:', err);
  }

  // Migration v18→v19: is_shared on context_packs — when 1, the pack is listed
  // on the LAN hub's GET /packs and can be applied to LAN sessions via
  // POST /chat { packId }. Gated by the sharedPacks (Team/Business)
  // entitlement. Mirrors the memory_entities is_shared migration (v6→v7).
  try {
    const packCols = db.prepare(`PRAGMA table_info(context_packs)`).all() as { name: string }[];
    if (packCols.length && !packCols.some(c => c.name === 'is_shared')) {
      db.exec(`ALTER TABLE context_packs ADD COLUMN is_shared INTEGER NOT NULL DEFAULT 0`);
    }
  } catch (err) {
    console.warn('[Artha] context_packs is_shared migration skipped:', err);
  }

  // Migration v19→v20: seal plaintext BYOK api_keys at rest. runMigrations()
  // executes post-`ready`, so Electron safeStorage is usable here. Idempotent
  // (already-sealed rows and the 'ollama' placeholder are skipped); a row that
  // fails to seal keeps working via openSecretString's plaintext passthrough
  // and is retried on the next launch.
  try {
    const { sealed, failed } = sealPlaintextApiKeys(db);
    if (sealed || failed) {
      console.log(`[Artha] api_key seal migration: ${sealed} sealed, ${failed} failed.`);
    }
  } catch (err) {
    console.warn('[Artha] api_key seal migration skipped:', err);
  }

  console.log('[Artha] Database migrations applied.');
}
