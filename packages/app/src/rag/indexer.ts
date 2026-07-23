/**
 * RAG Indexer — builds and queries a local vector index over user files.
 * Uses Ollama's embedding endpoint (nomic-embed-text by default).
 * Stores vectors in a simple JSON file index (Phase 1 — LanceDB in Phase 2).
 */
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { app } from 'electron';
import { getDb } from '../db/schema';
import { extractText } from './extract';
import { parseIndexFile, type Chunk, type IndexFile } from './indexFormat';
import { chunkOnBoundaries } from './chunk';
import {
  EmbeddingUnavailableError, partitionByVectorValidity, isValidVector, EMBED_DIM,
} from './vectorIntegrity';

/** A retrieved chunk with its originating file — used to cite real sources in
 *  generated documents (not just anonymous context). */
export interface RetrievedChunk {
  id: string;
  filePath: string;
  text: string;
  score: number;
}

/** File extensions we attempt to embed. PDF/DOCX/XLSX go through real
 *  extractors (see `extract.ts`); the rest are read as UTF-8. Keeping the list
 *  narrow avoids embedding e.g. images. */
const SUPPORTED_EXTENSIONS = ['.txt', '.md', '.pdf', '.docx', '.xlsx', '.csv', '.json', '.ts', '.js', '.py'];
/** Characters per chunk. 512 keeps each vector roughly within a single
 *  semantic idea while staying well under nomic-embed-text's 2k token limit. */
const CHUNK_SIZE = 512;
/** Overlap between consecutive chunks so a fact straddling a boundary still
 *  appears intact in at least one chunk. */
const CHUNK_OVERLAP = 64;
const OLLAMA_EMBED_URL = 'http://localhost:11434/api/embeddings';
const EMBED_MODEL = 'nomic-embed-text';

/** File → chunk → vector pipeline rooted at a single on-disk directory.
 *  One `RAGIndexer` instance covers many indexes (each persisted as its own
 *  `<indexId>.json` file under `indexDir`). */
export class RAGIndexer {
  private indexDir: string;

  constructor(indexDir: string) {
    this.indexDir = indexDir;
    fs.mkdirSync(indexDir, { recursive: true });
  }

  /** Walk `dirPath` recursively, chunk + embed every supported file, and write
   *  the resulting array to `<indexDir>/<indexId>.json`. Returns the number of
   *  chunks indexed and updates `rag_indexes.doc_count` + `last_indexed`. */
  async buildIndex(indexId: string, dirPath: string): Promise<number> {
    const indexPath = path.join(this.indexDir, `${indexId}.json`);

    // Load the previous index (if any) so we can reuse embeddings for files
    // whose content hasn't changed — re-embedding is the expensive part.
    let prev: { chunks: Chunk[]; fileHashes: Record<string, string> } = { chunks: [], fileHashes: {} };
    if (fs.existsSync(indexPath)) {
      try { prev = parseIndexFile(fs.readFileSync(indexPath, 'utf-8')); } catch { /* rebuild from scratch */ }
    }
    const prevByFile = new Map<string, Chunk[]>();
    for (const c of prev.chunks) {
      const arr = prevByFile.get(c.filePath) ?? [];
      arr.push(c);
      prevByFile.set(c.filePath, arr);
    }

    const files = this.collectFiles(dirPath);
    const chunks: Chunk[] = [];
    const fileHashes: Record<string, string> = {};
    /** Chunks written WITHOUT a vector because the embedder was unavailable.
     *  Their text is still stored (keyword use + later re-embedding), but they
     *  are excluded from semantic scoring until re-embedded. */
    let pending = 0;

    for (const file of files) {
      try {
        const buf = fs.readFileSync(file);
        const hash = crypto.createHash('md5').update(buf).digest('hex');
        fileHashes[file] = hash;

        // Unchanged + already VALIDLY embedded → carry the chunks forward.
        // Cached chunks that are pending (or hold a legacy invalid vector) fall
        // through to the re-embed path below, so a later run with a working
        // embedder upgrades them instead of stranding them forever.
        const cached = prevByFile.get(file);
        if (prev.fileHashes[file] === hash && cached?.length &&
            cached.every(c => isValidVector(c.embedding, EMBED_DIM))) {
          chunks.push(...cached);
          continue;
        }

        // New or changed — extract real text (not raw UTF-8) and re-embed.
        const text = await extractText(file);
        if (!text.trim()) continue;
        for (const chunk of this.chunkText(text, file)) {
          try {
            const embedding = await this.embed(chunk.text);
            chunks.push({ ...chunk, embedding });
          } catch (err) {
            if (!(err instanceof EmbeddingUnavailableError)) throw err;
            // Persist the TEXT with an explicit pending state — never a
            // fabricated vector. Keyword retrieval still works; semantic
            // scoring skips it until a valid embedding replaces it.
            chunks.push({ ...chunk, embedding: null, state: 'pending_embedding' });
            pending++;
          }
        }
      } catch {
        // Skip unreadable files silently
      }
    }
    // Files that disappeared from disk are simply not carried forward.

    const payload: IndexFile = { version: 2, chunks, fileHashes };
    fs.writeFileSync(indexPath, JSON.stringify(payload));

    const db = getDb();
    // doc_count reflects EMBEDDED chunks only, so a degraded index never
    // reports a healthy count. Sanitized diagnostics: counts, never content.
    const embedded = chunks.length - pending;
    if (pending > 0) {
      console.warn(
        `[Artha] RAG index ${indexId}: ${pending} chunk(s) stored without embeddings ` +
        `(embedder unavailable); ${embedded} embedded. Semantic search excludes the pending chunks.`
      );
    }
    db.prepare(`UPDATE rag_indexes SET doc_count=?, last_indexed=unixepoch() WHERE index_id=?`)
      .run(embedded, indexId);

    return embedded;
  }

