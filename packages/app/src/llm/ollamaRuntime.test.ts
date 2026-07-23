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

// fs gates ollamaInstalled(); controllable so tests don't depend on whether
// THIS machine has Ollama at /opt/homebrew/bin.
const { fsState } = vi.hoisted(() => ({ fsState: { installed: true } }));
vi.mock('fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('fs')>();
  return { ...real, existsSync: () => fsState.installed };
});

import { ensureModelReady, unloadActiveModel, getModelStatus, getSemanticStatus } from './ollamaRuntime';

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
  fsState.installed = true;
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

describe('ensureModelReady with NO active model (commit 3: honest empty state)', () => {
  it('reports no_model — not ready — when the server is up but nothing is active', async () => {
    state.activeRow = undefined;
    stubFetch({ tagsOk: true });
    await ensureModelReady(() => { /* phases checked via getModelStatus */ });
    expect(getModelStatus().phase).toBe('no_model');
  });

  it('reports no_model — not a false install-Ollama nag — when Ollama is absent too', async () => {
    state.activeRow = undefined;
    fsState.installed = false;
    stubFetch({ tagsOk: false });
    const statuses: string[] = [];
    await ensureModelReady(s => statuses.push(s.phase));
    expect(getModelStatus().phase).toBe('no_model');
    expect(statuses).not.toContain('not_installed');
    expect(spawnSpy).not.toHaveBeenCalled();
  });

  it('still nags not_installed when a LOCAL model IS active but Ollama is gone (regression)', async () => {
    state.activeRow = LOCAL_ROW;
    fsState.installed = false;
    stubFetch({ tagsOk: false });
    await ensureModelReady(() => { /* terminal phase asserted below */ });
    expect(getModelStatus().phase).toBe('not_installed');
  });

  it('recovers across a simulated restart: no_model → user configures cloud → ready', async () => {
    state.activeRow = undefined;
    stubFetch({ tagsOk: false });
    fsState.installed = false;
    await ensureModelReady(() => { /* first launch: nothing configured */ });
    expect(getModelStatus().phase).toBe('no_model');

    // "Restart" after the user added + activated a BYOK model.
    state.activeRow = CLOUD_ROW;
    stubFetch({ tagsOk: false });
    await ensureModelReady(() => { /* second launch: cloud model active */ });
    expect(getModelStatus().phase).toBe('ready');
    expect(getModelStatus().model).toBe('gpt-4o-mini');
  });
});

describe('ensureModelReady returns its OWN terminal status (row-10 race fix)', () => {
  it('cloud active model → returns ready, not whatever a concurrent run wrote', async () => {
    state.activeRow = CLOUD_ROW;
    stubFetch({ tagsOk: false });
    const returned = await ensureModelReady(() => {});
    expect(returned).toMatchObject({ phase: 'ready', model: 'gpt-4o-mini' });
    expect(returned).toEqual(getModelStatus());
  });

  it('nothing configured + Ollama absent → returns no_model with ollamaInstalled:false', async () => {
    state.activeRow = undefined;
    fsState.installed = false;
    stubFetch({ tagsOk: false });
    const returned = await ensureModelReady(() => {});
    expect(returned).toMatchObject({ phase: 'no_model', ollamaInstalled: false });
  });

  it('server up, nothing active → returns no_model with ollamaInstalled:true', async () => {
    state.activeRow = undefined;
    stubFetch({ tagsOk: true, tagsModels: ['nomic-embed-text'] });
    const returned = await ensureModelReady(() => {});
    expect(returned).toMatchObject({ phase: 'no_model', ollamaInstalled: true });
  });

  it('local model warms → returns ready for that model', async () => {
    state.activeRow = LOCAL_ROW;
    stubFetch({ tagsOk: true, tagsModels: ['nomic-embed-text'] });
    const returned = await ensureModelReady(() => {});
    expect(returned).toMatchObject({ phase: 'ready', model: 'llama3.2:3b' });
  });

  it('a later concurrent run cannot rewrite an earlier run’s returned object', async () => {
    state.activeRow = CLOUD_ROW;
    stubFetch({ tagsOk: false });
    const first = await ensureModelReady(() => {});
    state.activeRow = undefined;                 // simulate a different run
    fsState.installed = false;
    await ensureModelReady(() => {});             // overwrites the shared lastStatus
    expect(first).toMatchObject({ phase: 'ready', model: 'gpt-4o-mini' }); // unchanged
    expect(getModelStatus().phase).toBe('no_model');                        // shared moved on
  });
});

describe('getSemanticStatus (honest degraded states, commit 10)', () => {
  it('Ollama down → unavailable with ollama_down', async () => {
    stubFetch({ tagsOk: false });
    expect(await getSemanticStatus()).toEqual({ available: false, reason: 'ollama_down' });
  });

  it('Ollama up but embed model missing → embed_model_missing', async () => {
    stubFetch({ tagsOk: true, tagsModels: ['llama3.2:3b'] });
    expect(await getSemanticStatus()).toEqual({ available: false, reason: 'embed_model_missing' });
  });

  it('embed model installed (bare or tagged) → available', async () => {
    stubFetch({ tagsOk: true, tagsModels: ['nomic-embed-text:latest'] });
    expect(await getSemanticStatus()).toEqual({ available: true });
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
