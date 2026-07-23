/**
 * getActiveLLMClient no-model-state tests (Phase A commit 3).
 *
 * The old behaviour silently fell back to `llama3.2:3b-instruct-q4_K_M` on
 * localhost:11434 when nothing was configured — a fresh BYOK/configure-later
 * user's first message failed against a server they never set up. Now the
 * client throws a typed, user-readable NoModelConfiguredError instead.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const { state } = vi.hoisted(() => ({
  state: {
    activeRow: undefined as Record<string, unknown> | undefined,
    savedRows: [] as Record<string, unknown>[], // lookup by ollama_name
  },
}));

vi.mock('../db/schema', () => ({
  getDb: () => ({
    prepare: (sql: string) => ({
      get: (...args: unknown[]) => {
        if (sql.includes('WHERE is_active = 1') || sql.includes('WHERE is_active=1')) return state.activeRow;
        if (sql.includes('WHERE ollama_name')) return state.savedRows.find(r => r.ollama_name === args[0]);
        return undefined; // router_overrides / model_profiles: none
      },
      all: () => [],
      run: () => ({ changes: 0 }),
    }),
  }),
}));

// client.ts → security/secretString → electron; fake the keychain.
vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (p: string) => Buffer.from(`FAKE!${p}`, 'utf8'),
    decryptString: (b: Buffer) => b.toString('utf8').slice('FAKE!'.length),
  },
}));

import { getActiveLLMClient, NoModelConfiguredError } from './client';

beforeEach(() => { state.activeRow = undefined; state.savedRows = []; });

describe('getActiveLLMClient with nothing configured', () => {
  it('throws NoModelConfiguredError instead of inventing a localhost default', () => {
    expect(() => getActiveLLMClient()).toThrow(NoModelConfiguredError);
    expect(() => getActiveLLMClient()).toThrow(/no model is configured/i);
  });

  it('the error carries a stable code for programmatic handling', () => {
    try {
      getActiveLLMClient();
      expect.unreachable('should have thrown');
    } catch (err) {
      expect((err as NoModelConfiguredError).code).toBe('NO_MODEL_CONFIGURED');
    }
  });

  it('a modelOverride with its OWN saved row works without an active row (escalation path)', () => {
    state.savedRows = [{
      model_id: 's1', ollama_name: 'gpt-4o-mini', base_url: 'https://api.openai.com/v1',
      api_key: 'v1:enc:' + Buffer.from('FAKE!sk-x').toString('base64'), context_window: 128000,
    }];
    expect(() => getActiveLLMClient('gpt-4o-mini')).not.toThrow();
  });

  it('a bare-tag override with NO saved row and NO active row throws — no invented localhost transport (M1)', () => {
    expect(() => getActiveLLMClient('llama3.2:3b')).toThrow(NoModelConfiguredError);
  });
});

describe('getActiveLLMClient with an active row (regression)', () => {
  it('returns a client for a local active model', () => {
    state.activeRow = {
      ollama_name: 'llama3.2:3b',
      base_url: 'http://localhost:11434/v1',
      api_key: 'ollama',
      context_window: 8192,
    };
    expect(() => getActiveLLMClient()).not.toThrow();
  });

  it('returns a client for a cloud active model with a sealed key', () => {
    state.activeRow = {
      ollama_name: 'gpt-4o-mini',
      base_url: 'https://api.openai.com/v1',
      api_key: 'v1:enc:' + Buffer.from('FAKE!sk-test').toString('base64'),
      provider: 'openai',
      context_window: 128000,
    };
    expect(() => getActiveLLMClient()).not.toThrow();
  });
});
