/**
 * secretString tests — credential policy (Phase A commits 1 + 3.5).
 *
 * Covers the founder-required scenarios: keychain available / unavailable
 * (incl. Linux basic_text), no plaintext-or-base64 persistence for new keys,
 * failed migration (rows untouched + locked), migration retry, successful
 * migration cleanup verification, and legacy-raw resealing. Session-only and
 * restart flows are tested in llm/client.credentialPolicy.test.ts.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const { fake } = vi.hoisted(() => ({
  fake: {
    available: true,
    backend: 'gnome_libsecret' as string, // Linux-only concept; see basic_text test
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
    getSelectedStorageBackend: () => fake.backend,
    encryptString: (p: string) => fake.encryptString(p),
    decryptString: (b: Buffer) => fake.decryptString(b),
  },
}));

import {
  sealSecretString,
  openSecretString,
  isSealedSecret,
  isSealableSecret,
  isRawEnvelope,
  isSecretEncryptionAvailable,
  sealPlaintextApiKeys,
  SecureStorageUnavailableError,
  LOCAL_API_KEY_PLACEHOLDER,
  SESSION_SENTINEL,
  type SecretMigrationDb,
} from './secretString';

beforeEach(() => {
  fake.available = true;
  fake.backend = 'gnome_libsecret';
  delete process.env.ARTHA_FORCE_NO_KEYCHAIN;
});

describe('isSecretEncryptionAvailable (trustworthy-keychain policy)', () => {
  it('true with a real keychain backend', () => {
    expect(isSecretEncryptionAvailable()).toBe(true);
  });

  it('false when safeStorage reports unavailable', () => {
    fake.available = false;
    expect(isSecretEncryptionAvailable()).toBe(false);
  });

  it('Linux basic_text backend (static in-binary key) counts as UNAVAILABLE', () => {
    // basic_text passes isEncryptionAvailable() but violates the
    // no-application-wide-static-key rule — must be rejected.
    fake.backend = 'basic_text';
    const isLinux = process.platform === 'linux';
    // On non-Linux platforms getSelectedStorageBackend doesn't apply; assert
    // the policy branch directly by simulating the platform.
    const orig = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', { value: 'linux' });
    try {
      expect(isSecretEncryptionAvailable()).toBe(false);
    } finally {
      Object.defineProperty(process, 'platform', orig);
    }
    if (isLinux) expect(isSecretEncryptionAvailable()).toBe(false);
  });

  it('ARTHA_FORCE_NO_KEYCHAIN=1 forces unavailable (fails safe, for QA screenshots)', () => {
    process.env.ARTHA_FORCE_NO_KEYCHAIN = '1';
    expect(isSecretEncryptionAvailable()).toBe(false);
  });
});

describe('sealSecretString / openSecretString', () => {
  it('round-trips a real key through the encrypted envelope', () => {
    const sealed = sealSecretString('sk-live-abc123');
    expect(sealed.startsWith('v1:enc:')).toBe(true);
    expect(sealed).not.toContain('sk-live-abc123');
    expect(openSecretString(sealed)).toBe('sk-live-abc123');
  });

  it('REFUSES to seal when no trustworthy keychain exists — no base64 fallback', () => {
    fake.available = false;
    expect(() => sealSecretString('sk-live-abc123')).toThrow(SecureStorageUnavailableError);
  });

  it('never seals the local placeholder or blank values (no keychain needed)', () => {
    fake.available = false; // even unavailable: passthrough values never throw
    expect(sealSecretString(LOCAL_API_KEY_PLACEHOLDER)).toBe(LOCAL_API_KEY_PLACEHOLDER);
    expect(sealSecretString('')).toBe('');
  });

  it('is idempotent — sealing a sealed value returns it unchanged', () => {
    const once = sealSecretString('sk-x');
    expect(sealSecretString(once)).toBe(once);
  });

  it('still READS legacy raw envelopes (read-only compatibility)', () => {
    const legacyRaw = 'v1:raw:' + Buffer.from('sk-legacy', 'utf8').toString('base64');
    expect(isRawEnvelope(legacyRaw)).toBe(true);
    expect(openSecretString(legacyRaw)).toBe('sk-legacy');
  });

  it('returns the placeholder for null/undefined and corrupt sealed blobs (no throw)', () => {
    expect(openSecretString(null)).toBe(LOCAL_API_KEY_PLACEHOLDER);
    expect(openSecretString('v1:enc:' + Buffer.from('garbage').toString('base64')))
      .toBe(LOCAL_API_KEY_PLACEHOLDER);
  });

  it('classifies values correctly (session sentinel is an envelope, not sealable)', () => {
    expect(isSealedSecret('v1:enc:abc')).toBe(true);
    expect(isSealedSecret('v1:raw:abc')).toBe(true);
    expect(isSealedSecret(SESSION_SENTINEL)).toBe(true);
    expect(isSealableSecret('sk-plain')).toBe(true);
    expect(isSealableSecret(SESSION_SENTINEL)).toBe(false);
    expect(isSealableSecret(LOCAL_API_KEY_PLACEHOLDER)).toBe(false);
  });
});

describe('sealPlaintextApiKeys (launch migration, Commit 3.5 rules)', () => {
  function fakeDb(rows: { model_id: string; api_key: string | null }[]) {
    const db: SecretMigrationDb & { rows: typeof rows } = {
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
    return db;
  }

  it('seals plaintext AND legacy-raw rows; skips placeholder, enc, and session rows', () => {
    const db = fakeDb([
      { model_id: 'local1', api_key: 'ollama' },
      { model_id: 'cloud1', api_key: 'sk-plain-1' },
      { model_id: 'cloud2', api_key: 'v1:raw:' + Buffer.from('sk-was-raw').toString('base64') },
      { model_id: 'cloud3', api_key: sealSecretString('sk-already-sealed') },
      { model_id: 'sess1', api_key: SESSION_SENTINEL },
    ]);
    const res = sealPlaintextApiKeys(db);
    expect(res).toEqual({ sealed: 2, failed: 0, pending: 0, unsealedRemaining: 0 });
    expect(db.rows.find(r => r.model_id === 'local1')!.api_key).toBe('ollama');
    expect(db.rows.find(r => r.model_id === 'sess1')!.api_key).toBe(SESSION_SENTINEL);
    for (const id of ['cloud1', 'cloud2']) {
      const v = db.rows.find(r => r.model_id === id)!.api_key!;
      expect(v.startsWith('v1:enc:')).toBe(true);
    }
    expect(openSecretString(db.rows.find(r => r.model_id === 'cloud2')!.api_key)).toBe('sk-was-raw');
  });

  it('FAILED migration (no keychain): touches nothing, reports pending, never writes raw', () => {
    fake.available = false;
    const db = fakeDb([
      { model_id: 'cloud1', api_key: 'sk-plain-1' },
      { model_id: 'local1', api_key: 'ollama' },
    ]);
    const res = sealPlaintextApiKeys(db);
    expect(res).toEqual({ sealed: 0, failed: 0, pending: 1, unsealedRemaining: 1 });
    // Credential preserved exactly — never destroyed, never base64'd.
    expect(db.rows.find(r => r.model_id === 'cloud1')!.api_key).toBe('sk-plain-1');
  });

  it('migration RETRY: succeeds once the keychain becomes available', () => {
    fake.available = false;
    const db = fakeDb([{ model_id: 'cloud1', api_key: 'sk-plain-1' }]);
    expect(sealPlaintextApiKeys(db).pending).toBe(1);
    fake.available = true; // keychain fixed, next launch
    const res = sealPlaintextApiKeys(db);
    expect(res.sealed).toBe(1);
    expect(res.unsealedRemaining).toBe(0);
    expect(db.rows[0].api_key!.startsWith('v1:enc:')).toBe(true);
  });

  it('successful migration cleanup: verification reports zero unsealed and no plaintext remains', () => {
    const db = fakeDb([{ model_id: 'c', api_key: 'sk-super-secret-42' }]);
    const res = sealPlaintextApiKeys(db);
    expect(res.unsealedRemaining).toBe(0);
    expect(JSON.stringify(db.rows)).not.toContain('sk-super-secret-42');
  });

  it('continues past a row that fails to seal and reports it (per-row isolation)', () => {
    const rows = [
      { model_id: 'bad', api_key: 'sk-will-fail' },
      { model_id: 'good', api_key: 'sk-will-succeed' },
    ];
    const db: SecretMigrationDb = {
      prepare(_sql: string) {
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
    expect(res.sealed).toBe(1);
    expect(res.failed).toBe(1);
    expect(res.unsealedRemaining).toBe(1); // the failed row still needs sealing
    expect(rows.find(r => r.model_id === 'bad')!.api_key).toBe('sk-will-fail'); // untouched
  });
});
