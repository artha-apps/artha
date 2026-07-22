/**
 * ollamaRuntime lifecycle tests (Phase A commit 2) — the provider-aware
 * guarantee: with a cloud/BYOK model active, Artha makes ZERO unintended
 * localhost calls (no /api/generate warm-up, no server spawn, no /api/pull)
 * and never reports Ollama-centric states like 'not_installed'.
 *
 * getDb is mocked (lanPrivacy.test.ts pattern) to control the active row;
 * global fetch is stubbed with a recorder. The ONE localhost call allowed on
 * the cloud path is the read-only GET /api/tags reachability probe (it gates
 * local-embedding provisioning when the user also runs Ollama).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const { state } = vi.hoisted(() => ({
  state: {
    activeRow: undefined as
      | { ollama_name: string; context_window: number; provider?: string; base_url?: string }
      | undefined,
  },
}));

vi.mock('../db/schema', () => ({
  getDb: () => ({
    prepare: (sql: string) => ({
      get: () => (sql.includes('FROM llm_models') ? state.activeRow : undefined),
      all: () => [],
      run: () => ({ changes: 0 }),
    }),
  }),
}));

// child_process is imported at module level by ollamaRuntime — spy on spawn so
// an accidental `ollama serve` start on the cloud path fails the test.
const { spawnSpy } = vi.hoisted(() => ({ spawnSpy: vi.fn() }));
vi.mock('child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('child_process')>();
  return { ...real, spawn: spawnSpy };
});

import { ensureModelReady, unloadActiveModel, getModelStatus } from './ollamaRuntime';

/** fetch recorder: captures every (url, method) and answers per scenario. */
function stubFetch(opts: { tagsOk: boolean; tagsModels?: string[] }) {
  const calls: { url: string; method: string }[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    calls.push({ url: u, method: init?.method ?? 'GET' });
    if (u.endsWith('/api/tags')) {
      if (!opts.tagsOk) throw new Error('ECONNREFUSED');
      return {
        ok: true,
        json: async () => ({ models: (opts.tagsModels ?? []).map(name => ({ name })) }),
      } as unknown as Response;
    }
    // Warm-up / pull / unload endpoints just succeed if reached — the tests
    // assert on whether they were reached at all.
    return { ok: true, json: async () => ({}) } as unknown as Response;
  }));
  return calls;
}

beforeEach(() => {
  vi.unstubAllGlobals();
  spawnSpy.mockClear();
  state.activeRow = undefined;
});

const CLOUD_ROW = {
  ollama_name: 'gpt-4o-mini',
  context_window: 128000,
  provider: 'openai',
  base_url: 'https://api.openai.com/v1',
};
const LOCAL_ROW = {
  ollama_name: 'llama3.2:3b',
  context_window: 8192,
  provider: 'ollama',
  base_url: 'http://localhost:11434/v1',
};

describe('ensureModelReady with a CLOUD active model', () => {
  it('reports ready immediately, no warm-up, no spawn, no install nag (Ollama absent)', async () => {
    state.activeRow = CLOUD_ROW;
    const calls = stubFetch({ tagsOk: false }); // Ollama not running/installed
    const statuses: string[] = [];
    await ensureModelReady(s => statuses.push(s.phase));

    expect(statuses).toContain('ready');
    expect(statuses).not.toContain('not_installed');
    expect(statuses).not.toContain('warming');
    expect(statuses).not.toContain('starting');
    expect(getModelStatus().phase).toBe('ready');
    expect(getModelStatus().model).toBe('gpt-4o-mini');

    // Zero unintended localhost calls: only the read-only /api/tags probe.
    const nonProbe = calls.filter(c => !c.url.endsWith('/api/tags'));
    expect(nonProbe).toEqual([]);
    expect(spawnSpy).not.toHaveBeenCalled();
  });

  it('still provisions local embeddings when Ollama happens to be running', async () => {
    state.activeRow = CLOUD_ROW;
    const calls = stubFetch({ tagsOk: true, tagsModels: ['nomic-embed-text'] });
    await ensureModelReady(() => { /* status not under test */ });
    // Flush the fire-and-forget ensureEmbedModel chain.
    await new Promise(r => setTimeout(r, 0));

    // Embed model already installed → tags probes only; still no generate/pull.
    expect(calls.some(c => c.url.endsWith('/api/generate'))).toBe(false);
    expect(calls.some(c => c.url.endsWith('/api/pull'))).toBe(false);
    expect(spawnSpy).not.toHaveBeenCalled();
  });
});

describe('ensureModelReady with a LOCAL active model (regression)', () => {
  it('still warms the model when the server is up', async () => {
    state.activeRow = LOCAL_ROW;
    const calls = stubFetch({ tagsOk: true, tagsModels: ['nomic-embed-text'] });
    const statuses: string[] = [];
    await ensureModelReady(s => statuses.push(s.phase));

    expect(calls.some(c => c.url.endsWith('/api/generate') && c.method === 'POST')).toBe(true);
    expect(statuses).toContain('warming');
    expect(getModelStatus().phase).toBe('ready');
  });
});

describe('unloadActiveModel', () => {
  it('is a no-op for a cloud active model (no localhost eviction call)', async () => {
    state.activeRow = CLOUD_ROW;
    const calls = stubFetch({ tagsOk: true });
    await unloadActiveModel();
    expect(calls).toEqual([]);
  });

  it('still evicts a local active model', async () => {
    state.activeRow = LOCAL_ROW;
    const calls = stubFetch({ tagsOk: true });
    await unloadActiveModel();
    expect(calls.some(c => c.url.endsWith('/api/generate') && c.method === 'POST')).toBe(true);
  });
});
