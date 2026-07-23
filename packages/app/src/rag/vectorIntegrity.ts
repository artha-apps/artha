/**
 * Vector integrity — the Phase A invariant (founder directive, 2026-07-23):
 *
 *   Artha never stores or compares a knowingly invalid embedding vector.
 *
 * Before this module, an unavailable embedder produced fabricated 768-zero
 * vectors that were persisted and silently compared — semantic retrieval
 * looked functional while returning noise. Now:
 *   - embedding failure is a TYPED error, never a placeholder vector;
 *   - the indexer persists affected chunks as `pending_embedding` (text kept
 *     for keyword use and later re-embedding) with `embedding: null`;
 *   - retrieval validates every vector (legacy zero/NaN/wrong-dim rows are
 *     excluded and counted in sanitized diagnostics).
 *
 * The full pluggable-embedder architecture (providers, reindex workflows,
 * dimension migration) is Phase B — this module only enforces the invariant.
 * Electron-free and pure for direct unit testing.
 */

/** nomic-embed-text dimensionality — the only embedder Phase A supports. */
export const EMBED_DIM = 768;

/** Typed unavailability — callers decide policy (mark pending, return no
 *  semantic results); nobody fabricates a vector. Message is user-safe. */
export class EmbeddingUnavailableError extends Error {
  readonly code = 'EMBEDDING_UNAVAILABLE';
  constructor(reason?: string) {
    super(
      'Local embeddings are unavailable' + (reason ? ` (${reason})` : '') +
      ' — semantic indexing is paused; documents remain searchable by keyword.'
    );
    this.name = 'EmbeddingUnavailableError';
  }
}

/**
 * A vector is valid iff it is a number[] of the expected dimension, every
 * element is finite, and at least one element is non-zero. All-zero vectors
 * are treated as invalid BY DEFINITION here: the legacy failure path
 * fabricated exactly those, and a genuine all-zero embedding does not occur
 * with real models.
 */
export function isValidVector(v: unknown, dim: number = EMBED_DIM): v is number[] {
  if (!Array.isArray(v) || v.length !== dim) return false;
  let allZero = true;
  for (const x of v) {
    if (typeof x !== 'number' || !Number.isFinite(x)) return false;
    if (x !== 0) allZero = false;
  }
  return !allZero;
}

/** Split chunks into scorable (valid vector) vs excluded (pending/legacy-
 *  invalid). Retrieval scores ONLY `valid`; `excludedCount` feeds sanitized
 *  diagnostics so degraded indexes are measurable, never silent. */
export function partitionByVectorValidity<T extends { embedding: number[] | null | undefined }>(
  chunks: T[],
  dim: number = EMBED_DIM,
): { valid: T[]; excludedCount: number } {
  const valid: T[] = [];
  let excludedCount = 0;
  for (const c of chunks) {
    if (isValidVector(c.embedding, dim)) valid.push(c);
    else excludedCount++;
  }
  return { valid, excludedCount };
}
