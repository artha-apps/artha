/**
 * Embedding provider port tests (Phase B, Slice 1). Pins the outcome contract —
 * ok vs unavailable vs invalid — and the privacy-critical isLocal flag, since a
 * non-local provider would send indexed text off-device.
 */
import { describe, it, expect, vi } from 'vitest';
import { OllamaEmbeddingProvider, getActiveEmbeddingProvider, embedderMatchesIndex } from './embeddingProvider';

const okVec = () => Array.from({ length: 768 }, (_, i) => (i % 7) * 0.01 + 0.001);

function fakeFetch(res: { ok?: boolean; status?: number; body?: unknown; throws?: boolean }) {
  return vi.fn(async () => {
    if (res.throws) throw new Error('ECONNREFUSED');
    return { ok: res.ok ?? true, status: res.status ?? 200, json: async () => res.body } as unknown as Response;
  }) as unknown as typeof fetch;
}

describe('OllamaEmbeddingProvider', () => {
  it('is local (on-device) and self-describing', () => {
    const p = new OllamaEmbeddingProvider();
    expect(p.isLocal).toBe(true);
    expect(p.id).toBe('ollama:nomic-embed-text');
    expect(p.dim).toBe(768);
  });

  it('returns ok with the vector + model + dim on a valid response', async () => {
    const p = new OllamaEmbeddingProvider('nomic-embed-text', 768, 'http://x', fakeFetch({ body: { embedding: okVec() } }));
    const out = await p.embed('hello');
    expect(out.ok).toBe(true);
    if (out.ok) { expect(out.result.dim).toBe(768); expect(out.result.model).toBe('nomic-embed-text'); expect(out.result.vector).toHaveLength(768); }
  });

  it('reports UNAVAILABLE (not error) when the endpoint is unreachable', async () => {
    const p = new OllamaEmbeddingProvider('nomic-embed-text', 768, 'http://x', fakeFetch({ throws: true }));
    const out = await p.embed('hello');
    expect(out).toMatchObject({ ok: false, reason: 'unavailable' });
  });

  it('reports UNAVAILABLE on a non-200', async () => {
    const p = new OllamaEmbeddingProvider('nomic-embed-text', 768, 'http://x', fakeFetch({ ok: false, status: 503 }));
    expect(await p.embed('x')).toMatchObject({ ok: false, reason: 'unavailable' });
  });

  it('reports INVALID for a wrong-dimension / empty / all-zero vector (never persisted)', async () => {
    const short = new OllamaEmbeddingProvider('nomic-embed-text', 768, 'http://x', fakeFetch({ body: { embedding: [1, 2, 3] } }));
    expect(await short.embed('x')).toMatchObject({ ok: false, reason: 'invalid' });
    const zeros = new OllamaEmbeddingProvider('nomic-embed-text', 768, 'http://x', fakeFetch({ body: { embedding: new Array(768).fill(0) } }));
    expect(await zeros.embed('x')).toMatchObject({ ok: false, reason: 'invalid' });
  });
});

describe('active provider (Slice 1)', () => {
  it('defaults to a LOCAL provider — no cloud embedder can route text off-device yet', () => {
    expect(getActiveEmbeddingProvider().isLocal).toBe(true);
  });
});

describe('embedderMatchesIndex — D-B3 vector-space guard', () => {
  const nomic = new OllamaEmbeddingProvider('nomic-embed-text', 768);
  it('matches when model AND dim agree', () => {
    expect(embedderMatchesIndex({ model: 'nomic-embed-text', dim: 768 }, nomic)).toEqual({ ok: true });
  });
  it('REFUSES on a dimension mismatch (the garbage-similarity case)', () => {
    const r = embedderMatchesIndex({ model: 'text-embedding-3-small', dim: 1536 }, nomic);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/re-index/i);
  });
  it('REFUSES on a same-dim but different-model mismatch', () => {
    const r = embedderMatchesIndex({ model: 'other-768', dim: 768 }, nomic);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/re-index/i);
  });
});
