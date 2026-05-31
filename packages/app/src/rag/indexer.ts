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

    for (const file of files) {
      try {
        const buf = fs.readFileSync(file);
        const hash = crypto.createHash('md5').update(buf).digest('hex');
        fileHashes[file] = hash;

        // Unchanged + already embedded → carry the existing chunks forward.
        const cached = prevByFile.get(file);
        if (prev.fileHashes[file] === hash && cached?.length) {
          chunks.push(...cached);
          continue;
        }

        // New or changed — extract real text (not raw UTF-8) and re-embed.
        const text = await extractText(file);
        if (!text.trim()) continue;
        for (const chunk of this.chunkText(text, file)) {
          const embedding = await this.embed(chunk.text);
          chunks.push({ ...chunk, embedding });
        }
      } catch {
        // Skip unreadable files silently
      }
    }
    // Files that disappeared from disk are simply not carried forward.

    const payload: IndexFile = { version: 2, chunks, fileHashes };
    fs.writeFileSync(indexPath, JSON.stringify(payload));

    const db = getDb();
    db.prepare(`UPDATE rag_indexes SET doc_count=?, last_indexed=unixepoch() WHERE index_id=?`)
      .run(chunks.length, indexId);

    return chunks.length;
  }

  /** Embed `query` and return the top-k chunk *texts* (not records) ranked by
   *  cosine similarity. Returns `[]` if the index file doesn't exist yet so
   *  callers can fall back gracefully on first-use. */
  async query(indexId: string, query: string, topK = 5): Promise<string[]> {
    const indexPath = path.join(this.indexDir, `${indexId}.json`);
    if (!fs.existsSync(indexPath)) return [];

    const { chunks } = parseIndexFile(fs.readFileSync(indexPath, 'utf-8'));
    const queryEmbedding = await this.embed(query);

    const scored = chunks.map(chunk => ({
      text: chunk.text,
      score: cosineSimilarity(queryEmbedding, chunk.embedding),
    }));

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, topK).map(s => s.text);
  }

  /** Like `query()` but returns the originating file + score for each hit, so
   *  callers can attach real provenance. `[]` if the index doesn't exist yet. */
  async queryWithSources(indexId: string, query: string, topK = 5): Promise<RetrievedChunk[]> {
    const indexPath = path.join(this.indexDir, `${indexId}.json`);
    if (!fs.existsSync(indexPath)) return [];

    const { chunks } = parseIndexFile(fs.readFileSync(indexPath, 'utf-8'));
    const queryEmbedding = await this.embed(query);

    return chunks
      .map(chunk => ({
        id: chunk.id,
        filePath: chunk.filePath,
        text: chunk.text,
        score: cosineSimilarity(queryEmbedding, chunk.embedding),
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

  /** Call Ollama's /api/embeddings. On failure (Ollama down, model not
   *  pulled, etc.) we return a 768-zero vector so indexing still completes;
   *  query() will simply rank such chunks as having zero similarity. */
  private async embed(text: string): Promise<number[]> {
    try {
      const res = await fetch(OLLAMA_EMBED_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: EMBED_MODEL, prompt: text }),
      });
      const json = await res.json() as { embedding: number[] };
      return json.embedding;
    } catch {
      return new Array(768).fill(0);
    }
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

/** Standard cosine similarity. Returns 0 when either vector is empty/zero so
 *  zero-vector fallbacks from `embed()` rank last instead of NaN-poisoning. */
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
