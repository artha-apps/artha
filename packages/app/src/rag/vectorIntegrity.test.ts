/**
 * Phase A vector-integrity invariant tests (founder directive 2026-07-23):
 * "Artha never stores or compares a knowingly invalid embedding vector."
 *
 * Covers the required matrix: embedder unavailable, model missing, endpoint
 * error, empty/all-zero/NaN/wrong-dimension responses, no invalid vector
 * persisted, keyword-usable text retained, semantic search excluding invalid
 * and pending records, no automatic cloud call, and pending→valid upgrade.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  isValidVector, partitionByVectorValidity, EmbeddingUnavailableError, EMBED_DIM,
} from './vectorIntegrity';

const vec = (fill = 0.1, dim = EMBED_DIM) => new Array(dim).fill(fill);

describe('isValidVector (the invariant)', () => {
  it('accepts a well-formed non-zero vector of the expected dimension', () => {
    expect(isValidVector(vec())).toBe(true);
  });

  it('rejects the legacy fabricated all-zero vector', () => {
    expect(isValidVector(new Array(EMBED_DIM).fill(0))).toBe(false);
  });

  it('rejects empty / missing payloads', () => {
    expect(isValidVector([])).toBe(false);
    expect(isValidVector(null)).toBe(false);
    expect(isValidVector(undefined)).toBe(false);
  });

  it('rejects NaN and Infinity elements', () => {
    const withNaN = vec(); withNaN[5] = NaN;
    const withInf = vec(); withInf[7] = Infinity;
    expect(isValidVector(withNaN)).toBe(false);
    expect(isValidVector(withInf)).toBe(false);
  });

  it('rejects wrong dimensionality in both directions', () => {
    expect(isValidVector(vec(0.1, EMBED_DIM - 1))).toBe(false);
    expect(isValidVector(vec(0.1, EMBED_DIM + 1))).toBe(false);
    expect(isValidVector(vec(0.1, 384))).toBe(false);
  });

  it('rejects non-numeric contents', () => {
    const strs = new Array(EMBED_DIM).fill('0.1');
    expect(isValidVector(strs)).toBe(false);
  });
});

describe('partitionByVectorValidity (retrieval exclusion)', () => {
  it('separates valid from pending/legacy-invalid and counts the exclusions', () => {
    const chunks = [
      { id: 'ok', embedding: vec() },
      { id: 'pending', embedding: null },
      { id: 'legacy-zero', embedding: new Array(EMBED_DIM).fill(0) },
      { id: 'wrong-dim', embedding: vec(0.1, 384) },
      { id: 'ok2', embedding: vec(0.2) },
    ];
    const { valid, excludedCount } = partitionByVectorValidity(chunks);
    expect(valid.map(c => c.id)).toEqual(['ok', 'ok2']);
    expect(excludedCount).toBe(3);
  });
});

// ── Indexer behaviour (real class, temp dir, stubbed fetch + DB) ────────────

const { dbState } = vi.hoisted(() => ({ dbState: { docCount: -1 } }));

vi.mock('electron', () => ({ app: { getPath: () => os.tmpdir() } }));
vi.mock('../db/schema', () => ({
  getDb: () => ({
    prepare: (sql: string) => ({
      run: (...args: unknown[]) => {
        if (sql.includes('UPDATE rag_indexes')) dbState.docCount = args[0] as number;
        return { changes: 1 };
      },
      get: () => undefined,
      all: () => [],
    }),
  }),
}));

import { RAGIndexer } from './indexer';

let tmp: string;
let srcDir: string;

/** fetch stub with a per-scenario embeddings response + call recorder. */
function stubEmbedFetch(mode:
  | 'ok' | 'unreachable' | 'http500' | 'model_missing' | 'empty' | 'zeros' | 'nan' | 'wrongdim') {
  const calls: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string | URL) => {
    calls.push(String(url));
    if (mode === 'unreachable') throw new Error('ECONNREFUSED');
    if (mode === 'http500') return { ok: false, status: 500, json: async () => ({}) } as unknown as Response;
    if (mode === 'model_missing') {
      // Ollama's shape when the embed model isn't pulled.
      return { ok: false, status: 404, json: async () => ({ error: 'model not found' }) } as unknown as Response;
    }
    const body =
      mode === 'empty' ? { embedding: [] } :
      mode === 'zeros' ? { embedding: new Array(EMBED_DIM).fill(0) } :
      mode === 'nan' ? { embedding: (() => { const v = vec(); v[3] = NaN; return v; })() } :
      mode === 'wrongdim' ? { embedding: vec(0.1, 128) } :
      { embedding: vec(0.5) };
    return { ok: true, status: 200, json: async () => body } as unknown as Response;
  }));
  return calls;
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'artha-idx-'));
  srcDir = fs.mkdtempSync(path.join(os.tmpdir(), 'artha-src-'));
  fs.writeFileSync(path.join(srcDir, 'note.txt'), 'Quarterly revenue rose in the western region.');
  dbState.docCount = -1;
});

afterEach(() => {
  vi.unstubAllGlobals();
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.rmSync(srcDir, { recursive: true, force: true });
});

const readIndex = (id: string) =>
  JSON.parse(fs.readFileSync(path.join(tmp, `${id}.json`), 'utf-8')) as
    { chunks: { text: string; embedding: number[] | null; state?: string }[] };

