/**
 * Phase A integration suite — complete provider-lifecycle state transitions
 * below the rendered UI (founder-approved option B smoke strategy; the
 * rendered-UI half lives in docs/testing/PHASE_A_MANUAL_TEST_MATRIX.md).
 *
 * One shared in-memory llm_models table backs BOTH the runtime lifecycle
 * (ensureModelReady/unloadActiveModel) and the request boundary
 * (getActiveLLMClient), so each scenario walks the real sequence a user
 * produces: onboard → configure → chat → restart → switch.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

type Row = {
  model_id: string; name?: string; ollama_name: string; base_url: string;
  api_key: string | null; provider?: string; context_window: number; is_active: number;
};

const { state, fake, fsState, spawnSpy } = vi.hoisted(() => ({
  state: { rows: [] as Row[] },
  fake: { available: true },
  fsState: { installed: true },
  spawnSpy: vi.fn(),
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

vi.mock('fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('fs')>();
  return { ...real, existsSync: () => fsState.installed };
});
vi.mock('child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('child_process')>();
  return { ...real, spawn: spawnSpy };
});

// Minimal SQL dispatch over the shared rows — just enough for the code paths
// under test (active-row select, routed-row select, api_key update, full scan).
vi.mock('../db/schema', () => ({
  getDb: () => ({
    prepare: (sql: string) => ({
      get: (...args: unknown[]) => {
        if (sql.includes('WHERE is_active = 1') || sql.includes('WHERE is_active=1')) {
          return state.rows.find(r => r.is_active === 1);
        }
        if (sql.includes('WHERE ollama_name')) {
          return state.rows.find(r => r.ollama_name === args[0]);
        }
        if (sql.includes('WHERE model_id')) {
          return state.rows.find(r => r.model_id === args[0]);
        }
        return undefined;
      },
      all: () => (sql.includes('FROM llm_models') ? state.rows.map(r => ({ ...r })) : []),
      run: (...args: unknown[]) => {
        if (sql.startsWith('UPDATE llm_models SET api_key')) {
          const [key, id] = args as [string, string];
          const row = state.rows.find(r => r.model_id === id);
          if (row) row.api_key = key;
        }
        return { changes: 1 };
      },
    }),
  }),
}));

import { getActiveLLMClient, NoModelConfiguredError } from './client';
import { ensureModelReady, getModelStatus } from './ollamaRuntime';
import { sealSecretString, sealPlaintextApiKeys, CredentialLockedError, SESSION_SENTINEL, SessionKeyExpiredError } from '../security/secretString';
import { setSessionKey, clearSessionKeys } from '../security/sessionKeys';

/** fetch stub: records localhost calls; Ollama up/down per flag. */
function stubFetch(opts: { ollamaUp: boolean }) {
  const calls: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string | URL) => {
    const u = String(url);
    calls.push(u);
    if (u.includes('11434')) {
      if (!opts.ollamaUp) throw new Error('ECONNREFUSED');
      return { ok: true, json: async () => ({ models: [{ name: 'nomic-embed-text' }] }) } as unknown as Response;
    }
    return { ok: true, json: async () => ({}) } as unknown as Response;
  }));
  return calls;
}

/** Simulate an app restart: in-memory session keys die; DB rows survive. */
const restart = () => clearSessionKeys();

beforeEach(() => {
  vi.unstubAllGlobals();
  state.rows = [];
  fake.available = true;
  fsState.installed = true;
  spawnSpy.mockClear();
  clearSessionKeys();
  delete process.env.ARTHA_FORCE_NO_KEYCHAIN;
});

describe('fresh install (configure-later path)', () => {
  it('no rows → no_model status AND typed error on chat; no Ollama nag when Ollama absent', async () => {
    fsState.installed = false;
    stubFetch({ ollamaUp: false });
    await ensureModelReady(() => {});
    expect(getModelStatus().phase).toBe('no_model');
    expect(() => getActiveLLMClient()).toThrow(NoModelConfiguredError);
    expect(spawnSpy).not.toHaveBeenCalled();
  });
});

describe('fresh BYOK onboarding → restart → keep working', () => {
  it('sealed cloud row: chat works, zero localhost lifecycle, survives restart', async () => {
    // What llm:addCloudModel(activate:true) persists:
    state.rows = [{
      model_id: 'c1', ollama_name: 'gpt-4o-mini', base_url: 'https://api.openai.com/v1',
      api_key: sealSecretString('sk-live-1'), provider: 'openai', context_window: 128000, is_active: 1,
    }];
    const calls = stubFetch({ ollamaUp: false });
    await ensureModelReady(() => {});
    expect(getModelStatus().phase).toBe('ready');
    expect(() => getActiveLLMClient()).not.toThrow();
    // No warm/pull/serve attempts — only the read-only tags probe is allowed.
    expect(calls.filter(u => u.includes('/api/generate') || u.includes('/api/pull'))).toEqual([]);
    expect(spawnSpy).not.toHaveBeenCalled();

    restart();
    stubFetch({ ollamaUp: false });
    await ensureModelReady(() => {});
    expect(getModelStatus().phase).toBe('ready'); // sealed key needs no session
    expect(() => getActiveLLMClient()).not.toThrow();
  });
});

