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
}

/** Embed `text` via the local Ollama embeddings endpoint. Returns null on any
 *  failure (Ollama down, model not pulled) so callers fall back gracefully. */
async function embed(text: string): Promise<number[] | null> {
  try {
    const res = await fetch(OLLAMA_EMBED_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: EMBED_MODEL, prompt: text }),
    });
    const json = (await res.json()) as { embedding?: number[] };
    return Array.isArray(json.embedding) && json.embedding.length ? json.embedding : null;
  } catch {
    return null;
  }
}

/** Cosine similarity; 0 for mismatched/empty vectors. */
function cosine(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] ** 2; nb += b[i] ** 2; }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

/** Candidate memories for a session's project bucket (global + project), newest
 *  first, capped so embedding stays cheap.
 *
 *  When the run originates from the LAN server, only memories explicitly marked
 *  `is_shared=1` are eligible — a remote teammate's agent turn must never see
 *  the host's private memories. The desktop (local) path has full visibility. */
function loadCandidateMemories(projectId: string | null, cap = 40): MemoryRow[] {
  const db = getDb();
  // LAN runs are restricted to shared memories; local runs see everything.
  const sharedOnly = getRunContext()?.lan === true ? 'AND is_shared=1' : '';
  const rows = (projectId
    ? db.prepare(
        `SELECT entity_id, name, entity_type, content, updated_at FROM memory_entities
         WHERE (project_id IS NULL OR project_id = ?) ${sharedOnly} ORDER BY updated_at DESC LIMIT ?`,
      ).all(projectId, cap)
    : db.prepare(
        `SELECT entity_id, name, entity_type, content, updated_at FROM memory_entities
         WHERE project_id IS NULL ${sharedOnly} ORDER BY updated_at DESC LIMIT ?`,
      ).all(cap)) as MemoryRow[];
  return rows;
}

/** Top-N memories by semantic similarity to `goal`. Falls back to keyword
 *  overlap + recency when embeddings aren't available, so this never throws and
 *  always returns the best it can. Returns the rows plus their scores. */
async function rankMemories(
  goal: string,
  projectId: string | null,
  topN: number,
): Promise<{ row: MemoryRow; score: number }[]> {
  const candidates = loadCandidateMemories(projectId);
  if (!candidates.length) return [];

  const goalVec = await embed(goal);
  if (goalVec) {
    const scored: { row: MemoryRow; score: number }[] = [];
    for (const row of candidates) {
      const vec = await embed(`${row.name}: ${row.content}`);
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
