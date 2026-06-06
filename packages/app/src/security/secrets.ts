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
 *   "v1:enc:<base64 ciphertext>"   — OS-encrypted (normal case)
 *   "v1:raw:<base64 utf8 json>"    — fallback when OS encryption is unavailable
 *
 * The version+mode prefix lets us evolve the format and lets the reader tell an
 * encrypted blob from a fallback one without guessing. Fallback only triggers
 * on platforms where `safeStorage.isEncryptionAvailable()` is false (e.g. a
 * Linux box with no keyring/secret-service); we still function there, but the
 * blob is only base64-obfuscated, so `isAtRestEncrypted()` lets the UI warn.
 */
import { safeStorage } from 'electron';

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

/** True when the OS-backed keychain is available to encrypt secrets at rest.
 *  When false, `sealCredentials` falls back to base64 and the UI should warn. */
export function isAtRestEncryptionAvailable(): boolean {
  try {
    return safeStorage.isEncryptionAvailable();
  } catch {
    return false;
  }
}

/**
 * Encrypt a credential map into the opaque string stored in the DB. Returns
 * `null` for an empty/absent map so callers can store SQL NULL (no credentials).
 */
export function sealCredentials(creds: StoredCredentials | null | undefined): string | null {
  const hasEnv = creds?.env && Object.keys(creds.env).length > 0;
  const hasArgs = creds?.args && creds.args.length > 0;
  if (!creds || (!hasEnv && !hasArgs)) return null;
  const json = JSON.stringify(creds);
  if (isAtRestEncryptionAvailable()) {
    const cipher = safeStorage.encryptString(json); // Buffer
    return ENC_PREFIX + cipher.toString('base64');
  }
  // Keychain unavailable — store base64 so the connector still works, but it is
  // NOT encrypted at rest. isAtRestEncryptionAvailable() === false lets the UI
  // surface this to the user.
  return RAW_PREFIX + Buffer.from(json, 'utf8').toString('base64');
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
