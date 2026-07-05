/**
 * @-mention context references — resolve `@chat:"<title>"` and
 * `@memory:"<name>"` tokens in a user message into an injectable prompt block.
 *
 * The composer inserts compact tokens (so the persisted user message stays
 * short and human-readable); resolution to actual content happens HERE, at
 * send time in the main process. Both orchestrator prompt paths (executePlan
 * and handleConversational) prepend the returned block to the system prompt.
 *
 * Lookup is by name with LIKE fallback, most-recently-active wins — mirroring
 * how memory_recall matches (tools/memory.ts). Unresolved tokens inject an
 * explicit NOTE line so the model says "I couldn't find that" instead of
 * hallucinating the referenced content.
 */
import { getDb } from '../db/schema';

/** `@chat:"quoted title"` or `@chat:bareword` (same for memory). Quoted allows
 *  spaces up to 120 chars; bare is a single 64-char word. */
const MENTION_RE = /@(chat|memory):(?:"([^"]{1,120})"|([A-Za-z0-9_-]{1,64}))/g;

/** Hard caps so a mention can never blow up the prompt: max refs per message,
 *  per-message truncation, and a total block budget. */
const MAX_REFS = 3;
const MAX_CHAT_MESSAGES = 12;
const MAX_MSG_CHARS = 280;
const MAX_BLOCK_CHARS = 2500;

interface ParsedMention {
  kind: 'chat' | 'memory';
  query: string;
}

/** Extract up to MAX_REFS mentions from a message. Exported for tests. */
export function parseMentions(content: string): ParsedMention[] {
  const out: ParsedMention[] = [];
  for (const m of content.matchAll(MENTION_RE)) {
    out.push({ kind: m[1] as 'chat' | 'memory', query: (m[2] ?? m[3] ?? '').trim() });
    if (out.length >= MAX_REFS) break;
  }
  return out;
}

/** Truncate one line to the per-message budget, marking the cut. */
function clip(s: string, max: number): string {
  const oneLine = s.replace(/\s+/g, ' ').trim();
  return oneLine.length <= max ? oneLine : `${oneLine.slice(0, max)}…`;
}

/** Condensed transcript of the referenced chat: the LAST N messages in
 *  chronological order (DESC + reverse — plain ASC LIMIT would return the
 *  chat's start, not its tail). */
function expandChat(query: string, currentSessionId: string): string | null {
  const db = getDb();
  const session = db.prepare(
    `SELECT session_id, title FROM chat_sessions
     WHERE session_id != ? AND COALESCE(origin,'chat')='chat'
       AND title LIKE ? ORDER BY (title = ?) DESC, last_activity DESC LIMIT 1`
  ).get(currentSessionId, `%${query}%`, query) as { session_id: string; title: string } | undefined;
  if (!session) return null;

  const rows = db.prepare(
    `SELECT sender_type, content FROM messages
     WHERE session_id=? ORDER BY timestamp DESC LIMIT ${MAX_CHAT_MESSAGES}`
  ).all(session.session_id) as { sender_type: string; content: string }[];
  if (rows.length === 0) return `[Chat "${session.title}"] (no messages)`;

  const lines = rows.reverse().map(r =>
    `${r.sender_type === 'user' ? 'user' : 'assistant'}: ${clip(r.content, MAX_MSG_CHARS)}`
  );
  let block = `[Chat "${session.title}"] condensed transcript, most recent last:\n${lines.join('\n')}`;
  if (block.length > MAX_BLOCK_CHARS) block = `${block.slice(0, MAX_BLOCK_CHARS)}…`;
  return block;
}

/** The referenced memory's content — exact name first, LIKE fallback, scoped
 *  global ∪ current project exactly like memory_recall injection. */
function expandMemory(query: string, projectId: string | null): string | null {
  const db = getDb();
  const row = db.prepare(
    `SELECT name, content FROM memory_entities
     WHERE name LIKE ? AND (project_id IS NULL OR project_id = ?)
     ORDER BY (name = ?) DESC, updated_at DESC LIMIT 1`
  ).get(`%${query}%`, projectId, query) as { name: string; content: string } | undefined;
  if (!row) return null;
  return `[Memory "${row.name}"] ${clip(row.content, MAX_BLOCK_CHARS)}`;
}

/**
 * Resolve every @chat/@memory mention in `content` into one prompt block.
 * Returns '' when the message has no mentions (the common case — callers can
 * interpolate unconditionally). Never throws: a lookup failure downgrades to
 * the unresolved NOTE so a bad reference can't break a run.
 */
export function resolveMentionBlock(content: string, sessionId: string): string {
  const mentions = parseMentions(content);
  if (mentions.length === 0) return '';

  let projectId: string | null = null;
  try {
    const s = getDb().prepare(
      `SELECT project_id FROM chat_sessions WHERE session_id=?`
    ).get(sessionId) as { project_id: string | null } | undefined;
    projectId = s?.project_id ?? null;
  } catch { /* unscoped lookup */ }

  const parts: string[] = [];
  for (const m of mentions) {
    let expanded: string | null = null;
    try {
      expanded = m.kind === 'chat'
        ? expandChat(m.query, sessionId)
        : expandMemory(m.query, projectId);
    } catch { /* fall through to the NOTE */ }
    parts.push(
      expanded ??
      `NOTE: the reference @${m.kind}:"${m.query}" did not match any ${m.kind === 'chat' ? 'chat' : 'memory'} — tell the user instead of guessing its content.`
    );
  }

  return `REFERENCED CONTEXT (resolved from @-mentions in the user's message):\n${parts.join('\n\n')}\n\n`;
}
