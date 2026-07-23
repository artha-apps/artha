/**
 * Execution profiles v0 tests (Phase A commit 10) — Default-profile
 * synthesis, mode derivation, idempotency. Behavioural invariant: v0 changes
 * NOTHING about model resolution (is_active stays authoritative).
 */
import { describe, it, expect } from 'vitest';
import { ensureDefaultProfile, getDefaultProfile, deriveModeFromActive, type ProfileDb } from './profiles';

function fakeDb(activeRow?: { provider?: string; base_url?: string }) {
  const profiles: Record<string, unknown>[] = [];
  const db: ProfileDb & { profiles: typeof profiles } = {
    profiles,
    exec: () => undefined, // DDL — table existence is implicit in the fake
    prepare(sql: string) {
      return {
        get: () => {
          if (sql.includes('FROM execution_profiles')) return profiles.find(p => p.is_default === 1);
          if (sql.includes('FROM llm_models')) return activeRow;
          return undefined;
        },
        all: () => [],
        run: (...args: unknown[]) => {
          if (sql.startsWith('INSERT INTO execution_profiles')) {
            profiles.push({ profile_id: 'p1', name: 'Default', mode: args[0], is_default: 1 });
          }
          return { changes: 1 };
        },
      };
    },
  };
  return db;
}

describe('deriveModeFromActive', () => {
  it('no active model → local (the app default)', () => {
    expect(deriveModeFromActive(undefined)).toBe('local');
  });
  it('ollama active → local; cloud provider active → byok', () => {
    expect(deriveModeFromActive({ provider: 'ollama', base_url: 'http://localhost:11434/v1' })).toBe('local');
    expect(deriveModeFromActive({ provider: 'openai', base_url: 'https://api.openai.com/v1' })).toBe('byok');
    expect(deriveModeFromActive({ provider: 'openrouter', base_url: 'https://openrouter.ai/api/v1' })).toBe('byok');
  });
});

describe('ensureDefaultProfile', () => {
  it('synthesizes one Default profile from the active model (local user)', () => {
    const db = fakeDb({ provider: 'ollama', base_url: 'http://localhost:11434/v1' });
    expect(ensureDefaultProfile(db)).toEqual({ created: true, mode: 'local' });
    expect(getDefaultProfile(db)).toMatchObject({ name: 'Default', mode: 'local', is_default: 1 });
  });

  it('BYOK user gets mode byok', () => {
    const db = fakeDb({ provider: 'anthropic', base_url: 'https://api.anthropic.com/v1' });
    expect(ensureDefaultProfile(db).mode).toBe('byok');
  });

  it('is idempotent — second launch creates nothing', () => {
    const db = fakeDb({ provider: 'ollama' });
    ensureDefaultProfile(db);
    expect(ensureDefaultProfile(db)).toEqual({ created: false, mode: 'local' });
    expect(db.profiles).toHaveLength(1);
  });
});
