/**
 * Execution profiles v0 (Phase A commit 10).
 *
 * The schema + implicit Default profile only. In v0 the `is_active` flag on
 * llm_models REMAINS the single source of truth for which model chats — the
 * Default profile records the mode and reserves the per-capability model
 * slots, budgets, and policies that Phase B routing fills in. This keeps
 * existing users' behaviour byte-identical while the abstraction lands.
 *
 * Founder escalation trigger noted: if Phase B needs to change this schema
 * materially, that pauses for review (approved-direction rule).
 */

export type ExecutionMode = 'local' | 'byok' | 'byoc' | 'managed' | 'hybrid';

export interface ExecutionProfile {
  profile_id: string;
  name: string;
  mode: ExecutionMode;
  chat_model_id: string | null;
  reasoning_model_id: string | null;
  coding_model_id: string | null;
  embedding_model_id: string | null;
  vision_model_id: string | null;
  browser_model_id: string | null;
  tool_model_id: string | null;
  fallbacks_json: string;          // JSON array of model_ids
  escalation_policy: 'local_only' | 'prefer_local' | 'prefer_cloud' | 'ask' | 'budget';
  data_rules_json: string;         // JSON; PolicyEvaluator input (Phase B)
  budget_cents_month: number | null;
  latency_pref: 'fast' | 'balanced' | 'quality';
  privacy_level: 'strict' | 'standard';
  offline_behaviour: 'local_fallback' | 'fail';
  is_default: number;
}

/** Minimal DB surface (unit-testable without better-sqlite3). */
export interface ProfileDb {
  prepare(sql: string): {
    get(...args: unknown[]): unknown;
    all(...args: unknown[]): unknown[];
    run(...args: unknown[]): unknown;
  };
  exec(sql: string): unknown;
}

export const EXECUTION_PROFILES_DDL = `
    CREATE TABLE IF NOT EXISTS execution_profiles (
      profile_id          TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
      name                TEXT NOT NULL,
      mode                TEXT NOT NULL DEFAULT 'local',
      chat_model_id       TEXT,
      reasoning_model_id  TEXT,
      coding_model_id     TEXT,
      embedding_model_id  TEXT,
      vision_model_id     TEXT,
      browser_model_id    TEXT,
      tool_model_id       TEXT,
      fallbacks_json      TEXT NOT NULL DEFAULT '[]',
      escalation_policy   TEXT NOT NULL DEFAULT 'prefer_local',
      data_rules_json     TEXT NOT NULL DEFAULT '{}',
      budget_cents_month  INTEGER,
      latency_pref        TEXT NOT NULL DEFAULT 'balanced',
      privacy_level       TEXT NOT NULL DEFAULT 'standard',
      offline_behaviour   TEXT NOT NULL DEFAULT 'local_fallback',
      is_default          INTEGER NOT NULL DEFAULT 0,
      created_at          INTEGER NOT NULL DEFAULT (unixepoch())
    );
`;

/** Derive the Default profile's mode from what the user actually runs. */
export function deriveModeFromActive(row: { provider?: string | null; base_url?: string | null } | undefined): ExecutionMode {
  if (!row) return 'local';
  const p = (row.provider ?? 'ollama').toLowerCase();
  if (p === 'ollama') return 'local';
  return 'byok';
}

/**
 * Launch migration: create the table and synthesize ONE implicit "Default"
 * profile from the current active model. Idempotent; existing users see
 * zero behaviour change (chat_model_id stays NULL = "inherit is_active").
 */
export function ensureDefaultProfile(db: ProfileDb): { created: boolean; mode: ExecutionMode } {
  db.exec(EXECUTION_PROFILES_DDL);
  const existing = db.prepare(`SELECT profile_id, mode FROM execution_profiles WHERE is_default=1 LIMIT 1`).get() as
    { profile_id: string; mode: ExecutionMode } | undefined;
  if (existing) return { created: false, mode: existing.mode };
  const active = db.prepare(`SELECT provider, base_url FROM llm_models WHERE is_active=1 LIMIT 1`).get() as
    { provider?: string; base_url?: string } | undefined;
  const mode = deriveModeFromActive(active);
  db.prepare(
    `INSERT INTO execution_profiles (name, mode, is_default) VALUES ('Default', ?, 1)`
  ).run(mode);
  return { created: true, mode };
}

/** The default profile (always exists after migration). */
export function getDefaultProfile(db: ProfileDb): ExecutionProfile | undefined {
  return db.prepare(`SELECT * FROM execution_profiles WHERE is_default=1 LIMIT 1`).get() as
    ExecutionProfile | undefined;
}
