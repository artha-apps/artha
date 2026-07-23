/**
 * Transport-resolution regression tests for the independent-review fixes
 * (security H2, correctness H2/M2, M6): a routed row uses ITS OWN key, cloud-
 * active users are never steered to localhost aux models, and stale router
 * rows cannot resurrect an invented localhost transport.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const { state } = vi.hoisted(() => ({
  state: {
    activeRow: undefined as Record<string, unknown> | undefined,
    savedRows: [] as Record<string, unknown>[],
    profileRows: {} as Record<string, string>, // task_type -> ollama_name (model_profiles best)
    localRows: [] as { ollama_name: string }[], // provider='ollama' listing
  },
}));

vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
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
  getDb: () => fakeDb(),
}));

function fakeDb() {
  return {
    prepare: (sql: string) => ({
      get: (...args: unknown[]) => {
        if (sql.includes('router_overrides')) return undefined;
        if (sql.includes('model_profiles')) {
          const name = state.profileRows[args[0] as string];
          return name ? { ollama_name: name } : undefined;
        }
        if (sql.includes('WHERE is_active = 1') || sql.includes('WHERE is_active=1')) return state.activeRow;
        if (sql.includes('WHERE ollama_name')) return state.savedRows.find(r => r.ollama_name === args[0]);
        return undefined;
      },
      all: () => (state.localRows.length && /provider='ollama'/.test(sql) ? state.localRows : []),
      run: () => ({ changes: 1 }),
    }),
  };
}

import { resolveTransport, NoModelConfiguredError } from './client';
import { LOCAL_API_KEY_PLACEHOLDER } from '../security/secretString';

const seal = (plain: string) => 'v1:enc:' + Buffer.from(`FAKE!${plain}`).toString('base64');

const CLOUD_ACTIVE = {
  model_id: 'c1', ollama_name: 'gpt-4o-mini', base_url: 'https://api.openai.com/v1',
  api_key: seal('sk-cloud-active'), provider: 'openai', context_window: 128000, is_active: 1,
};

beforeEach(() => {
  state.activeRow = undefined;
  state.savedRows = [];
  state.profileRows = {};
  state.localRows = [];
});

describe('H2 — routed row uses its OWN key, never the active row’s', () => {
  it('keyless routed row (remote Ollama/custom) gets the placeholder, not the active cloud key', () => {
    state.activeRow = CLOUD_ACTIVE;
    const keyless = {
      model_id: 'r1', ollama_name: 'llama3.3:70b', base_url: 'https://my-vllm.example.com/v1',
      api_key: '', provider: 'custom', context_window: 32000,
    };
    state.savedRows = [keyless];
    state.profileRows = { synthesis: 'llama3.3:70b' }; // benchmark routed the synthesis phase there

    const t = resolveTransport(fakeDb(), undefined, 'synthesis');
    expect(t.baseUrl).toBe('https://my-vllm.example.com/v1');
    expect(t.model).toBe('llama3.3:70b');
    // The active row's sk-cloud-active must NOT ride along to the third-party host.
    expect(t.apiKey).toBe(LOCAL_API_KEY_PLACEHOLDER);
  });

  it('routed row with its own sealed key uses that key', () => {
    state.activeRow = CLOUD_ACTIVE;
    state.savedRows = [{
      model_id: 'r2', ollama_name: 'llama-3.3-70b-versatile', base_url: 'https://api.groq.com/openai/v1',
      api_key: seal('gsk-groq'), provider: 'groq', context_window: 32000,
    }];
    const t = resolveTransport(fakeDb(), 'llama-3.3-70b-versatile');
    expect(t.apiKey).toBe('gsk-groq');
    expect(t.baseUrl).toBe('https://api.groq.com/openai/v1');
  });
});

describe('M2 — cloud-active users are not steered to localhost aux models', () => {
  it('plan/tool_args smallest-local fallback is skipped when the active model is cloud', () => {
    state.activeRow = CLOUD_ACTIVE;
    // Leftover local rows from an earlier local-first era:
    state.localRows = [{ ollama_name: 'llama3.2:3b' }, { ollama_name: 'llama3.3:70b' }];

    const t = resolveTransport(fakeDb(), undefined, 'plan');
    // Aux phase stays on the active cloud model — no ECONNREFUSED to a
    // localhost server that provider-aware startup no longer auto-starts.
    expect(t.model).toBe('gpt-4o-mini');
    expect(t.baseUrl).toBe('https://api.openai.com/v1');
  });

  it('local-active users keep the smallest-local aux optimization (regression)', () => {
    state.activeRow = {
      model_id: 'l1', ollama_name: 'llama3.3:70b', base_url: 'http://localhost:11434/v1',
      api_key: 'ollama', provider: 'ollama', context_window: 8192, is_active: 1,
    };
    state.localRows = [{ ollama_name: 'llama3.3:70b' }, { ollama_name: 'llama3.2:3b' }];
    const t = resolveTransport(fakeDb(), undefined, 'plan');
    expect(t.model).toBe('llama3.2:3b'); // smallest by parsed param count
  });
});

describe('M6 — stale router rows cannot resurrect a localhost default', () => {
  it('no active row + stale model_profiles pointing at a deleted model → NoModelConfiguredError', () => {
    state.activeRow = undefined;
    state.profileRows = { plan: 'deleted-model:7b' }; // profile survives, llm_models row is gone
    expect(() => resolveTransport(fakeDb(), undefined, 'plan')).toThrow(NoModelConfiguredError);
  });
});
