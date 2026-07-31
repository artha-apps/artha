/**
 * D-B1 consent-gate tests. The one invariant that matters: a CLOUD (isLocal
 * false) embedder is NEVER returned without a valid consent record — every gap
 * (no consent, disabled, partial config, missing key) fails closed to LOCAL, so
 * indexed text can't leave the device by accident.
 */
import { describe, it, expect } from 'vitest';
import {
  resolveEmbeddingProvider, readCloudEmbeddingConfig,
  grantCloudEmbeddingConsent, revokeCloudEmbeddingConsent, type ConsentDb,
} from './embeddingConsent';

/** In-memory fake of the users.settings_json blob. */
function db(initial: Record<string, unknown> = {}): ConsentDb & { settings: Record<string, unknown> } {
  const state = { settings: { ...initial } };
  return {
    settings: state.settings,
    prepare(sql: string) {
      return {
        get: () => (sql.includes('FROM users') ? { settings_json: JSON.stringify(state.settings) } : undefined),
        run: (...a: unknown[]) => {
          // Real UPDATE replaces settings_json wholesale — clear then assign so
          // a revoke (which DELETES a key) actually removes it.
          if (sql.includes('UPDATE users')) {
            for (const k of Object.keys(state.settings)) delete state.settings[k];
            Object.assign(state.settings, JSON.parse(a[0] as string));
          }
          return {};
        },
      };
    },
  };
}

const validCfg = { cloud_embedding: { enabled: true, modelId: 'm1', model: 'text-embedding-3-small', dim: 1536, consentedAt: 1700000000 } };
const goodKey = () => ({ baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-x' });

describe('resolveEmbeddingProvider — D-B1 boundary', () => {
  it('returns LOCAL when there is no consent record', () => {
    expect(resolveEmbeddingProvider(db(), goodKey).isLocal).toBe(true);
  });

  it('returns a CLOUD provider only WITH consent + resolvable key', () => {
    const p = resolveEmbeddingProvider(db(validCfg), goodKey);
    expect(p.isLocal).toBe(false);
    expect(p.model).toBe('text-embedding-3-small');
    expect(p.dim).toBe(1536);
  });

  it('fails CLOSED to local when consent exists but the key cannot be opened', () => {
    expect(resolveEmbeddingProvider(db(validCfg), () => null).isLocal).toBe(true);
  });

  it('fails CLOSED to local for a disabled or partial config', () => {
    expect(resolveEmbeddingProvider(db({ cloud_embedding: { enabled: false, modelId: 'm1', model: 'x', dim: 1536, consentedAt: 1 } }), goodKey).isLocal).toBe(true);
    expect(resolveEmbeddingProvider(db({ cloud_embedding: { enabled: true, modelId: 'm1' } }), goodKey).isLocal).toBe(true); // missing model/dim
    expect(resolveEmbeddingProvider(db({ cloud_embedding: { enabled: true, modelId: 'm1', model: 'x', dim: 0, consentedAt: 1 } }), goodKey).isLocal).toBe(true); // dim<=0
  });
});

describe('consent read/write', () => {
  it('grant then read round-trips', () => {
    const d = db();
    grantCloudEmbeddingConsent(d, { modelId: 'm1', model: 'text-embedding-3-small', dim: 1536, consentedAt: 1700000000 });
    const cfg = readCloudEmbeddingConfig(d);
    expect(cfg).toMatchObject({ enabled: true, modelId: 'm1', dim: 1536 });
  });

  it('revoke returns to local', () => {
    const d = db(validCfg);
    expect(resolveEmbeddingProvider(d, goodKey).isLocal).toBe(false);
    revokeCloudEmbeddingConsent(d);
    expect(resolveEmbeddingProvider(d, goodKey).isLocal).toBe(true);
    expect(readCloudEmbeddingConfig(d)).toBeNull();
  });

  it('malformed settings_json fails closed (null / local)', () => {
    const broken: ConsentDb = { prepare: () => ({ get: () => ({ settings_json: '{not json' }), run: () => ({}) }) };
    expect(readCloudEmbeddingConfig(broken)).toBeNull();
    expect(resolveEmbeddingProvider(broken, goodKey).isLocal).toBe(true);
  });
});
