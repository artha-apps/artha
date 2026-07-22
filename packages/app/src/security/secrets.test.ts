/**
 * Tests for the connector-credential secret store. Electron's `safeStorage` is
 * mocked two ways — encryption-available (the normal case) and unavailable —
 * to prove the seal→open roundtrip holds, that writing REFUSES without a
 * trustworthy keychain (Commit 3.5: no base64 persistence), and that legacy
 * v1:raw blobs still OPEN (read-only compatibility).
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

  it('REFUSES to seal when the keychain is unavailable — no base64 persistence (Commit 3.5)', () => {
    encryptionAvailable = false;
    expect(isAtRestEncryptionAvailable()).toBe(false);
    const creds: StoredCredentials = { env: { BRAVE_API_KEY: 'BSA123' } };
    expect(() => sealCredentials(creds)).toThrow(/secure OS keychain/i);
  });

  it('still OPENS legacy v1:raw blobs written by older builds (read-only compatibility)', () => {
    const creds: StoredCredentials = { env: { BRAVE_API_KEY: 'BSA123' } };
    const legacy = 'v1:raw:' + Buffer.from(JSON.stringify(creds), 'utf8').toString('base64');
    expect(openCredentials(legacy)).toEqual(creds);
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
