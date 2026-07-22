/**
 * Secret-at-rest helper for MCP connector credentials (API keys, tokens,
 * connection strings).
 *
 * Credentials are encrypted with Electron's `safeStorage`, which is backed by
 * the OS keychain (macOS Keychain, Windows DPAPI, Linux libsecret/kwallet).
 * The ciphertext is stored as a base64 string in the local SQLite DB and is
 * never written in plaintext. A connector's secrets therefore stay on the
 * user's machine and are only ever handed to that connector's own child
 * process as environment variables at spawn time.
 *
 * Storage format (the string persisted in `tools.credentials_enc`):
 *   "v1:enc:<base64 ciphertext>"   — OS-encrypted. The ONLY persistent form
 *                                    that may be WRITTEN.
 *   "v1:raw:<base64 utf8 json>"    — LEGACY READ-ONLY. Older builds wrote this
 *                                    when no keychain existed; base64 is not
 *                                    encryption, so writing it is prohibited
 *                                    (Commit 3.5). Existing rows still open;
 *                                    reseal-on-read lands with the oauth_tokens
 *                                    sealing commit.
 *
 * When no trustworthy keychain is available, `sealCredentials` THROWS
 * (SecureStorageUnavailableError) and the install flow must refuse the save
 * with remediation — connectors without credentials keep working. Trustworthy
 * means more than `isEncryptionAvailable()`: Linux `basic_text` (static
 * in-binary key) is treated as unavailable — see secretString.ts.
 */
import { safeStorage } from 'electron';
import { isSecretEncryptionAvailable, SecureStorageUnavailableError } from './secretString';

/**
 * A connector's resolved secrets, in the exact form the spawn needs:
 *   - `env`:  environment variables handed to the child process.
 *   - `args`: extra command-line arguments appended after the base install
 *             command (e.g. a Postgres connection string).
 * Storing it pre-split means the registry can apply credentials without
 * re-deriving which field is an env var vs an arg from the catalog — so custom
 * (non-catalog) servers work too.
 */
export interface StoredCredentials {
  env?: Record<string, string>;
  args?: string[];
}

const ENC_PREFIX = 'v1:enc:';
const RAW_PREFIX = 'v1:raw:';

/** True when a TRUSTWORTHY OS keychain is available to encrypt secrets at
 *  rest. Delegates to the single policy source (secretString.ts), which also
 *  rejects Linux `basic_text` and honors the ARTHA_FORCE_NO_KEYCHAIN QA flag. */
export function isAtRestEncryptionAvailable(): boolean {
  return isSecretEncryptionAvailable();
}

/**
 * Encrypt a credential map into the opaque string stored in the DB. Returns
 * `null` for an empty/absent map so callers can store SQL NULL (no credentials).
 * Throws SecureStorageUnavailableError when credentials are present but no
 * trustworthy keychain exists — persistent reversible-obfuscation storage is
 * prohibited; the caller refuses the install with remediation guidance.
 */
export function sealCredentials(creds: StoredCredentials | null | undefined): string | null {
  const hasEnv = creds?.env && Object.keys(creds.env).length > 0;
  const hasArgs = creds?.args && creds.args.length > 0;
  if (!creds || (!hasEnv && !hasArgs)) return null;
  if (!isAtRestEncryptionAvailable()) throw new SecureStorageUnavailableError();
  const json = JSON.stringify(creds);
  return ENC_PREFIX + safeStorage.encryptString(json).toString('base64');
}

/** Minimal DB surface (mirrors secretString.ts) so the reseal migration is
 *  unit-testable without better-sqlite3. */
export interface CredsMigrationDb {
  prepare(sql: string): {
    all(...args: unknown[]): unknown[];
    run(...args: unknown[]): unknown;
  };
}

/**
 * Launch migration (register R5): re-seal legacy `v1:raw:` MCP credential
 * blobs written by older builds on keychain-less systems. Runs only when a
 * trustworthy keychain exists; raw rows are otherwise left as-is (they still
 * open read-only). Per-row failure isolation; sanitized logging.
 */
export function resealRawCredentialBlobs(db: CredsMigrationDb): number {
  if (!isAtRestEncryptionAvailable()) return 0;
  const rows = db
    .prepare(`SELECT tool_id, credentials_enc FROM tools WHERE credentials_enc LIKE '${RAW_PREFIX}%'`)
    .all() as { tool_id: string; credentials_enc: string }[];
  let resealed = 0;
  for (const row of rows) {
    try {
      const creds = openCredentials(row.credentials_enc);
      const sealed = sealCredentials(creds);
      db.prepare(`UPDATE tools SET credentials_enc=? WHERE tool_id=?`).run(sealed, row.tool_id);
      resealed++;
    } catch (err) {
      console.warn(`[Artha] credential reseal failed for tool ${row.tool_id}:`, (err as Error)?.name ?? 'Error');
    }
  }
  return resealed;
}

/**
 * Decrypt a blob produced by `sealCredentials` back into a credential map.
 * Returns `{}` for null/blank input. Throws only on a genuinely corrupt blob
 * (callers treat that connector as having no usable credentials).
 */
export function openCredentials(blob: string | null | undefined): StoredCredentials {
  if (!blob) return {};
  if (blob.startsWith(ENC_PREFIX)) {
    const cipher = Buffer.from(blob.slice(ENC_PREFIX.length), 'base64');
    const json = safeStorage.decryptString(cipher);
    return JSON.parse(json) as StoredCredentials;
  }
  if (blob.startsWith(RAW_PREFIX)) {
    const json = Buffer.from(blob.slice(RAW_PREFIX.length), 'base64').toString('utf8');
    return JSON.parse(json) as StoredCredentials;
  }
  // Unknown/legacy format — fail closed (no credentials) rather than throw, so a
  // single bad row can't stop the whole registry from loading.
  return {};
}
