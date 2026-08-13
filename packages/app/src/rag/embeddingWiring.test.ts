/**
 * Phase B Slice 2c — the consent-resolved embedder actually wired into the
 * RAG build + query paths:
 *   - buildIndex embeds via the injected provider and records what the index
 *     was ACTUALLY built with (embedding_model + embedding_dim, D-B2);
 *   - an embedder identity change discards the chunk cache (vectors from a
 *     different vector space are never carried forward);
 *   - queryWithSources refuses a cross-vector-space search with a typed
 *     EmbedderMismatchError naming the index (D-B3) — and, symmetrically,
 *     never sends a local index's query text to a cloud embedder;
 *   - probeCloudEmbedding derives the dimension from the provider's real
 *     response and fails honestly on auth/invalid payloads.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { EmbeddingProvider, EmbedOutcome } from './embeddingProvider';
import { EmbedderMismatchError, probeCloudEmbedding } from './embeddingProvider';

// In-memory stand-in for the rag_indexes row + UPDATE capture. The UPDATE also
// writes back into `row` so a rebuild sees the identity the last build stored,
// exactly like the real DB.
const { dbState } = vi.hoisted(() => ({
  dbState: {
    row: null as { name?: string; embedding_model: string; embedding_dim: number } | null,
    lastUpdate: null as { docCount: number; model: string; dim: number } | null,
  },
}));

vi.mock('electron', () => ({ app: { getPath: () => os.tmpdir() } }));
vi.mock('../db/schema', () => ({
  getDb: () => ({
    prepare: (sql: string) => ({
      run: (...args: unknown[]) => {
        if (sql.includes('UPDATE rag_indexes')) {
          dbState.lastUpdate = { docCount: args[0] as number, model: args[1] as string, dim: args[2] as number };
          dbState.row = { ...(dbState.row ?? {}), embedding_model: args[1] as string, embedding_dim: args[2] as number };
        }
        return { changes: 1 };
      },
      get: () => (sql.includes('FROM rag_indexes') ? dbState.row ?? undefined : undefined),
      all: () => [],
    }),
  }),
}));

import { RAGIndexer } from './indexer';

/** A deterministic fake embedder — small dims keep the on-disk fixtures tiny. */
function fakeProvider(model: string, dim: number): EmbeddingProvider & { calls: string[] } {
  const calls: string[] = [];
  return {
    id: `fake:${model}`, model, dim, isLocal: false, calls,
    async embed(text: string): Promise<EmbedOutcome> {
      calls.push(text);
      // Vary by text length so cosine similarity is non-degenerate.
      const vector = Array.from({ length: dim }, (_, i) => 0.1 + ((text.length + i) % 7) * 0.05);
      return { ok: true, result: { vector, model, dim } };
    },
  };
}

let tmp: string;
let srcDir: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'artha-2c-idx-'));
  srcDir = fs.mkdtempSync(path.join(os.tmpdir(), 'artha-2c-src-'));
  fs.writeFileSync(path.join(srcDir, 'note.txt'), 'Quarterly revenue rose in the western region.');
  dbState.row = null;
  dbState.lastUpdate = null;
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.rmSync(srcDir, { recursive: true, force: true });
});

