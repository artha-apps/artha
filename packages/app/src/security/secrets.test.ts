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
  resealRawCredentialBlobs,
  type CredsMigrationDb,
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

describe('resealRawCredentialBlobs (register R5)', () => {
  const creds: StoredCredentials = { env: { GITHUB_PERSONAL_ACCESS_TOKEN: 'ghp_raw_era' } };
  const legacyRaw = 'v1:raw:' + Buffer.from(JSON.stringify(creds), 'utf8').toString('base64');

  function fakeDb(rows: { tool_id: string; credentials_enc: string }[]) {
    const db: CredsMigrationDb & { rows: typeof rows } = {
      rows,
      prepare(sql: string) {
        return {
          all: () => rows.filter(r => r.credentials_enc.startsWith('v1:raw:')).map(r => ({ ...r })),
          run: (...args: unknown[]) => {
            if (!sql.startsWith('UPDATE')) throw new Error(`unexpected: ${sql}`);
            const [blob, id] = args as [string, string];
            const row = rows.find(r => r.tool_id === id);
            if (row) row.credentials_enc = blob;
            return { changes: 1 };
          },
        };
      },
    };
    return db;
  }

  it('upgrades legacy raw blobs to keychain-sealed when a keychain exists', () => {
    const db = fakeDb([
      { tool_id: 't1', credentials_enc: legacyRaw },
      { tool_id: 't2', credentials_enc: sealCredentials({ env: { X: 'y' } })! },
    ]);
    expect(resealRawCredentialBlobs(db)).toBe(1);
    const upgraded = db.rows.find(r => r.tool_id === 't1')!.credentials_enc;
    expect(upgraded.startsWith('v1:enc:')).toBe(true);
    expect(upgraded).not.toContain(Buffer.from(JSON.stringify(creds)).toString('base64'));
    expect(openCredentials(upgraded)).toEqual(creds);
  });

  it('touches nothing when no keychain is available (raw rows keep opening read-only)', () => {
    encryptionAvailable = false;
    const db = fakeDb([{ tool_id: 't1', credentials_enc: legacyRaw }]);
    expect(resealRawCredentialBlobs(db)).toBe(0);
    expect(db.rows[0].credentials_enc).toBe(legacyRaw);
    expect(openCredentials(db.rows[0].credentials_enc)).toEqual(creds);
  });
});
