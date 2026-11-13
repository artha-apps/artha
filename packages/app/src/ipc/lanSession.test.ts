/**
 * LAN session ownership (bug-hunt R2 #6): a LAN caller continues only a
 * session it created; the host's chats, another teammate's sessions and
 * unknown ids get the same 404, so none can be entered or probed.
 */
import { describe, it, expect } from 'vitest';
import { resolveLanSession, type LanSessionDb } from './lanSession';

/** In-memory chat_sessions with just the columns this reads/writes. */
function fakeDb(rows: Record<string, { lan_owner: string | null }>) {
  const db: LanSessionDb = {
    prepare: (sql: string) => ({
      get: (id: unknown) => rows[String(id)],
      run: (id: unknown, _title: unknown, owner: unknown) => {
        if (sql.startsWith('INSERT')) rows[String(id)] = { lan_owner: String(owner) };
        return { changes: 1 };
      },
    }),
  };
  return { db, rows };
}

describe('resolveLanSession', () => {
  it('creates a new session owned by the caller when no id is given', () => {
    const { db, rows } = fakeDb({});
    const r = resolveLanSession(db, undefined, 'member:alice', 'hello');
    expect(r).toMatchObject({ ok: true, created: true });
    if (r.ok) expect(rows[r.sessionId].lan_owner).toBe('member:alice');
  });

  it('continues a session the same caller created', () => {
    const { db } = fakeDb({ s1: { lan_owner: 'member:alice' } });
    expect(resolveLanSession(db, 's1', 'member:alice', 'again')).toEqual({ ok: true, sessionId: 's1', created: false });
  });

  it("refuses the host's own chat, another teammate's session, and unknown ids alike", () => {
    const { db } = fakeDb({ host: { lan_owner: null }, bobs: { lan_owner: 'member:bob' } });
    const refused = { ok: false, status: 404, error: 'Unknown session id.' };
    expect(resolveLanSession(db, 'host', 'member:alice', 'x')).toEqual(refused);
    expect(resolveLanSession(db, 'bobs', 'member:alice', 'x')).toEqual(refused);
    expect(resolveLanSession(db, 'nope', 'member:alice', 'x')).toEqual(refused);
  });
});
