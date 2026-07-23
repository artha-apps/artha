/**
 * getActiveLLMClient credential-policy tests (Phase A commit 3.5).
 *
 * The use-policy at the request boundary:
 *   - session-only keys resolve from process memory and expire on restart
 *   - legacy plaintext keys are sealed-on-read when a keychain exists,
 *     and LOCKED (typed error, no provider call) when it doesn't — a
 *     persistently stored plaintext key is never silently used forever
 *   - local placeholder rows never need a keychain at all
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const { fake, state } = vi.hoisted(() => ({
  fake: { available: true },
  state: {
    activeRow: undefined as Record<string, unknown> | undefined,
    updates: [] as { key: string; id: string }[],
  },
}));

vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => fake.available,
    getSelectedStorageBackend: () => 'gnome_libsecret',
    encryptString: (p: string) => Buffer.from(`FAKE!${p}`, 'utf8'),
    decryptString: (b: Buffer) => {
      const s = b.toString('utf8');
      if (!s.startsWith('FAKE!')) throw new Error('corrupt');
      return s.slice('FAKE!'.length);
    },
  },
}));

vi.mock('../db/schema', () => ({
  getDb: () => ({
    prepare: (sql: string) => ({
      get: () => (sql.includes('WHERE is_active = 1') ? state.activeRow : undefined),
      all: () => [],
      run: (...args: unknown[]) => {
        if (sql.startsWith('UPDATE llm_models SET api_key')) {
          const [key, id] = args as [string, string];
          state.updates.push({ key, id });
          if (state.activeRow?.model_id === id) state.activeRow.api_key = key;
        }
        return { changes: 1 };
      },
    }),
  }),
}));

import { getActiveLLMClient } from './client';
import { SessionKeyExpiredError, CredentialLockedError, SESSION_SENTINEL } from '../security/secretString';
import { setSessionKey, clearSessionKeys } from '../security/sessionKeys';

beforeEach(() => {
  fake.available = true;
  state.activeRow = undefined;
  state.updates = [];
  clearSessionKeys();
  delete process.env.ARTHA_FORCE_NO_KEYCHAIN;
});

const cloudRow = (apiKey: string) => ({
  model_id: 'm1',
  ollama_name: 'gpt-4o-mini',
  base_url: 'https://api.openai.com/v1',
  api_key: apiKey,
  provider: 'openai',
  context_window: 128000,
});

describe('session-only keys', () => {
  it('resolves a session key from process memory (session-only use works)', () => {
    state.activeRow = cloudRow(SESSION_SENTINEL);
    setSessionKey('m1', 'sk-session-123');
    expect(() => getActiveLLMClient()).not.toThrow();
    // Nothing was written to the DB — the sentinel stays, the key stays in memory.
    expect(state.updates).toEqual([]);
  });

  it('restart after a session-only key → typed SessionKeyExpiredError, no provider call possible', () => {
    state.activeRow = cloudRow(SESSION_SENTINEL);
    // clearSessionKeys() in beforeEach ≙ process restart: memory gone, sentinel remains.
    expect(() => getActiveLLMClient()).toThrow(SessionKeyExpiredError);
    expect(() => getActiveLLMClient()).toThrow(/previous session only/i);
  });
});

describe('legacy plaintext keys', () => {
  it('seals on read when a trustworthy keychain exists (atomic replace, then used)', () => {
    state.activeRow = cloudRow('sk-legacy-plain');
    expect(() => getActiveLLMClient()).not.toThrow();
    expect(state.updates).toHaveLength(1);
    expect(state.updates[0].id).toBe('m1');
    expect(state.updates[0].key.startsWith('v1:enc:')).toBe(true);
    expect(state.updates[0].key).not.toContain('sk-legacy-plain');
  });

  it('is LOCKED when no keychain exists — typed error, key untouched, never silently sent', () => {
    fake.available = false;
    state.activeRow = cloudRow('sk-legacy-plain');
    expect(() => getActiveLLMClient()).toThrow(CredentialLockedError);
    // Not destroyed, not rewritten — recoverable once the keychain is fixed.
    expect(state.updates).toEqual([]);
    expect(state.activeRow!.api_key).toBe('sk-legacy-plain');
  });

  it('background/scheduled use hits the same lock (no path bypasses the policy)', () => {
    // Scheduler and LAN runs resolve their client through this same function;
    // there is no alternate read path to a plaintext key.
    fake.available = false;
    state.activeRow = cloudRow('sk-legacy-plain');
    expect(() => getActiveLLMClient(undefined, 'synthesis')).toThrow(CredentialLockedError);
  });
});

describe('local models with no secure keychain', () => {
  it('placeholder rows work fully — local operation never requires a keychain', () => {
    fake.available = false;
    state.activeRow = {
      model_id: 'l1',
      ollama_name: 'llama3.2:3b',
      base_url: 'http://localhost:11434/v1',
      api_key: 'ollama',
      provider: 'ollama',
      context_window: 8192,
    };
    expect(() => getActiveLLMClient()).not.toThrow();
    expect(state.updates).toEqual([]);
  });
});
