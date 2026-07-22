/**
 * Secret-at-rest helper for SINGLE STRING secrets — BYOK provider API keys
 * (`llm_models.api_key`) today, any future scalar credential tomorrow.
 *
 * Same storage envelope as ./secrets.ts (MCP credential maps) so the DB holds
 * exactly one at-rest format family:
 *   "v1:enc:<base64 ciphertext>"  — OS-keychain encrypted via safeStorage
 *   "v1:raw:<base64 utf8>"        — fallback when no OS keychain is available
 *                                   (base64 obfuscation ONLY — callers must
 *                                   surface this honestly, never silently)
 *
 * The "v1" prefix is the key-version hook: a future re-encryption scheme ships
 * as "v2:" and the reader dispatches on prefix, so old rows keep opening.
 *
 * Two values are deliberately NEVER sealed:
 *   - the local placeholder 'ollama' (not a secret; also the schema DEFAULT)
 *   - empty/blank strings
 *
 * `openSecretString` passes unknown (legacy plaintext) values through
 * unchanged. That is the migration safety net: a row the launch-time
 * migration failed to seal keeps working, and the next successful migration
 * pass seals it. We never brick a configured provider over encryption state.
 */
import { safeStorage } from 'electron';

const ENC_PREFIX = 'v1:enc:';
const RAW_PREFIX = 'v1:raw:';

/** The non-secret placeholder used for local (Ollama/LM Studio/llama.cpp)
 *  rows, where OpenAI-compat servers just need any bearer string. */
export const LOCAL_API_KEY_PLACEHOLDER = 'ollama';

/** True when the OS-backed keychain can encrypt secrets at rest. Mirrors
 *  secrets.ts — exposed separately so callers don't cross-import. */
export function isSecretEncryptionAvailable(): boolean {
  try {
    return safeStorage.isEncryptionAvailable();
  } catch {
    return false;
  }
}

/** Is this stored value already in the sealed envelope (either mode)? */
export function isSealedSecret(value: string | null | undefined): boolean {
  return !!value && (value.startsWith(ENC_PREFIX) || value.startsWith(RAW_PREFIX));
}

/** Should this value be sealed at all? Placeholders and blanks stay as-is. */
export function isSealableSecret(value: string | null | undefined): value is string {
  return !!value && value.trim() !== '' && value !== LOCAL_API_KEY_PLACEHOLDER && !isSealedSecret(value);
}

/**
 * Seal a plaintext secret into the at-rest envelope. Placeholder/blank/already-
 * sealed values are returned unchanged so every write path can call this
 * unconditionally.
 */
export function sealSecretString(plain: string): string {
  if (!isSealableSecret(plain)) return plain;
  if (isSecretEncryptionAvailable()) {
    return ENC_PREFIX + safeStorage.encryptString(plain).toString('base64');
  }
  // No keychain: obfuscate only. isSecretEncryptionAvailable() === false lets
  // the UI show the honest "not encrypted at rest" state (never silent).
  return RAW_PREFIX + Buffer.from(plain, 'utf8').toString('base64');
}

/**
 * Open a stored value back to plaintext. Sealed envelopes are decoded; any
 * other value (placeholder or legacy plaintext) passes through unchanged.
 * Returns the placeholder on a corrupt sealed blob rather than throwing, so a
 * damaged row degrades to an auth error from the provider, not a crash.
 */
export function openSecretString(stored: string | null | undefined): string {
  if (!stored) return LOCAL_API_KEY_PLACEHOLDER;
  try {
    if (stored.startsWith(ENC_PREFIX)) {
      return safeStorage.decryptString(Buffer.from(stored.slice(ENC_PREFIX.length), 'base64'));
    }
    if (stored.startsWith(RAW_PREFIX)) {
      return Buffer.from(stored.slice(RAW_PREFIX.length), 'base64').toString('utf8');
    }
    return stored;
  } catch {
    return LOCAL_API_KEY_PLACEHOLDER;
  }
}

/** Minimal DB surface so the migration is unit-testable without better-sqlite3. */
export interface SecretMigrationDb {
  prepare(sql: string): {
    all(...args: unknown[]): unknown[];
    run(...args: unknown[]): unknown;
  };
}

/**
 * One-time (idempotent) launch migration: seal every plaintext BYOK api_key
 * already sitting in `llm_models`. Runs inside `runMigrations()` — i.e. after
 * Electron `ready`, when safeStorage is usable.
 *
 * Failure handling: each row is sealed independently; one bad row is logged
 * and skipped, never aborting the rest. Unsealed rows keep working via the
 * `openSecretString` plaintext passthrough and are retried next launch.
 */
export function sealPlaintextApiKeys(db: SecretMigrationDb): { sealed: number; failed: number } {
  let sealed = 0;
  let failed = 0;
  const rows = db
    .prepare(`SELECT model_id, api_key FROM llm_models`)
    .all() as { model_id: string; api_key: string | null }[];
  const update = db.prepare(`UPDATE llm_models SET api_key=? WHERE model_id=?`);
  for (const row of rows) {
    if (!isSealableSecret(row.api_key)) continue;
    try {
      update.run(sealSecretString(row.api_key), row.model_id);
      sealed++;
    } catch (err) {
      failed++;
      // Log WITHOUT the key material — model_id only.
      console.warn(`[Artha] api_key seal failed for model ${row.model_id}:`, err);
    }
  }
  return { sealed, failed };
}
