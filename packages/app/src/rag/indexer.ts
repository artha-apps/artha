/**
 * RAG Indexer — builds and queries a local vector index over user files.
 * Uses Ollama's embedding endpoint (nomic-embed-text by default).
 * Stores vectors in a simple JSON file index (Phase 1 — LanceDB in Phase 2).
 */
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { getDb } from '../db/schema';

/** File extensions we attempt to embed. Binary/proprietary types like .docx
 *  and .pdf go through `readFileSync('utf-8')` today — Phase 2 will swap in
 *  proper extractors. Keeping the list narrow avoids embedding e.g. images. */
const SUPPORTED_EXTENSIONS = ['.txt', '.md', '.pdf', '.docx', '.csv', '.json', '.ts', '.js', '.py'];
/** Characters per chunk. 512 keeps each vector roughly within a single
 *  semantic idea while staying well under nomic-embed-text's 2k token limit. */
const CHUNK_SIZE = 512;
/** Overlap between consecutive chunks so a fact straddling a boundary still
 *  appears intact in at least one chunk. */
const CHUNK_OVERLAP = 64;
const OLLAMA_EMBED_URL = 'http://localhost:11434/api/embeddings';
const EMBED_MODEL = 'nomic-embed-text';

/** One indexed unit: a slice of a source file plus its embedding. The `id`
 *  is a deterministic md5 of `${filePath}:${offset}` so re-indexing the same
 *  file produces stable IDs (useful for incremental updates in Phase 2). */
interface Chunk {
  id: string;
  filePath: string;
  text: string;
  embedding: number[];
}

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
    const files = this.collectFiles(dirPath);
    const chunks: Chunk[] = [];

    for (const file of files) {
      try {
        const text = fs.readFileSync(file, 'utf-8');
        const fileChunks = this.chunkText(text, file);
        for (const chunk of fileChunks) {
          const embedding = await this.embed(chunk.text);
          chunks.push({ ...chunk, embedding });
        }
      } catch {
        // Skip unreadable files silently
      }
    }

    const indexPath = path.join(this.indexDir, `${indexId}.json`);
    fs.writeFileSync(indexPath, JSON.stringify(chunks));

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

    const chunks: Chunk[] = JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
    const queryEmbedding = await this.embed(query);

    const scored = chunks.map(chunk => ({
      text: chunk.text,
      score: cosineSimilarity(queryEmbedding, chunk.embedding),
    }));

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, topK).map(s => s.text);
  }

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

  private chunkText(text: string, filePath: string): Omit<Chunk, 'embedding'>[] {
    const chunks: Omit<Chunk, 'embedding'>[] = [];
    for (let i = 0; i < text.length; i += CHUNK_SIZE - CHUNK_OVERLAP) {
      const slice = text.slice(i, i + CHUNK_SIZE);
      if (slice.trim().length < 20) continue;
      chunks.push({
        id: crypto.createHash('md5').update(`${filePath}:${i}`).digest('hex'),
        filePath,
        text: slice,
      });
    }
    return chunks;
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