describe('provider switching (cloud ⇄ local)', () => {
  it('switching the active row flips lifecycle behaviour correctly', async () => {
    state.rows = [
      { model_id: 'c1', ollama_name: 'gpt-4o-mini', base_url: 'https://api.openai.com/v1', api_key: sealSecretString('sk-1'), provider: 'openai', context_window: 128000, is_active: 1 },
      { model_id: 'l1', ollama_name: 'llama3.2:3b', base_url: 'http://localhost:11434/v1', api_key: 'ollama', provider: 'ollama', context_window: 8192, is_active: 0 },
    ];
    let calls = stubFetch({ ollamaUp: true });
    await ensureModelReady(() => {});
    expect(getModelStatus().phase).toBe('ready');
    expect(calls.filter(u => u.includes('/api/generate'))).toEqual([]); // cloud active: no warm

    // User activates the local model (llm:setActiveModelById semantics).
    state.rows[0].is_active = 0;
    state.rows[1].is_active = 1;
    calls = stubFetch({ ollamaUp: true });
    await ensureModelReady(() => {});
    expect(getModelStatus().phase).toBe('ready');
    expect(getModelStatus().model).toBe('llama3.2:3b');
    expect(calls.some(u => u.includes('/api/generate'))).toBe(true); // local active: warm-up resumes
    expect(() => getActiveLLMClient()).not.toThrow();
  });
});

describe('existing-user upgrade migration', () => {
  it('pre-upgrade plaintext key: launch migration seals it; chat keeps working; nothing plaintext remains', async () => {
    state.rows = [{
      model_id: 'c1', ollama_name: 'gpt-4o-mini', base_url: 'https://api.openai.com/v1',
      api_key: 'sk-preupgrade-plain', provider: 'openai', context_window: 128000, is_active: 1,
    }];
    const res = sealPlaintextApiKeys({ prepare: (sql: string) => ({
      all: () => state.rows.map(r => ({ ...r })),
      run: (...args: unknown[]) => {
        const [key, id] = args as [string, string];
        const row = state.rows.find(r => r.model_id === id);
        if (row) row.api_key = key;
        return { changes: 1 };
      },
    }) });
    expect(res).toMatchObject({ sealed: 1, unsealedRemaining: 0 });
    expect(state.rows[0].api_key!.startsWith('v1:enc:')).toBe(true);
    expect(JSON.stringify(state.rows)).not.toContain('sk-preupgrade-plain');
    expect(() => getActiveLLMClient()).not.toThrow();
  });
});

describe('no secure keychain (Linux without Secret Service)', () => {
  it('legacy plaintext key is LOCKED for every path; local models keep working', async () => {
    fake.available = false;
    state.rows = [
      { model_id: 'c1', ollama_name: 'gpt-4o-mini', base_url: 'https://api.openai.com/v1', api_key: 'sk-legacy', provider: 'openai', context_window: 128000, is_active: 1 },
      { model_id: 'l1', ollama_name: 'llama3.2:3b', base_url: 'http://localhost:11434/v1', api_key: 'ollama', provider: 'ollama', context_window: 8192, is_active: 0 },
    ];
    expect(() => getActiveLLMClient()).toThrow(CredentialLockedError);
    expect(state.rows[0].api_key).toBe('sk-legacy'); // never destroyed

    // Local model unaffected by keychain state.
    state.rows[0].is_active = 0;
    state.rows[1].is_active = 1;
    expect(() => getActiveLLMClient()).not.toThrow();
  });

  it('session-only key works until restart, then reports expiry (not a silent failure)', async () => {
    fake.available = false;
    state.rows = [{
      model_id: 'c1', ollama_name: 'gpt-4o-mini', base_url: 'https://api.openai.com/v1',
      api_key: SESSION_SENTINEL, provider: 'openai', context_window: 128000, is_active: 1,
    }];
    setSessionKey('c1', 'sk-session');
    expect(() => getActiveLLMClient()).not.toThrow();

    restart();
    expect(() => getActiveLLMClient()).toThrow(SessionKeyExpiredError);
    expect(state.rows[0].api_key).toBe(SESSION_SENTINEL); // still zero material at rest
  });
});
