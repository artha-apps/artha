/**
 * Which chat session a LAN `/chat` request runs in.
 *
 * A LAN caller may continue only a session it created over the network
 * (`chat_sessions.lan_owner` = its owner key). The host's own chats, another
 * teammate's sessions, and unknown ids all get the same refusal, so a
 * teammate can't run inside (and read the history of) a chat that isn't
 * theirs, and can't probe which ids exist. With no id, a new session owned by
 * the caller is created.
 */
import * as crypto from 'crypto';

/** The slice of the DB this needs (better-sqlite3 / node:sqlite compatible). */
export interface LanSessionDb {
  prepare(sql: string): { get(...args: unknown[]): unknown; run(...args: unknown[]): unknown };
}

export type LanSessionResult = { ok: true; sessionId: string; created: boolean } | { ok: false; status: 404; error: string };

export function resolveLanSession(
  db: LanSessionDb,
  requestedId: string | undefined,
  ownerKey: string,
  message: string,
): LanSessionResult {
  if (requestedId) {
    const row = db.prepare(`SELECT lan_owner FROM chat_sessions WHERE session_id=?`).get(requestedId) as
      { lan_owner: string | null } | undefined;
    if (!row || !row.lan_owner || row.lan_owner !== ownerKey) {
      return { ok: false, status: 404, error: 'Unknown session id.' };
    }
    return { ok: true, sessionId: requestedId, created: false };
  }
  const sessionId = crypto.randomUUID();
  db.prepare(`INSERT INTO chat_sessions (session_id, title, lan_owner) VALUES (?, ?, ?)`)
    .run(sessionId, `LAN: ${message.slice(0, 40)}`, ownerKey);
  return { ok: true, sessionId, created: true };
}
