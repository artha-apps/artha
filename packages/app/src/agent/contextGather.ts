/**
 * Context Gather — assembles a structured <context> block before the agent's
 * <think> phase so the model starts each run already aware of the most relevant
 * things it knows.
 *
 * Everything here is LOCAL: memory + conversation history come from SQLite, and
 * semantic ranking uses the same on-device Ollama embedding endpoint the RAG
 * pipeline already uses (localhost only). No cloud / no new external network.
 *
 * The block injected has three parts:
 *   1. Relevant memories  — top-N memory_entities by semantic similarity to the
 *      goal (falls back to keyword + recency when embeddings are unavailable).
 *   2. Conversation recap — a short summary of the last few turns.
 *   3. Active scopes      — the folders/files this chat is bound to.
 *
 * `gatherContext()` also returns a `contextScore` (mean similarity of the
 * memories it surfaced, 0-1) so the orchestrator can record, per reasoning
 * step, how strong the contextual grounding was.
 */
import { getDb } from '../db/schema';
import { getRunContext } from './runContext';
import { getSessionScopes } from '../db/scopes';
import { isValidVector, EMBED_DIM } from '../rag/vectorIntegrity';

const OLLAMA_EMBED_URL = 'http://localhost:11434/api/embeddings';
const EMBED_MODEL = 'nomic-embed-text';

/** Result of a context-gather pass: the rendered <context> block for the
 *  system prompt, plus a 0-1 score of how relevant the surfaced memory was. */
export interface GatheredContext {
  /** Ready-to-inject <context>…</context> block, or '' when nothing relevant. */
  block: string;
  /** Mean semantic similarity of the surfaced memories (0 when none / keyword
   *  fallback). Recorded on each reasoning step as `context_score`. */
  contextScore: number;
  /** Count of memories surfaced — handy for logging/telemetry. */
  memoryCount: number;
}

interface MemoryRow {
  entity_id: string;
  name: string;
  entity_type: string;
  content: string;
  updated_at: number;
  /** Cached JSON vector from the v17→v18 column; null = not yet embedded. */
  embedding: string | null;
}

/** Embed `text` via the local Ollama embeddings endpoint. Returns null on any
 *  failure (Ollama down, model not pulled) so callers fall back gracefully.
 *  Exported so memory WRITE paths (memory_store, BYOM import) can compute the
 *  cached embedding once at write time instead of ranking re-embedding every
 *  candidate per message. */
export async function embedText(text: string): Promise<number[] | null> {
  try {
    const res = await fetch(OLLAMA_EMBED_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: EMBED_MODEL, prompt: text }),
    });
    const json = (await res.json()) as { embedding?: number[] };
    // Validate before caching: empty, all-zero, non-finite or wrong-dimension
    // payloads are treated as "unavailable" rather than persisted — Artha
    // never stores a knowingly invalid vector (see rag/vectorIntegrity.ts).
    return isValidVector(json.embedding, EMBED_DIM) ? json.embedding : null;
  } catch {
    return null;
  }
}

/** Canonical text a memory row is embedded as — write paths and ranking MUST
 *  agree on this or cached vectors won't match query semantics. */
export function memoryEmbeddingText(name: string, content: string): string {
  return `${name}: ${content}`;
}

/**
 * Embed-and-persist every memory row missing a cached vector (newest first,
 * bounded). Fire-and-forget from the synchronous write paths (memory_store,
 * BYOM import): `void backfillMemoryEmbeddings()` — a failed/slow embed never
 * blocks the write, and rankMemories' lazy backfill covers any stragglers.
 * Stops at the first embed failure (Ollama down) rather than hammering a dead
 * endpoint. Returns the number of rows embedded.
 */
