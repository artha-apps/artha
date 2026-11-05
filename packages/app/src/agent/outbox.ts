/**
 * Outbox — "type while Artha works".
 *
 * While a run is active in a chat session the composer's Send becomes Queue and
 * the message lands here instead of starting a competing run. When the run
 * reaches a terminal state the driver (outboxDriver.ts) drains the next `ready`
 * item as a new user turn; "steer now" injects one at the next ReAct
 * tool-call boundary instead.
 *
 * This module is the persistence layer only: plain functions over the `outbox`
 * table and the `chat_sessions.outbox_paused*` columns. Every function takes
 * an optional db handle (defaults to the app connection) so tests can run the
 * real SQL against an in-memory SQLite.
 *
 * Exactly-once: an item only leaves `ready` through a guarded
 * `UPDATE … WHERE id=? AND status='ready'` and the caller proceeds only when
 * that statement changed exactly one row. Two concurrent drains therefore can
 * never both claim the same item.
 */
import { getDb } from '../db/schema';

/** Lifecycle of one queued message (mirrors the table's CHECK constraint). */
export type OutboxStatus = 'ready' | 'sending' | 'editing' | 'sent' | 'cancelled';

/** An attachment carried with a queued message — same shape agent:sendMessage takes. */
export interface OutboxAttachment { name: string; mime: string; data: string }

/** One queued message as surfaced to the driver and the renderer. */
export interface OutboxItem {
  id: string;
  sessionId: string;
  position: number;
  status: OutboxStatus;
  content: string;
  attachments: OutboxAttachment[];
  createdAt: number;
  updatedAt: number;
}

/** Why a session's queue is paused: the user's Pause button, a user cancel
 *  (Stop / plan reject ⇒ "Queue paused after cancel"), or the global stop
 *  shortcut (kill switch ⇒ "Queue paused after stop"). */
export type OutboxPauseReason = 'user' | 'cancel' | 'stop';
/** Per-session pause state. */
export interface OutboxPauseState { paused: boolean; reason: OutboxPauseReason | null }

/** Minimal statement/connection surface we rely on. Satisfied structurally by
 *  better-sqlite3 (runtime) and node:sqlite's DatabaseSync (tests). */
export interface OutboxDb {
  prepare(sql: string): {
    run(...args: unknown[]): { changes: number | bigint };
    get(...args: unknown[]): unknown;
    all(...args: unknown[]): unknown[];
  };
  exec(sql: string): void;
}

interface OutboxRow {
  id: string; session_id: string; position: number; status: OutboxStatus;
  content: string; attachments_json: string | null; created_at: number; updated_at: number;
}

/** Resolve the connection: an explicit handle (tests) or the app's WAL connection. */
function conn(db?: OutboxDb): OutboxDb {
  return db ?? (getDb() as unknown as OutboxDb);
}

