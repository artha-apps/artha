/**
 * Tests for the connector-credential secret store. Electron's `safeStorage` is
 * mocked two ways — encryption-available (the normal case) and unavailable (the
 * base64 fallback) — to prove the seal→open roundtrip holds in both, and that
 * the storage format/prefixes behave as the registry and UI rely on.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mutable flag the mock reads so each test can flip keychain availability.
let encryptionAvailable = true;

vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => encryptionAvailable,
    // Reversible stand-in for the OS keychain: tag + base64 so decrypt is exact.
    encryptString: (s: string) => Buffer.from('K:' + s, 'utf8'),
    decryptString: (buf: Buffer) => buf.toString('utf8').replace(/^K:/, ''),
  },
}));

import {
  sealCredentials,
  openCredentials,
  isAtRestEncryptionAvailable,
  type StoredCredentials,
} from './secrets';

beforeEach(() => { encryptionAvailable = true; });

describe('sealCredentials / openCredentials', () => {
  it('roundtrips env + args when the keychain is available', () => {
    const creds: StoredCredentials = {
      env: { GITHUB_PERSONAL_ACCESS_TOKEN: 'ghp_secret', SLACK_TEAM_ID: 'T01' },
      args: ['postgresql://localhost/db'],
    };
    const blob = sealCredentials(creds);
    expect(blob).not.toBeNull();
    expect(blob!.startsWith('v1:enc:')).toBe(true);
    expect(blob).not.toContain('ghp_secret'); // not stored in cleartext
    expect(openCredentials(blob)).toEqual(creds);
  });

  it('falls back to base64 (still roundtrips) when the keychain is unavailable', () => {
    encryptionAvailable = false;
    expect(isAtRestEncryptionAvailable()).toBe(false);
    const creds: StoredCredentials = { env: { BRAVE_API_KEY: 'BSA123' } };
    const blob = sealCredentials(creds);
    expect(blob!.startsWith('v1:raw:')).toBe(true);
    expect(openCredentials(blob)).toEqual(creds);
  });

  it('returns null for empty / absent credentials so the DB stores NULL', () => {
    expect(sealCredentials(null)).toBeNull();
    expect(sealCredentials(undefined)).toBeNull();
    expect(sealCredentials({})).toBeNull();
    expect(sealCredentials({ env: {}, args: [] })).toBeNull();
  });

  it('opens null/blank/unknown blobs as empty credentials (fail closed)', () => {
    expect(openCredentials(null)).toEqual({});
    expect(openCredentials('')).toEqual({});
    expect(openCredentials('garbage-without-prefix')).toEqual({});
  });
});
