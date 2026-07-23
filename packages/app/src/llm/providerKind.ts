/**
 * Provider classification — the ONE place that answers "is this llm_models row
 * managed by the local Ollama runtime?".
 *
 * Everything lifecycle-shaped keys off this: warm-up, unload, server
 * auto-start, the startup status banner, and (later) runtime health checks.
 * Before this existed, `ollamaRuntime` read the active row provider-blind and
 * happily POSTed cloud model names at localhost:11434 — silent no-ops for the
 * user, misleading "warming/ready" states in the UI.
 *
 * Pure + electron-free so it unit-tests without mocks.
 */

/** Matches the Ollama default port on any local host spelling. */
const OLLAMA_LOCAL_URL = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:11434)(\/|$)/i;

/**
 * True when the row's model lifecycle belongs to the local Ollama daemon.
 * Trusts the provider id first; falls back to the base_url shape for legacy
 * rows written before the provider column was reliably populated.
 */
export function isOllamaManaged(
  provider: string | null | undefined,
  baseUrl: string | null | undefined,
): boolean {
  if (provider && provider !== 'ollama') return false;
  if (provider === 'ollama' && !baseUrl) return true;
  return !!baseUrl && OLLAMA_LOCAL_URL.test(baseUrl);
}

/**
 * Canonical provider id for a row, repairing the one known legacy
 * inconsistency: rows stamped 'ollama' (the schema default) whose base_url
 * points somewhere non-local. Those are user-added OpenAI-compatible
 * endpoints from before provider ids were enforced → 'custom'.
 */
export function normalizeProvider(
  provider: string | null | undefined,
  baseUrl: string | null | undefined,
): string {
  const p = (provider ?? '').trim().toLowerCase();
  if (!p || p === 'ollama') {
    return isOllamaManaged('ollama', baseUrl ?? 'http://localhost:11434/v1') ? 'ollama' : 'custom';
  }
  return p;
}

/** Minimal DB surface for the normalization migration (unit-testable). */
export interface ProviderMigrationDb {
  prepare(sql: string): {
    all(...args: unknown[]): unknown[];
    run(...args: unknown[]): unknown;
  };
}

/**
 * Launch migration: stamp the canonical provider id onto rows where the
 * stored value and the base_url disagree (legacy 'ollama'-default rows with
 * remote URLs). Idempotent; additive only — never rewrites a deliberate id.
 */
export function normalizeProviderIds(db: ProviderMigrationDb): number {
  const rows = db
    .prepare(`SELECT model_id, provider, base_url FROM llm_models`)
    .all() as { model_id: string; provider: string | null; base_url: string | null }[];
  const update = db.prepare(`UPDATE llm_models SET provider=? WHERE model_id=?`);
  let changed = 0;
  for (const row of rows) {
    const canonical = normalizeProvider(row.provider, row.base_url);
    if (canonical !== (row.provider ?? '')) {
      update.run(canonical, row.model_id);
      changed++;
    }
  }
  return changed;
}