export async function backfillMemoryEmbeddings(limit = 50): Promise<number> {
  try {
    const db = getDb();
    const rows = db.prepare(
      `SELECT entity_id, name, content FROM memory_entities
       WHERE embedding IS NULL ORDER BY updated_at DESC LIMIT ?`,
    ).all(limit) as { entity_id: string; name: string; content: string }[];
    let done = 0;
    for (const r of rows) {
      const vec = await embedText(memoryEmbeddingText(r.name, r.content));
      if (!vec) break; // embedder unavailable — retry on a future write/rank
      db.prepare(`UPDATE memory_entities SET embedding=? WHERE entity_id=?`)
        .run(JSON.stringify(vec), r.entity_id);
      done++;
    }
    return done;
  } catch {
    return 0;
  }
}

/** Cosine similarity; 0 for mismatched/empty vectors. */
function cosine(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] ** 2; nb += b[i] ** 2; }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

/** Candidate memories for a session's project bucket (global + project),
 *  newest first, capped.
 *
 *  Rows already covered by the LONG-TERM MEMORY recency preamble (the 20 most
 *  recent — see tools/memory.ts getMemoryContext) are EXCLUDED: both blocks
 *  land in the same system prompt, so semantically ranking them again just
 *  duplicated the same facts and wasted prompt tokens. The semantic block now
 *  only surfaces OLDER memories the preamble missed.
 *
 *  When the run originates from the LAN server, only memories explicitly marked
 *  `is_shared=1` are eligible — a remote teammate's agent turn must never see
 *  the host's private memories. The desktop (local) path has full visibility. */
function loadCandidateMemories(projectId: string | null, cap = 40): MemoryRow[] {
  const db = getDb();
  // LAN runs are restricted to shared memories; local runs see everything.
  const sharedOnly = getRunContext()?.lan === true ? 'AND is_shared=1' : '';
  const scope = projectId ? `(project_id IS NULL OR project_id = ?)` : `project_id IS NULL`;
  const params: unknown[] = projectId ? [projectId, cap] : [cap];
  // OFFSET 20 mirrors getMemoryContext's LIMIT 20 recency preamble (same scope,
  // same ordering) — everything before the offset is already in the prompt.
  const rows = db.prepare(
    `SELECT entity_id, name, entity_type, content, updated_at, embedding FROM memory_entities
     WHERE ${scope} ${sharedOnly}
     ORDER BY updated_at DESC LIMIT ? OFFSET 20`,
  ).all(...params) as MemoryRow[];
  return rows;
}

/** Parse a cached embedding column value; null on missing/corrupt/INVALID.
 *  Legacy rows holding an all-zero or malformed vector are rejected here, so
 *  they are excluded from similarity and re-embedded by the lazy backfill. */
function parseEmbedding(json: string | null): number[] | null {
  if (!json) return null;
  try {
    const v = JSON.parse(json) as unknown;
    return isValidVector(v, EMBED_DIM) ? v : null;
  } catch {
    return null;
  }
}

/** Top-N memories by semantic similarity to `goal`, scored against CACHED
 *  per-row embeddings — each turn embeds only the query (1 Ollama call), not
 *  every candidate. Rows without a cached vector (pre-migration writes) are
 *  embedded once here and persisted, so the backfill amortises to zero.
 *  Falls back to keyword overlap + recency when embeddings aren't available,
 *  so this never throws and always returns the best it can. */
async function rankMemories(
  goal: string,
  projectId: string | null,
  topN: number,
): Promise<{ row: MemoryRow; score: number }[]> {
  const candidates = loadCandidateMemories(projectId);
  if (!candidates.length) return [];

  const goalVec = await embedText(goal);
  if (goalVec) {
    const db = getDb();
    const scored: { row: MemoryRow; score: number }[] = [];
    for (const row of candidates) {
      let vec = parseEmbedding(row.embedding);
      if (!vec) {
        // Lazy backfill: embed once, persist, never re-embed this row again.
        vec = await embedText(memoryEmbeddingText(row.name, row.content));
        if (vec) {
          try {
            db.prepare(`UPDATE memory_entities SET embedding=? WHERE entity_id=?`)
              .run(JSON.stringify(vec), row.entity_id);
          } catch { /* cache miss next turn — harmless */ }
        }
      }
      scored.push({ row, score: vec ? cosine(goalVec, vec) : 0 });
    }
    return scored.sort((a, b) => b.score - a.score).slice(0, topN).filter(s => s.score > 0);
  }

  // Fallback: keyword overlap (then recency, already DESC) — score left at 0 so
  // contextScore reflects "no semantic signal".
  const terms = goal.toLowerCase().split(/\W+/).filter(t => t.length > 3);
  const keyword = candidates
    .map(row => {
      const hay = `${row.name} ${row.content}`.toLowerCase();
      const hits = terms.reduce((n, t) => n + (hay.includes(t) ? 1 : 0), 0);
      return { row, score: 0, hits };
    })
    .sort((a, b) => b.hits - a.hits)
    .filter(x => x.hits > 0)
    .slice(0, topN);
  return keyword.map(({ row, score }) => ({ row, score }));
}

