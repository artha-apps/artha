/**
 * Global search — one query across the user's local data (chats, memory,
 * artifacts). Fixes the "no way to find past work by content" gap: the only
 * search before this was per-panel filters.
 *
 * Strategy is hybrid so it's both fast and good:
 *   1. SQLite keyword retrieval gathers a bounded candidate set (always fast,
 *      works even when Ollama is down).
 *   2. When `semantic` is requested AND the local embeddings model answers, the
 *      candidates are re-ranked by cosine similarity to the query — so a search
 *      for "quarterly numbers" surfaces a chat about "Q3 revenue". On any embed
 *      failure it falls back to keyword + recency, never throwing.
 *
 * Typeahead callers use the fast keyword path (semantic off); an explicit
 * "search" action can opt into the slower semantic re-rank.
 */
import { getDb } from '../db/schema';
import { isValidVector, EMBED_DIM } from '../rag/vectorIntegrity';

const OLLAMA_EMBED_URL = 'http://localhost:11434/api/embeddings';
const EMBED_MODEL = 'nomic-embed-text';

export type SearchType = 'chat' | 'memory' | 'artifact';

export interface SearchResult {
  type: SearchType;
  /** sessionId | entityId | artifactId. */
  id: string;
  title: string;
  snippet: string;
  ts: number;
  /** Present for artifacts — lets the renderer open the file directly. */
  filePath?: string;
}

/** Embed via local Ollama; null on any failure so callers degrade to keyword. */
async function embed(text: string): Promise<number[] | null> {
  try {
    const res = await fetch(OLLAMA_EMBED_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: EMBED_MODEL, prompt: text.slice(0, 2000) }),
    });
    const json = (await res.json()) as { embedding?: number[] };
    // Validate before use: the invariant forbids COMPARING a knowingly
    // invalid vector, not just storing one.
    return isValidVector(json.embedding, EMBED_DIM) ? json.embedding : null;
  } catch {
    return null;
  }
}

function cosine(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] ** 2; nb += b[i] ** 2; }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

/** A short window of `text` centred on the first match of `q`. */
function snippetAround(text: string, q: string, len = 140): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  const i = flat.toLowerCase().indexOf(q.toLowerCase());
  if (i < 0) return flat.slice(0, len);
  const start = Math.max(0, i - 36);
  const slice = flat.slice(start, start + len);
  return `${start > 0 ? '…' : ''}${slice}${start + len < flat.length ? '…' : ''}`;
}

/** Escape LIKE wildcards in user input (we use ESCAPE '\\'). */
function likeArg(q: string): string {
  return `%${q.replace(/[\\%_]/g, (m) => '\\' + m)}%`;
}

function gatherCandidates(q: string, perType: number): SearchResult[] {
  const db = getDb();
  const like = likeArg(q);
  const out: SearchResult[] = [];

  // Chats — newest matching message per session, deduped to one row per chat.
  const msgRows = db.prepare(
    `SELECT m.session_id AS id, m.content AS content, m.timestamp AS ts,
            COALESCE(s.title, 'Untitled chat') AS title
       FROM messages m JOIN chat_sessions s ON s.session_id = m.session_id
      WHERE m.content LIKE ? ESCAPE '\\'
      ORDER BY m.timestamp DESC LIMIT ?`,
  ).all(like, perType * 4) as { id: string; content: string; ts: number; title: string }[];
  const seen = new Set<string>();
  for (const r of msgRows) {
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    out.push({ type: 'chat', id: r.id, title: r.title, snippet: snippetAround(r.content, q), ts: r.ts });
    if (seen.size >= perType) break;
  }

  // Memory entities.
  const memRows = db.prepare(
    `SELECT entity_id AS id, name, content, updated_at AS ts
       FROM memory_entities
      WHERE name LIKE ? ESCAPE '\\' OR content LIKE ? ESCAPE '\\'
      ORDER BY updated_at DESC LIMIT ?`,
  ).all(like, like, perType) as { id: string; name: string; content: string; ts: number }[];
  for (const r of memRows) out.push({ type: 'memory', id: r.id, title: r.name, snippet: snippetAround(r.content, q), ts: r.ts });

  // Generated artifacts (by name).
  const artRows = db.prepare(
    `SELECT artifact_id AS id, name, file_path, created_at AS ts
       FROM artifacts WHERE name LIKE ? ESCAPE '\\'
      ORDER BY created_at DESC LIMIT ?`,
  ).all(like, perType) as { id: string; name: string; file_path: string; ts: number }[];
  for (const r of artRows) out.push({ type: 'artifact', id: r.id, title: r.name, snippet: r.file_path, ts: r.ts, filePath: r.file_path });

  return out;
}

export async function globalSearch(
  query: string,
  opts: { limit?: number; semantic?: boolean } = {},
): Promise<SearchResult[]> {
  const q = query.trim();
  if (q.length < 2) return [];
  const limit = opts.limit ?? 12;
  const candidates = gatherCandidates(q, 8);
  if (candidates.length === 0) return [];

  if (opts.semantic) {
    const qVec = await embed(q);
    if (qVec) {
      const scored = await Promise.all(candidates.map(async (c) => {
        const vec = await embed(`${c.title}\n${c.snippet}`);
        return { c, score: vec ? cosine(qVec, vec) : 0 };
      }));
      scored.sort((a, b) => b.score - a.score);
      return scored.slice(0, limit).map((s) => s.c);
    }
  }

  // Fast default: keyword match, newest first.
  return candidates.sort((a, b) => b.ts - a.ts).slice(0, limit);
}
