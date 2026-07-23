/**
 * Pure formatting helpers for the rag_search tool — no DB/Electron, so they're
 * unit-testable. Turn raw retrieval hits into the compact, source-labelled text
 * the agent reads back in the ReAct loop.
 */
import * as path from 'path';

/** A single retrieval hit as returned by `searchAllIndexes` in rag/indexer.ts. */
export interface RagHit {
  /** Absolute path to the source file that contains this chunk. */
  filePath: string;
  /** The raw chunk text from the vector index. */
  text: string;
  /** Cosine-similarity score in [0, 1]; higher is more relevant. */
  score: number;
}

/** Maximum characters shown per hit. Long chunks are truncated to keep the
 *  agent's context window from blowing up on large documents. */
const SNIPPET_CHARS = 320;

/** Render retrieval hits as a numbered, source-labelled list. Empty hits get an
 *  actionable message so the model doesn't fabricate file contents. */
export function formatRagResults(query: string, hits: RagHit[], semanticUnavailable = false): string {
  if (hits.length === 0) {
    // Never report "nothing matched" when the retriever could not run — that
    // reads as a content answer and invites the model to fill the gap.
    if (semanticUnavailable) {
      return `Semantic search is unavailable right now (local embeddings are not running), so your indexed files could NOT be searched for "${query}". This is not a statement about their contents. Tell the user to start Ollama (or install the embedding model) — or read specific files directly instead.`;
    }
    return `No matching passages found in your indexed files for "${query}". The user may need to add an index in the RAG panel.`;
  }
  const lines = hits.map((h, i) => {
    const name = path.basename(h.filePath);
    const snippet = h.text.replace(/\s+/g, ' ').trim().slice(0, SNIPPET_CHARS);
    return `${i + 1}. [${name}] (relevance ${h.score.toFixed(2)})\n${snippet}`;
  });
  return `Found ${hits.length} passage(s) for "${query}":\n\n${lines.join('\n\n')}`;
}

/** Render the list of configured indexes for rag_list_indexes. */
export function formatIndexList(indexes: { name: string; doc_count: number }[]): string {
  if (indexes.length === 0) {
    return 'No RAG indexes configured. The user can create one in the RAG panel to make their files searchable.';
  }
  return 'Available indexes:\n' + indexes.map(i => `- ${i.name} (${i.doc_count} chunks)`).join('\n');
}
