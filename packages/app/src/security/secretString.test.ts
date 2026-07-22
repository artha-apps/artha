/**
 * secretString tests — BYOK api_key sealing (Phase A commit 1).
 *
 * electron's safeStorage is mocked with a reversible fake cipher so we can
 * assert: envelope round-trips (enc + raw fallback), placeholder/legacy
 * passthrough, corrupt-blob degradation, and the launch migration's
 * idempotency + plaintext-never-persists guarantee — all without Electron.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const { fake } = vi.hoisted(() => ({
  fake: {
    available: true,
    // Reversible fake "encryption": prefix marker + base64. Distinct from the
    // real thing but lets decryptString invert encryptString deterministically.
    encryptString: (plain: string) => Buffer.from(`FAKE!${plain}`, 'utf8'),
    decryptString: (buf: Buffer) => {
      const s = buf.toString('utf8');
      if (!s.startsWith('FAKE!')) throw new Error('corrupt blob');
      return s.slice('FAKE!'.length);
    },
  },
}));

vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => fake.available,
    encryptString: (p: string) => fake.encryptString(p),
    decryptString: (b: Buffer) => fake.decryptString(b),
  },
}));

import {
  sealSecretString,
  openSecretString,
  isSealedSecret,
  isSealableSecret,
  sealPlaintextApiKeys,
  LOCAL_API_KEY_PLACEHOLDER,
  type SecretMigrationDb,
} from './secretString';

beforeEach(() => { fake.available = true; });

describe('sealSecretString / openSecretString', () => {
  it('round-trips a real key through the encrypted envelope', () => {
    const sealed = sealSecretString('sk-live-abc123');
    expect(sealed.startsWith('v1:enc:')).toBe(true);
    expect(sealed).not.toContain('sk-live-abc123');
    expect(openSecretString(sealed)).toBe('sk-live-abc123');
  });

  it('falls back to the raw envelope when the keychain is unavailable — and still round-trips', () => {
    fake.available = false;
    const sealed = sealSecretString('sk-live-abc123');
    expect(sealed.startsWith('v1:raw:')).toBe(true);
    expect(sealed).not.toContain('sk-live-abc123'); // base64, not raw plaintext
    expect(openSecretString(sealed)).toBe('sk-live-abc123');
  });

  it('never seals the local placeholder or blank values', () => {
    expect(sealSecretString(LOCAL_API_KEY_PLACEHOLDER)).toBe(LOCAL_API_KEY_PLACEHOLDER);
    expect(sealSecretString('')).toBe('');
    expect(sealSecretString('  ')).toBe('  ');
  });

  it('is idempotent — sealing a sealed value returns it unchanged', () => {
    const once = sealSecretString('sk-x');
    expect(sealSecretString(once)).toBe(once);
  });

  it('passes legacy plaintext through openSecretString unchanged (migration safety net)', () => {
    expect(openSecretString('sk-legacy-plaintext')).toBe('sk-legacy-plaintext');
    expect(openSecretString(LOCAL_API_KEY_PLACEHOLDER)).toBe(LOCAL_API_KEY_PLACEHOLDER);
  });

  it('returns the placeholder for null/undefined and for corrupt sealed blobs (no throw)', () => {
    expect(openSecretString(null)).toBe(LOCAL_API_KEY_PLACEHOLDER);
    expect(openSecretString(undefined)).toBe(LOCAL_API_KEY_PLACEHOLDER);
    // Valid envelope prefix, garbage ciphertext → degrade, don't crash.
    expect(openSecretString('v1:enc:' + Buffer.from('garbage').toString('base64')))
      .toBe(LOCAL_API_KEY_PLACEHOLDER);
  });

  it('classifies values correctly', () => {
    expect(isSealedSecret('v1:enc:abc')).toBe(true);
    expect(isSealedSecret('v1:raw:abc')).toBe(true);
    expect(isSealedSecret('sk-plain')).toBe(false);
    expect(isSealableSecret('sk-plain')).toBe(true);
    expect(isSealableSecret(LOCAL_API_KEY_PLACEHOLDER)).toBe(false);
    expect(isSealableSecret('v1:enc:abc')).toBe(false);
    expect(isSealableSecret('')).toBe(false);
    expect(isSealableSecret(null)).toBe(false);
  });
});

describe('sealPlaintextApiKeys (launch migration)', () => {
  /** In-memory llm_models fixture implementing the minimal DB surface. */
  function fakeDb(rows: { model_id: string; api_key: string | null }[]): SecretMigrationDb & {
    rows: { model_id: string; api_key: string | null }[];
  } {
    return {
      rows,
      prepare(sql: string) {
        return {
          all: () => rows.map(r => ({ ...r })),
          run: (...args: unknown[]) => {
            if (!sql.startsWith('UPDATE')) throw new Error(`unexpected run: ${sql}`);
            const [key, id] = args as [string, string];
            const row = rows.find(r => r.model_id === id);
            if (row) row.api_key = key;
            return { changes: row ? 1 : 0 };
          },
        };
      },
    };
  }

  it('seals plaintext cloud keys, skips placeholder + already-sealed rows', () => {
    const db = fakeDb([
      { model_id: 'local1', api_key: 'ollama' },
      { model_id: 'cloud1', api_key: 'sk-plain-1' },
      { model_id: 'cloud2', api_key: sealSecretString('sk-already-sealed') },
      { model_id: 'empty1', api_key: null },
    ]);
    const res = sealPlaintextApiKeys(db);
    expect(res).toEqual({ sealed: 1, failed: 0 });
    expect(db.rows.find(r => r.model_id === 'local1')!.api_key).toBe('ollama');
    const cloud1 = db.rows.find(r => r.model_id === 'cloud1')!.api_key!;
    expect(cloud1.startsWith('v1:enc:')).toBe(true);
    expect(openSecretString(cloud1)).toBe('sk-plain-1');
  });

  it('is idempotent — a second pass changes nothing', () => {
    const db = fakeDb([{ model_id: 'cloud1', api_key: 'sk-plain-1' }]);
    sealPlaintextApiKeys(db);
    const after = db.rows[0].api_key;
    const second = sealPlaintextApiKeys(db);
    expect(second).toEqual({ sealed: 0, failed: 0 });
    expect(db.rows[0].api_key).toBe(after);
  });

  it('never leaves the original plaintext anywhere in the stored value', () => {
    const db = fakeDb([{ model_id: 'c', api_key: 'sk-super-secret-42' }]);
    sealPlaintextApiKeys(db);
    expect(db.rows[0].api_key).not.toContain('sk-super-secret-42');
  });

  it('continues past a row that fails to seal and reports it', () => {
    const rows = [
      { model_id: 'bad', api_key: 'sk-will-fail' },
      { model_id: 'good', api_key: 'sk-will-succeed' },
    ];
    const db: SecretMigrationDb = {
      prepare(sql: string) {
        return {
          all: () => rows.map(r => ({ ...r })),
          run: (...args: unknown[]) => {
            const [key, id] = args as [string, string];
            if (id === 'bad') throw new Error('disk I/O error');
            const row = rows.find(r => r.model_id === id);
            if (row) row.api_key = key;
            return { changes: 1 };
          },
        };
      },
    };
    const res = sealPlaintextApiKeys(db);
    expect(res).toEqual({ sealed: 1, failed: 1 });
    expect(rows.find(r => r.model_id === 'bad')!.api_key).toBe('sk-will-fail'); // untouched, retried next launch
    expect(openSecretString(rows.find(r => r.model_id === 'good')!.api_key)).toBe('sk-will-succeed');
  });

  it('raw-fallback migration still removes plaintext from disk representation', () => {
    fake.available = false;
    const db = fakeDb([{ model_id: 'c', api_key: 'sk-no-keychain' }]);
    sealPlaintextApiKeys(db);
    const stored = db.rows[0].api_key!;
    expect(stored.startsWith('v1:raw:')).toBe(true);
    expect(stored).not.toContain('sk-no-keychain');
    expect(openSecretString(stored)).toBe('sk-no-keychain');
  });
});
