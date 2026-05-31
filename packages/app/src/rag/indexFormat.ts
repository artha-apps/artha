/**
 * On-disk RAG index format + a backward-compatible parser. Kept free of
 * Electron/better-sqlite3 so it's unit-testable in a plain Node test runner.
 */

/** One indexed unit: a slice of a source file plus its embedding. */
export interface Chunk {
  /** MD5 hex of `filePath:charOffset` — stable across rebuilds when the file
   *  content hasn't changed so cached chunks can be forwarded as-is. */
  id: string;
  /** Absolute path to the source file this chunk was extracted from. */
  filePath: string;
  /** The chunk text, trimmed, as returned by `chunkOnBoundaries`. */
  text: string;
  /** Dense embedding vector from Ollama nomic-embed-text (768 dimensions). */
  embedding: number[];
}

/** Persisted index payload. Legacy indexes were a bare `Chunk[]`; v2 wraps the
 *  chunks with a per-file content-hash manifest so rebuilds can skip unchanged
 *  files. */
export interface IndexFile {
  version: number;
  chunks: Chunk[];
  fileHashes: Record<string, string>;
}

/** Parse the persisted index, tolerating the legacy bare-array format and
 *  partially-populated v2 objects. */
export function parseIndexFile(raw: string): { chunks: Chunk[]; fileHashes: Record<string, string> } {
  const parsed = JSON.parse(raw) as Chunk[] | IndexFile;
  if (Array.isArray(parsed)) return { chunks: parsed, fileHashes: {} };
  return { chunks: parsed.chunks ?? [], fileHashes: parsed.fileHashes ?? {} };
}
