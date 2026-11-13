/**
 * DDL for the `interactions` table — the unified human-in-the-loop frame
 * (agent/interactions.ts). Kept in its own dependency-free module so the main
 * schema bootstrap (db/schema.ts) and the persistence tests execute the exact
 * same statement against a real SQLite file.
 *
 * Additive only: CREATE TABLE IF NOT EXISTS, never altered in place.
 */
export const INTERACTIONS_TABLE_SQL = `
  -- Unified human-in-the-loop interactions: every time a run pauses for a
  -- person (ask_user question, plan approval, browser handoff, tool confirm)
  -- one row is written here. A pending row survives a renderer reload so the
  -- UI can re-show it; status is the only thing that changes afterwards.
  CREATE TABLE IF NOT EXISTS interactions (
    id          TEXT PRIMARY KEY,
    run_id      TEXT NOT NULL,
    kind        TEXT NOT NULL CHECK(kind IN ('ask','plan','handoff','confirm')),
    payload     TEXT NOT NULL DEFAULT '{}',
    status      TEXT NOT NULL DEFAULT 'pending'
                CHECK(status IN ('pending','answered','declined','expired')),
    answer_json TEXT,
    created_at  INTEGER NOT NULL DEFAULT (unixepoch()),
    answered_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_interactions_status ON interactions(status, created_at);
  CREATE INDEX IF NOT EXISTS idx_interactions_run ON interactions(run_id);
`;
