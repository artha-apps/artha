/**
 * Secret-at-rest helper for SINGLE STRING secrets — BYOK provider API keys
 * (`llm_models.api_key`) today, any future scalar credential tomorrow.
 *
 * Storage envelope (shared family with ./secrets.ts):
 *   "v1:enc:<base64 ciphertext>"  — OS-keychain encrypted via safeStorage.
 *                                   The ONLY permitted persistent form.
 *   "v1:session"                  — sentinel: the real key lives in process
 *                                   memory (./sessionKeys.ts) and is gone
 *                                   after restart. Zero secret material.
 *   "v1:raw:<base64 utf8>"        — LEGACY READ-ONLY. Never written anymore:
 *                                   base64 is not storage, it is decoration.
 *                                   Rows found in this form are resealed when
 *                                   a trustworthy keychain exists, else locked.
 *
 * Policy (founder directive, Commit 3.5): when no trustworthy OS keychain is
 * available, Artha does NOT persist credentials in any reversible form. The
 * caller must offer session-only use or refuse the save with remediation.
 *
 * "Trustworthy" is stricter than safeStorage.isEncryptionAvailable(): on
 * Linux, Chromium's `basic_text` backend reports available while encrypting
 * with a static key baked into the Chromium source — an application-wide
 * static key, which the policy explicitly prohibits. We check the selected
 * backend and treat `basic_text` as unavailable.
 *
 * The "v1" prefix is the key-version hook: a future scheme ships as "v2:" and
 * the reader dispatches on prefix, so old rows keep opening.
 */
import { safeStorage } from 'electron';

const ENC_PREFIX = 'v1:enc:';
const RAW_PREFIX = 'v1:raw:';
export const SESSION_SENTINEL = 'v1:session';

/** The non-secret placeholder used for local (Ollama/LM Studio/llama.cpp)
 *  rows, where OpenAI-compat servers just need any bearer string. */
export const LOCAL_API_KEY_PLACEHOLDER = 'ollama';

/** Thrown when a persistent save is requested but no trustworthy keychain
 *  exists. Callers surface `message` and offer session-only use. */
export class SecureStorageUnavailableError extends Error {
  readonly code = 'SECURE_STORAGE_UNAVAILABLE';
  constructor() {
    super(
      'No secure OS keychain is available, so Artha will not save this key to disk. ' +
      'Use it for this session only, or enable a system keychain ' +
      '(e.g. GNOME Keyring / KWallet with Secret Service on Linux) and try again.'
    );
    this.name = 'SecureStorageUnavailableError';
  }
}

/** Thrown when a stored credential exists but may not be used: legacy
 *  plaintext/raw row on a system without a trustworthy keychain. The key is
 *  NOT destroyed — it is locked until the user fixes secure storage or
 *  re-enters it for the session. */
export class CredentialLockedError extends Error {
  readonly code = 'CREDENTIAL_LOCKED';
  constructor() {
    super(
      'This provider’s saved API key predates secure storage and no OS keychain is ' +
      'available to migrate it. Enable a system keychain and restart Artha, or re-enter ' +
      'the key in Settings → Models to use it for this session.'
    );
    this.name = 'CredentialLockedError';
  }
}

/** Thrown when a session-only key was configured but the session that held it
 *  is gone (app restarted). Honest state; the user re-enters the key. */
export class SessionKeyExpiredError extends Error {
  readonly code = 'SESSION_KEY_EXPIRED';
  constructor() {
    super(
      'This provider’s API key was kept for the previous session only and was cleared ' +
      'when Artha closed. Re-enter it in Settings → Models.'
    );
    this.name = 'SessionKeyExpiredError';
  }
}

/**
 * True when the OS provides a keychain we actually trust for persistence.
 * Stricter than safeStorage.isEncryptionAvailable(): Linux `basic_text`
 * (static in-binary key) counts as UNAVAILABLE.
 *
 * `ARTHA_FORCE_NO_KEYCHAIN=1` is a dev/QA override that forces the
 * unavailable state so session-only flows are testable on macOS/Windows.
 * It FAILS SAFE: it can only make storage stricter, never weaker.
 */
export function isSecretEncryptionAvailable(): boolean {
  if (process.env.ARTHA_FORCE_NO_KEYCHAIN === '1') return false;
  try {
    if (!safeStorage.isEncryptionAvailable()) return false;
    if (process.platform === 'linux') {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const backend = (safeStorage as any).getSelectedStorageBackend?.() as string | undefined;
      if (backend === 'basic_text') return false;
    }
    return true;
  } catch {
    return false;
  }
}