/** The project a session belongs to (mirrors the orchestrator's helper). */
function sessionProjectId(sessionId: string): string | null {
  try {
    const r = getDb().prepare(`SELECT project_id FROM chat_sessions WHERE session_id=?`).get(sessionId) as { project_id: string | null } | undefined;
    return r?.project_id ?? null;
  } catch {
    return null;
  }
}

/** A compact recap of the last `turns` user/agent exchanges in this session.
 *  Each line is trimmed so the recap stays short; tool/system rows are skipped. */
function conversationRecap(sessionId: string, turns = 3): string {
  try {
    const db = getDb();
    // 2 rows per turn (user + agent); pull a few extra and trim.
    const rows = db.prepare(
      `SELECT sender_type, content FROM messages
       WHERE session_id=? AND sender_type IN ('user','agent')
       ORDER BY rowid DESC LIMIT ?`,
    ).all(sessionId, turns * 2) as { sender_type: string; content: string }[];
    if (!rows.length) return '';
    return rows
      .reverse()
      .map(r => `${r.sender_type === 'user' ? 'User' : 'Artha'}: ${r.content.replace(/\s+/g, ' ').slice(0, 220)}`)
      .join('\n');
  } catch {
    return '';
  }
}

/** Active folder/file scopes for the chat, as short lines. */
function activeScopes(sessionId: string): string {
  try {
    const scopes = getSessionScopes(sessionId);
    if (!scopes.length) return '';
    return scopes.map(s => `- ${s.kind}: ${s.path}`).join('\n');
  } catch {
    return '';
  }
}

/**
 * Build the structured <context> block for a run. Best-effort throughout: any
 * sub-part that fails contributes nothing rather than breaking the run. Returns
 * an empty block (and score 0) when there's genuinely nothing relevant to add.
 */
export async function gatherContext(
  sessionId: string,
  goal: string,
  opts: { topMemories?: number } = {},
): Promise<GatheredContext> {
  const topN = opts.topMemories ?? 5;
  const projectId = sessionProjectId(sessionId);

  const [ranked] = await Promise.all([rankMemories(goal, projectId, topN)]);
  const recap = conversationRecap(sessionId);
  const scopes = activeScopes(sessionId);

  const parts: string[] = [];

  if (ranked.length) {
    const lines = ranked
      .map(({ row, score }) => `- [${row.entity_type}] ${row.name}: ${row.content}${score > 0 ? ` (relevance ${score.toFixed(2)})` : ''}`)
      .join('\n');
    parts.push(`Relevant things you remember about this user/project:\n${lines}`);
  }
  if (recap) parts.push(`Recent conversation (most recent last):\n${recap}`);
  if (scopes) parts.push(`Folders/files this chat is scoped to:\n${scopes}`);

  if (!parts.length) return { block: '', contextScore: 0, memoryCount: 0 };

  const scored = ranked.filter(r => r.score > 0);
  const contextScore = scored.length
    ? scored.reduce((s, r) => s + r.score, 0) / scored.length
    : 0;

  const block =
    `<context>\n` +
    `The following local context was assembled for this task. Use it to ground ` +
    `your reasoning; do not repeat it back verbatim.\n\n` +
    parts.join('\n\n') +
    `\n</context>`;

  return { block, contextScore, memoryCount: ranked.length };
}