describe('indexer never persists an invalid vector', () => {
  for (const mode of ['unreachable', 'http500', 'model_missing', 'empty', 'zeros', 'nan', 'wrongdim'] as const) {
    it(`marks chunks pending (never a fabricated vector) when the embedder is ${mode}`, async () => {
      stubEmbedFetch(mode);
      const idx = new RAGIndexer(tmp);
      const embedded = await idx.buildIndex('i1', srcDir);

      const { chunks } = readIndex('i1');
      expect(chunks.length).toBeGreaterThan(0);
      for (const c of chunks) {
        expect(c.embedding).toBeNull();               // no placeholder vector on disk
        expect(c.state).toBe('pending_embedding');    // explicit honest state
        expect(c.text.length).toBeGreaterThan(0);     // text retained for keyword use / re-embed
      }
      // doc_count reports EMBEDDED chunks only — a degraded index can't look healthy.
      expect(embedded).toBe(0);
      expect(dbState.docCount).toBe(0);
    });
  }

  it('persists real vectors when the embedder works', async () => {
    stubEmbedFetch('ok');
    const idx = new RAGIndexer(tmp);
    const embedded = await idx.buildIndex('i1', srcDir);
    const { chunks } = readIndex('i1');
    expect(embedded).toBe(chunks.length);
    for (const c of chunks) {
      expect(isValidVector(c.embedding)).toBe(true);
      expect(c.state).toBeUndefined();
    }
  });
});

describe('semantic retrieval excludes invalid / pending records', () => {
  it('returns no semantic hits when the query embedding is unavailable (no crash)', async () => {
    stubEmbedFetch('ok');
    const idx = new RAGIndexer(tmp);
    await idx.buildIndex('i1', srcDir);

    stubEmbedFetch('unreachable'); // embedder goes down before the query
    await expect(idx.queryWithSources('i1', 'revenue', 5)).resolves.toEqual([]);
    await expect(idx.query('i1', 'revenue', 5)).resolves.toEqual([]);
  });

  it('skips pending chunks while scoring the valid ones', async () => {
    stubEmbedFetch('ok');
    const idx = new RAGIndexer(tmp);
    await idx.buildIndex('i1', srcDir);

    // Hand-plant a pending chunk + a legacy all-zero chunk alongside real ones.
    const file = path.join(tmp, 'i1.json');
    const data = JSON.parse(fs.readFileSync(file, 'utf-8'));
    data.chunks.push(
      { id: 'p1', filePath: 'x.txt', text: 'pending text', embedding: null, state: 'pending_embedding' },
      { id: 'z1', filePath: 'y.txt', text: 'legacy zero text', embedding: new Array(EMBED_DIM).fill(0) },
    );
    fs.writeFileSync(file, JSON.stringify(data));

    const hits = await idx.queryWithSources('i1', 'revenue', 10);
    expect(hits.some(h => h.id === 'p1')).toBe(false);
    expect(hits.some(h => h.id === 'z1')).toBe(false);
    expect(hits.length).toBeGreaterThan(0); // the valid ones still rank
  });
});

describe('recovery + routing guarantees', () => {
  it('a later valid embedding replaces a pending state on re-index', async () => {
    stubEmbedFetch('unreachable');
    const idx = new RAGIndexer(tmp);
    await idx.buildIndex('i1', srcDir);
    expect(readIndex('i1').chunks.every(c => c.state === 'pending_embedding')).toBe(true);

    // Embedder comes back; same unchanged file must NOT be forwarded as pending.
    stubEmbedFetch('ok');
    const embedded = await idx.buildIndex('i1', srcDir);
    const { chunks } = readIndex('i1');
    expect(embedded).toBe(chunks.length);
    expect(chunks.every(c => isValidVector(c.embedding))).toBe(true);
    expect(chunks.every(c => c.state === undefined)).toBe(true);
  });

  it('no automatic cloud embedding call — every embed request stays on loopback', async () => {
    const calls = stubEmbedFetch('ok');
    const idx = new RAGIndexer(tmp);
    await idx.buildIndex('i1', srcDir);
    await idx.queryWithSources('i1', 'revenue', 3);
    expect(calls.length).toBeGreaterThan(0);
    for (const url of calls) {
      expect(url.startsWith('http://localhost:11434/')).toBe(true);
    }
  });

  it('fails fast: one embedder outage does not re-request per chunk (review H2)', async () => {
    // Multi-chunk corpus so a per-chunk retry storm would be visible.
    fs.writeFileSync(path.join(srcDir, 'big.txt'), 'lorem ipsum dolor sit amet. '.repeat(200));
    const calls = stubEmbedFetch('unreachable');
    const idx = new RAGIndexer(tmp);
    await idx.buildIndex('ff', srcDir);
    const { chunks } = readIndex('ff');
    expect(chunks.length).toBeGreaterThan(2);            // many chunks…
    expect(calls.length).toBe(1);                        // …one probe only
    expect(chunks.every(c => c.state === 'pending_embedding')).toBe(true);
    expect(chunks.every(c => c.embedding === null)).toBe(true);
  });

  it('EmbeddingUnavailableError carries a user-safe message and stable code', () => {
    const e = new EmbeddingUnavailableError('local embedding runtime unreachable');
    expect(e.code).toBe('EMBEDDING_UNAVAILABLE');
    expect(e.message).toMatch(/keyword/i);
    expect(e.message).not.toMatch(/undefined|\[object/);
  });
});