  /** Embed `query` and return the top-k chunk *texts* (not records) ranked by
   *  cosine similarity. Returns `[]` if the index file doesn't exist yet so
   *  callers can fall back gracefully on first-use. */
  async query(indexId: string, query: string, topK = 5): Promise<string[]> {
    const hits = await this.queryWithSources(indexId, query, topK);
    return hits.map(h => h.text);
  }

  /** Like `query()` but returns the originating file + score for each hit, so
   *  callers can attach real provenance. `[]` if the index doesn't exist yet. */
  async queryWithSources(indexId: string, query: string, topK = 5): Promise<RetrievedChunk[]> {
    const indexPath = path.join(this.indexDir, `${indexId}.json`);
    if (!fs.existsSync(indexPath)) return [];

    const { chunks } = parseIndexFile(fs.readFileSync(indexPath, 'utf-8'));

    // No embedder → NO semantic results (callers degrade to keyword). We
    // never compare against a fabricated query vector, and never crash chat.
    let queryEmbedding: number[];
    try {
      queryEmbedding = await this.embed(query);
    } catch (err) {
      if (!(err instanceof EmbeddingUnavailableError)) throw err;
      return [];
    }

    // Exclude pending chunks AND legacy invalid vectors (all-zero from the
    // pre-patch fallback, non-finite, wrong dimension) from scoring.
    const { valid, excludedCount } = partitionByVectorValidity(chunks, EMBED_DIM);
    if (excludedCount > 0) {
      console.warn(
        `[Artha] RAG index ${indexId}: ${excludedCount} chunk(s) excluded from semantic search ` +
        `(missing or invalid embedding). Re-index with the embedder available to restore them.`
      );
    }

    return valid
      .map(chunk => ({
        id: chunk.id,
        filePath: chunk.filePath,
        text: chunk.text,
        score: cosineSimilarity(queryEmbedding, chunk.embedding as number[]),
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
  }

  /** Recursively enumerate every file under `dir` whose extension is in
   *  `SUPPORTED_EXTENSIONS`. Hidden directories (names starting with `.`) are
   *  skipped so `.git`, `.node_modules` etc. are never indexed. */
  private collectFiles(dir: string): string[] {
    const results: string[] = [];
    const walk = (d: string) => {
      for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
        const full = path.join(d, entry.name);
        if (entry.isDirectory() && !entry.name.startsWith('.')) walk(full);
        else if (entry.isFile() && SUPPORTED_EXTENSIONS.includes(path.extname(entry.name).toLowerCase())) {
          results.push(full);
        }
      }
    };
    walk(dir);
    return results;
  }

  /** Split `text` into boundary-aligned chunks and assign each a stable MD5 id
   *  derived from `filePath:offset`, so re-indexing an unchanged file produces
   *  the same ids and the cache in `buildIndex` can forward them cheaply. */
  private chunkText(text: string, filePath: string): Omit<Chunk, 'embedding'>[] {
    // Break on sentence/word boundaries (see rag/chunk.ts) so embeddings see
    // whole words/sentences instead of arbitrary 512-char slices.
    return chunkOnBoundaries(text, CHUNK_SIZE, CHUNK_OVERLAP).map(({ text: slice, offset }) => ({
      id: crypto.createHash('md5').update(`${filePath}:${offset}`).digest('hex'),
      filePath,
      text: slice,
    }));
  }

  /**
   * Call Ollama's /api/embeddings (LOCAL only — Phase A has no cloud
   * embedder, so indexing can never route user content off-device).
   *
   * THROWS `EmbeddingUnavailableError` on any failure or malformed/invalid
   * response. It never returns a fabricated vector: the old zero-vector
   * fallback made unusable indexes look functional (Phase A integrity
   * invariant, founder directive 2026-07-23).
   */
  private async embed(text: string): Promise<number[]> {
    let json: { embedding?: unknown };
    try {
      const res = await fetch(OLLAMA_EMBED_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: EMBED_MODEL, prompt: text }),
      });
      if (!res.ok) throw new EmbeddingUnavailableError(`embedding endpoint returned ${res.status}`);
      json = await res.json() as { embedding?: unknown };
    } catch (err) {
      if (err instanceof EmbeddingUnavailableError) throw err;
      throw new EmbeddingUnavailableError('local embedding runtime unreachable');
    }
    // Empty, wrong-dimension, all-zero, or non-finite payloads are invalid —
    // treat exactly like unavailability rather than persisting them.
    if (!isValidVector(json.embedding, EMBED_DIM)) {
      throw new EmbeddingUnavailableError('embedding response was empty or invalid');
    }
    return json.embedding;
  }
}

