/**
 * DDL for the outbox (type-while-Artha-works queue). Kept in its own
 * dependency-free module so `schema.ts` (which needs Electron) and the vitest
 * suites (which run against an in-memory SQLite) execute the exact same SQL.
 *
 * Additive only: CREATE TABLE IF NOT EXISTS + an index. The per-session pause
 * flag lives on chat_sessions and is added by runMigrations() (guarded ALTER).
 */
export const OUTBOX_SCHEMA_SQL = `
    -- Outbox: messages the user typed while a run was active in the session.
    -- Drained one at a time (lowest position first) when the run ends, or
    -- injected at the next ReAct tool-call boundary when "steer now" is used.
    -- status: ready → sending → sent (exactly-once via a guarded UPDATE),
    -- editing (held while the user edits it), cancelled (deleted by the user).
    CREATE TABLE IF NOT EXISTS outbox (
      id               TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
      session_id       TEXT NOT NULL REFERENCES chat_sessions(session_id) ON DELETE CASCADE,
      position         INTEGER NOT NULL DEFAULT 0,
      status           TEXT NOT NULL DEFAULT 'ready'
                       CHECK(status IN ('ready','sending','editing','sent','cancelled')),
      content          TEXT NOT NULL DEFAULT '',
      attachments_json TEXT,
      created_at       INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at       INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE INDEX IF NOT EXISTS idx_outbox_session ON outbox(session_id, status, position);
`;