/** Is this stored value in the sealed-envelope family (any mode)? */
export function isSealedSecret(value: string | null | undefined): boolean {
  return !!value && (value.startsWith(ENC_PREFIX) || value.startsWith(RAW_PREFIX) || value === SESSION_SENTINEL);
}

/** Should this value be sealed at all? Placeholders, blanks, and
 *  already-enveloped values are not sealable plaintext. */
export function isSealableSecret(value: string | null | undefined): value is string {
  return !!value && value.trim() !== '' && value !== LOCAL_API_KEY_PLACEHOLDER && !isSealedSecret(value);
}

/**
 * Seal a plaintext secret for PERSISTENT storage. Placeholder/blank/already-
 * sealed values pass through unchanged. Throws SecureStorageUnavailableError
 * when no trustworthy keychain exists — there is deliberately no fallback:
 * base64/reversible-obfuscation persistence is prohibited.
 */
export function sealSecretString(plain: string): string {
  if (!isSealableSecret(plain)) return plain;
  if (!isSecretEncryptionAvailable()) throw new SecureStorageUnavailableError();
  return ENC_PREFIX + safeStorage.encryptString(plain).toString('base64');
}

/**
 * Open a stored envelope back to plaintext. Handles enc + legacy raw reads.
 * Session sentinels and legacy plaintext are NOT resolved here — use
 * `resolveApiKey` (llm/client.ts) which applies the use-policy. Returns the
 * placeholder for null/blank and for corrupt sealed blobs (degrades to a
 * provider auth error rather than a crash).
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

/** True for a value stored in the legacy raw (base64) envelope. */
export function isRawEnvelope(value: string | null | undefined): boolean {
  return !!value && value.startsWith(RAW_PREFIX);
}

/** Minimal DB surface so the migration is unit-testable without better-sqlite3. */
export interface SecretMigrationDb {
  prepare(sql: string): {
    all(...args: unknown[]): unknown[];
    run(...args: unknown[]): unknown;
  };
}

export interface SealMigrationResult {
  sealed: number;
  failed: number;
  /** Rows left untouched because no trustworthy keychain exists. They are
   *  LOCKED (resolveApiKey refuses them), not silently used. */
  pending: number;
  /** Post-pass verification: count of rows still holding sealable plaintext
   *  or raw envelopes. 0 after a fully successful migration. */
  unsealedRemaining: number;
}

/**
 * Launch migration (idempotent): seal every plaintext or legacy-raw api_key
 * in `llm_models`. Runs inside `runMigrations()` (post-`ready`).
 *
 * - Trustworthy keychain absent → touch NOTHING (never destroy a credential),
 *   report rows as `pending`; the read path locks them until resolved.
 * - Each row seals independently; one failure never aborts the rest.
 * - Never logs key material — sanitized counts only.
 * - Ends with a verification scan; the caller checkpoints the WAL and VACUUMs
 *   when rows were sealed so old plaintext bytes don't survive in WAL frames
 *   or freelist pages.
 */
export function sealPlaintextApiKeys(db: SecretMigrationDb): SealMigrationResult {
  const scan = () =>
    (db.prepare(`SELECT model_id, api_key FROM llm_models`).all() as
      { model_id: string; api_key: string | null }[]);

  const needsSealing = (v: string | null) => isSealableSecret(v) || isRawEnvelope(v);

  let sealed = 0;
  let failed = 0;
  let pending = 0;

  const rows = scan();
  if (!isSecretEncryptionAvailable()) {
    pending = rows.filter(r => needsSealing(r.api_key)).length;
    return { sealed, failed, pending, unsealedRemaining: pending };
  }

  const update = db.prepare(`UPDATE llm_models SET api_key=? WHERE model_id=?`);
  for (const row of rows) {
    if (!needsSealing(row.api_key)) continue;
    try {
      const plain = isRawEnvelope(row.api_key) ? openSecretString(row.api_key) : (row.api_key as string);
      update.run(sealSecretString(plain), row.model_id);
      sealed++;
    } catch (err) {
      failed++;
      // Sanitized: model_id + error class only, never the value.
      console.warn(`[Artha] api_key seal failed for model ${row.model_id}:`, (err as Error)?.name ?? 'Error');
    }
  }

  const unsealedRemaining = scan().filter(r => needsSealing(r.api_key)).length;
  return { sealed, failed, pending, unsealedRemaining };
}