// ── Shared instance + cross-index search ─────────────────────────────────────

let defaultIndexer: RAGIndexer | null = null;

/** The app-wide indexer, rooted at <userData>/rag-indexes. Used by both the IPC
 *  layer and the docs_generate tool so they share one on-disk index set. */
export function getDefaultRagIndexer(): RAGIndexer {
  if (!defaultIndexer) {
    defaultIndexer = new RAGIndexer(path.join(app.getPath('userData'), 'rag-indexes'));
  }
  return defaultIndexer;
}

/** Search RAG indexes and return the globally top-k chunks by similarity.
 *  Used to ground generated documents in the user's own files, and by the
 *  `rag_search` tool. When `indexIds` is given (and non-empty), only those
 *  indexes are searched — this is how a scoped chat confines retrieval to its
 *  attached folders; otherwise every configured index is searched.
 *  Failures (Ollama down, missing index files) degrade to fewer/no results. */
export async function searchAllIndexes(query: string, topK = 6, indexIds?: string[] | null): Promise<RetrievedChunk[]> {
  const indexer = getDefaultRagIndexer();
  const indexes = (indexIds && indexIds.length)
    ? indexIds.map(index_id => ({ index_id }))
    : getDb().prepare(`SELECT index_id FROM rag_indexes`).all() as { index_id: string }[];
  const all: RetrievedChunk[] = [];
  for (const { index_id } of indexes) {
    try {
      all.push(...await indexer.queryWithSources(index_id, query, topK));
    } catch {
      /* skip a bad index */
    }
  }
  return all.sort((a, b) => b.score - a.score).slice(0, topK);
}

/** Standard cosine similarity. Callers pass only vectors that already passed
 *  `isValidVector`; the length guard and `|| 1` denominator remain as belt-and
 *  -braces against a malformed legacy row slipping through. */
function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] ** 2;
    normB += b[i] ** 2;
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB) || 1);
}