describe('buildIndex with a resolved provider (D-B2)', () => {
  it('embeds through the injected provider and records model + dim on the index row', async () => {
    const provider = fakeProvider('cloud-embed', 16);
    const idx = new RAGIndexer(tmp, () => provider);
    const embedded = await idx.buildIndex('i1', srcDir);

    expect(embedded).toBeGreaterThan(0);
    expect(provider.calls.length).toBe(embedded);
    expect(dbState.lastUpdate).toEqual({ docCount: embedded, model: 'cloud-embed', dim: 16 });

    const { chunks } = JSON.parse(fs.readFileSync(path.join(tmp, 'i1.json'), 'utf-8'));
    for (const c of chunks) expect(c.embedding).toHaveLength(16);
  });

  it('discards the chunk cache when the embedder identity changed (no cross-space carry-forward)', async () => {
    const a = fakeProvider('embed-a', 8);
    await new RAGIndexer(tmp, () => a).buildIndex('i1', srcDir);
    const firstBuildCalls = a.calls.length;
    expect(firstBuildCalls).toBeGreaterThan(0);

    // Same files, unchanged hashes — but a DIFFERENT embedder. Every chunk
    // must be re-embedded; reusing 8-dim vectors in a 16-dim index would be
    // exactly the cross-space corruption D-B2/D-B3 exist to prevent.
    const b = fakeProvider('embed-b', 16);
    const embedded = await new RAGIndexer(tmp, () => b).buildIndex('i1', srcDir);
    expect(b.calls.length).toBe(embedded);
    expect(dbState.lastUpdate).toEqual({ docCount: embedded, model: 'embed-b', dim: 16 });

    const { chunks } = JSON.parse(fs.readFileSync(path.join(tmp, 'i1.json'), 'utf-8'));
    for (const c of chunks) expect(c.embedding).toHaveLength(16);
  });

  it('reuses cached vectors when the identity is unchanged (no wasteful re-embedding)', async () => {
    const a = fakeProvider('embed-a', 8);
    const idx = new RAGIndexer(tmp, () => a);
    await idx.buildIndex('i1', srcDir);
    const afterFirst = a.calls.length;

    await idx.buildIndex('i1', srcDir); // same provider, same files
    expect(a.calls.length).toBe(afterFirst); // cache hit — zero new embeds
  });
});

describe('queryWithSources vector-space guard (D-B3)', () => {
  it('refuses to search an index built with a different embedder, naming the index', async () => {
    const a = fakeProvider('embed-a', 8);
    const idx = new RAGIndexer(tmp, () => a);
    await idx.buildIndex('i1', srcDir);
    dbState.row = { ...dbState.row!, name: 'Docs' };

    const b = fakeProvider('embed-b', 16);
    const idxB = new RAGIndexer(tmp, () => b);
    await expect(idxB.queryWithSources('i1', 'revenue', 5)).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(EmbedderMismatchError);
      const e = err as EmbedderMismatchError;
      expect(e.indexName).toBe('Docs');
      expect(e.message).toContain('re-index');
      return true;
    });
    // Crucially: the mismatched provider was never asked to embed the query —
    // a local index's query text must not reach a cloud embedder.
    expect(b.calls.length).toBe(0);
  });

  it('searches normally when the index identity matches the active embedder', async () => {
    const a = fakeProvider('embed-a', 8);
    const idx = new RAGIndexer(tmp, () => a);
    await idx.buildIndex('i1', srcDir);

    const hits = await idx.queryWithSources('i1', 'revenue', 5);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].filePath).toContain('note.txt');
  });
});

describe('probeCloudEmbedding (test-before-activate)', () => {
  const okFetch = (dim: number) => (async () => ({
    ok: true, status: 200,
    json: async () => ({ data: [{ embedding: Array.from({ length: dim }, () => 0.2) }] }),
  })) as unknown as typeof fetch;

  it('derives the dimension from the actual response, never a guess', async () => {
    const res = await probeCloudEmbedding('https://api.example.com/v1', 'k', 'text-embedding-3-small', okFetch(1536));
    expect(res).toEqual({ ok: true, dim: 1536 });
  });

  it('reports a rejected key honestly', async () => {
    const fetch401 = (async () => ({ ok: false, status: 401, json: async () => ({}) })) as unknown as typeof fetch;
    const res = await probeCloudEmbedding('https://api.example.com/v1', 'bad', 'm', fetch401);
    expect(res).toEqual({ ok: false, error: 'The provider rejected the API key.' });
  });

  it('rejects an all-zero / malformed embedding payload', async () => {
    const zeroFetch = (async () => ({
      ok: true, status: 200, json: async () => ({ data: [{ embedding: [0, 0, 0, 0] }] }),
    })) as unknown as typeof fetch;
    expect((await probeCloudEmbedding('https://x.test', 'k', 'm', zeroFetch)).ok).toBe(false);

    const emptyFetch = (async () => ({ ok: true, status: 200, json: async () => ({}) })) as unknown as typeof fetch;
    expect((await probeCloudEmbedding('https://x.test', 'k', 'm', emptyFetch)).ok).toBe(false);
  });

  it('reports an unreachable endpoint without throwing', async () => {
    const downFetch = (async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch;
    expect(await probeCloudEmbedding('https://x.test', 'k', 'm', downFetch))
      .toEqual({ ok: false, error: 'Could not reach the embedding endpoint.' });
  });
});