/** Row → API shape. Malformed attachments_json degrades to no attachments. */
function toItem(r: OutboxRow): OutboxItem {
  let attachments: OutboxAttachment[] = [];
  if (r.attachments_json) {
    try {
      const parsed = JSON.parse(r.attachments_json);
      if (Array.isArray(parsed)) attachments = parsed as OutboxAttachment[];
    } catch { /* ignore corrupt JSON */ }
  }
  return {
    id: r.id, sessionId: r.session_id, position: r.position, status: r.status,
    content: r.content, attachments, createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

/** Fetch one item by id (any status), or null. */
export function getItem(id: string, db?: OutboxDb): OutboxItem | null {
  const row = conn(db).prepare(`SELECT * FROM outbox WHERE id=?`).get(id) as OutboxRow | undefined;
  return row ? toItem(row) : null;
}

/** Append a message to the end of the session's queue. Empty text with no
 *  attachments is rejected (nothing to send). Returns the new item. */
export function enqueue(
  sessionId: string,
  content: string,
  attachments?: OutboxAttachment[] | null,
  db?: OutboxDb,
): OutboxItem {
  const d = conn(db);
  const text = (content ?? '').trim();
  if (!text && !(attachments && attachments.length)) throw new Error('Cannot queue an empty message.');
  const max = d.prepare(
    `SELECT COALESCE(MAX(position), -1) AS m FROM outbox WHERE session_id=?`
  ).get(sessionId) as { m: number };
  const id = cryptoId();
  d.prepare(`
    INSERT INTO outbox (id, session_id, position, status, content, attachments_json)
    VALUES (?, ?, ?, 'ready', ?, ?)
  `).run(id, sessionId, Number(max.m) + 1, text, attachments && attachments.length ? JSON.stringify(attachments) : null);
  return getItem(id, d)!;
}

/** The session's pending queue (ready / sending / editing), in send order.
 *  Sent and cancelled items are history and are not returned. */
export function list(sessionId: string, db?: OutboxDb): OutboxItem[] {
  const rows = conn(db).prepare(`
    SELECT * FROM outbox
     WHERE session_id=? AND status IN ('ready','sending','editing')
     ORDER BY position ASC, created_at ASC
  `).all(sessionId) as OutboxRow[];
  return rows.map(toItem);
}

/** Reorder the pending queue. `orderedIds` lists item ids in the desired send
 *  order; ids not in the session's pending queue are ignored, and pending
 *  items the caller omitted keep their relative order after the listed ones
 *  (so a stale renderer list can never drop an item). Runs in one transaction. */
export function reorder(sessionId: string, orderedIds: string[], db?: OutboxDb): OutboxItem[] {
  const d = conn(db);
  const pending = list(sessionId, d);
  const pendingIds = new Set(pending.map(i => i.id));
  const seen = new Set<string>();
  const head = orderedIds.filter(id => pendingIds.has(id) && !seen.has(id) && (seen.add(id), true));
  const tail = pending.map(i => i.id).filter(id => !seen.has(id));
  const finalOrder = [...head, ...tail];
  d.exec('BEGIN');
  try {
    const upd = d.prepare(`UPDATE outbox SET position=?, updated_at=unixepoch() WHERE id=? AND session_id=?`);
    finalOrder.forEach((id, idx) => upd.run(idx, id, sessionId));
    d.exec('COMMIT');
  } catch (err) {
    d.exec('ROLLBACK');
    throw err;
  }
  return list(sessionId, d);
}

/** Move one item to the front of the queue (used by "steer now" so that the
 *  fallback drain sends it first if no tool-call boundary is reached). */
export function moveToFront(id: string, db?: OutboxDb): void {
  const d = conn(db);
  const item = getItem(id, d);
  if (!item) return;
  const ids = list(item.sessionId, d).map(i => i.id).filter(x => x !== id);
  reorder(item.sessionId, [id, ...ids], d);
}

/** Edit an item. `{ editing: true }` holds it (status `editing`) so a drain
 *  can't send a half-edited message; `{ content }` saves new text and returns
 *  it to `ready`; `{ editing: false }` alone abandons the edit. Only items
 *  that have not left the queue (ready/editing) can be edited. Returns the
 *  updated item, or null when it is no longer editable. */
export function edit(
  id: string,
  patch: { content?: string; editing?: boolean },
  db?: OutboxDb,
): OutboxItem | null {
  const d = conn(db);
  let changed: number | bigint = 0;
  if (typeof patch.content === 'string') {
    const text = patch.content.trim();
    if (!text) throw new Error('Cannot save an empty queued message — delete it instead.');
    changed = d.prepare(`
      UPDATE outbox SET content=?, status='ready', updated_at=unixepoch()
       WHERE id=? AND status IN ('ready','editing')
    `).run(text, id).changes;
  } else if (patch.editing === true) {
    changed = d.prepare(`
      UPDATE outbox SET status='editing', updated_at=unixepoch() WHERE id=? AND status='ready'
    `).run(id).changes;
  } else if (patch.editing === false) {
    changed = d.prepare(`
      UPDATE outbox SET status='ready', updated_at=unixepoch() WHERE id=? AND status='editing'
    `).run(id).changes;
  }
  return Number(changed) === 1 ? getItem(id, d) : null;
}

/** Delete (cancel) a queued item. Only possible before it is claimed for
 *  sending. Returns true when the item was cancelled. */
export function cancel(id: string, db?: OutboxDb): boolean {
  const r = conn(db).prepare(`
    UPDATE outbox SET status='cancelled', updated_at=unixepoch()
     WHERE id=? AND status IN ('ready','editing')
  `).run(id);
  return Number(r.changes) === 1;
}

/** Pause the session's queue. reason='cancel' is set automatically when the
 *  user stops a run, so the UI can say "Queue paused after cancel". */
export function pause(sessionId: string, reason: OutboxPauseReason = 'user', db?: OutboxDb): void {
  conn(db).prepare(
    `UPDATE chat_sessions SET outbox_paused=1, outbox_paused_reason=? WHERE session_id=?`
  ).run(reason, sessionId);
}

/** Resume the session's queue (the driver then attempts a drain). */
export function resume(sessionId: string, db?: OutboxDb): void {
  conn(db).prepare(
    `UPDATE chat_sessions SET outbox_paused=0, outbox_paused_reason=NULL WHERE session_id=?`
  ).run(sessionId);
}

/** Read the session's pause state. Unknown sessions read as not paused. */
export function getPauseState(sessionId: string, db?: OutboxDb): OutboxPauseState {
  const row = conn(db).prepare(
    `SELECT outbox_paused AS p, outbox_paused_reason AS r FROM chat_sessions WHERE session_id=?`
  ).get(sessionId) as { p: number; r: string | null } | undefined;
  const paused = !!row && Number(row.p) === 1;
  const reason: OutboxPauseReason | null = paused ? (row?.r === 'cancel' ? 'cancel' : row?.r === 'stop' ? 'stop' : 'user') : null;
  return { paused, reason };
}

/** Atomically claim one specific `ready` item (ready → sending). Returns the
 *  claimed item, or null when someone else already claimed/edited/cancelled
 *  it. This guarded flip is THE exactly-once primitive. */
export function claim(id: string, db?: OutboxDb): OutboxItem | null {
  const d = conn(db);
  const r = d.prepare(`
    UPDATE outbox SET status='sending', updated_at=unixepoch() WHERE id=? AND status='ready'
  `).run(id);
  return Number(r.changes) === 1 ? getItem(id, d) : null;
}

/** Claim the next `ready` item of the session (lowest position), unless the
 *  queue is paused. Retries past items lost to a concurrent claimer, so a
 *  racing caller either gets a distinct item or null — never a duplicate. */
export function drainNext(sessionId: string, db?: OutboxDb): OutboxItem | null {
  const d = conn(db);
  if (getPauseState(sessionId, d).paused) return null;
  for (let attempt = 0; attempt < 50; attempt++) {
    const next = d.prepare(`
      SELECT id FROM outbox WHERE session_id=? AND status='ready'
       ORDER BY position ASC, created_at ASC LIMIT 1
    `).get(sessionId) as { id: string } | undefined;
    if (!next) return null;
    const claimed = claim(next.id, d);
    if (claimed) return claimed;
  }
  return null;
}

/** Mark a claimed item delivered (sending → sent). Called right after the
 *  item has been persisted as a user message. */
export function markSent(id: string, db?: OutboxDb): boolean {
  const r = conn(db).prepare(`
    UPDATE outbox SET status='sent', updated_at=unixepoch() WHERE id=? AND status='sending'
  `).run(id);
  return Number(r.changes) === 1;
}

/** Return a claimed item to the queue (sending → ready) when the hand-off
 *  failed before the user message was persisted, so it is not lost. */
export function release(id: string, db?: OutboxDb): boolean {
  const r = conn(db).prepare(`
    UPDATE outbox SET status='ready', updated_at=unixepoch() WHERE id=? AND status='sending'
  `).run(id);
  return Number(r.changes) === 1;
}

/** 16-hex-char id, matching the table's randomblob(8) default format. */
function cryptoId(): string {
  // globalThis.crypto exists in Electron's main process and Node ≥ 19.
  const bytes = new Uint8Array(8);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}
