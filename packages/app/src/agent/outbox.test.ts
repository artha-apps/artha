/**
 * Outbox persistence tests — real SQL against in-memory SQLite (see
 * outboxTestDb.ts). Covers enqueue/list ordering, reorder (including stale
 * lists), edit holds, cancel, pause/resume, and the atomic ready→sending
 * claim that makes a double drain impossible.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// outbox.ts imports getDb from the Electron-bound schema module; every call
// here passes an explicit db, so the default handle is never used.
vi.mock('../db/schema', () => ({ getDb: () => { throw new Error('use explicit test db'); } }));

import * as ob from './outbox';
import { makeOutboxTestDb } from './outboxTestDb';
import type { OutboxDb } from './outbox';

let db: OutboxDb;
beforeEach(() => { db = makeOutboxTestDb(['s1', 's2']); });

describe('outbox persistence', () => {
  it('enqueues in order and lists pending items only', () => {
    const a = ob.enqueue('s1', 'first', null, db);
    const b = ob.enqueue('s1', '  second  ', [{ name: 'x.png', mime: 'image/png', data: 'AA' }], db);
    ob.enqueue('s2', 'other session', null, db);
    const items = ob.list('s1', db);
    expect(items.map(i => i.content)).toEqual(['first', 'second']);
    expect(items[1].attachments).toEqual([{ name: 'x.png', mime: 'image/png', data: 'AA' }]);
    expect(a.position).toBeLessThan(b.position);
    expect(items.every(i => i.status === 'ready')).toBe(true);
  });

  it('rejects an empty message', () => {
    expect(() => ob.enqueue('s1', '   ', null, db)).toThrow(/empty/);
  });

  it('reorder is respected and never drops items omitted by a stale list', () => {
    const a = ob.enqueue('s1', 'a', null, db);
    const b = ob.enqueue('s1', 'b', null, db);
    const c = ob.enqueue('s1', 'c', null, db);
    ob.reorder('s1', [c.id, a.id, b.id], db);
    expect(ob.list('s1', db).map(i => i.content)).toEqual(['c', 'a', 'b']);
    // Stale list missing `b` plus an unknown id: b is kept, at the end.
    ob.reorder('s1', ['nope', a.id, c.id], db);
    expect(ob.list('s1', db).map(i => i.content)).toEqual(['a', 'c', 'b']);
    // drainNext follows the new order.
    expect(ob.drainNext('s1', db)?.content).toBe('a');
  });

  it('editing holds an item out of the drain until saved', () => {
    const a = ob.enqueue('s1', 'draft', null, db);
    const b = ob.enqueue('s1', 'next', null, db);
    expect(ob.edit(a.id, { editing: true }, db)?.status).toBe('editing');
    expect(ob.drainNext('s1', db)?.id).toBe(b.id);
    expect(ob.edit(a.id, { content: 'final text' }, db)).toMatchObject({ status: 'ready', content: 'final text' });
    expect(ob.drainNext('s1', db)).toMatchObject({ id: a.id, content: 'final text', status: 'sending' });
    // A claimed item can no longer be edited or cancelled.
    expect(ob.edit(a.id, { content: 'late' }, db)).toBeNull();
    expect(ob.cancel(a.id, db)).toBe(false);
  });

  it('cancel removes an item from the queue', () => {
    const a = ob.enqueue('s1', 'a', null, db);
    expect(ob.cancel(a.id, db)).toBe(true);
    expect(ob.list('s1', db)).toEqual([]);
    expect(ob.drainNext('s1', db)).toBeNull();
  });

  it('pause holds the drain; resume releases it', () => {
    ob.enqueue('s1', 'a', null, db);
    ob.pause('s1', 'user', db);
    expect(ob.getPauseState('s1', db)).toEqual({ paused: true, reason: 'user' });
    expect(ob.drainNext('s1', db)).toBeNull();
    ob.resume('s1', db);
    expect(ob.getPauseState('s1', db)).toEqual({ paused: false, reason: null });
    expect(ob.drainNext('s1', db)?.content).toBe('a');
  });

  it('double claim is impossible: the guarded flip succeeds exactly once', () => {
    const a = ob.enqueue('s1', 'a', null, db);
    expect(ob.claim(a.id, db)?.status).toBe('sending');
    expect(ob.claim(a.id, db)).toBeNull();
    // Two drains racing over one item: only one gets it.
    const b = ob.enqueue('s1', 'b', null, db);
    const first = ob.drainNext('s1', db);
    const second = ob.drainNext('s1', db);
    expect(first?.id).toBe(b.id);
    expect(second).toBeNull();
  });

  it('drainNext skips an item stolen between its SELECT and UPDATE', () => {
    const a = ob.enqueue('s1', 'a', null, db);
    const b = ob.enqueue('s1', 'b', null, db);
    // Simulate a concurrent claimer winning `a` right after our SELECT.
    const realPrepare = db.prepare.bind(db);
    let stolen = false;
    const racing: OutboxDb = {
      exec: (sql) => db.exec(sql),
      prepare: (sql) => {
        const st = realPrepare(sql);
        if (!stolen && sql.includes(`SELECT id FROM outbox`)) {
          return { ...st, run: st.run.bind(st), all: st.all.bind(st), get: (...args: unknown[]) => {
            const r = st.get(...args);
            stolen = true;
            ob.claim(a.id, db);
            return r;
          } };
        }
        return st;
      },
    };
    expect(ob.drainNext('s1', racing)?.id).toBe(b.id);
    expect(ob.getItem(a.id, db)?.status).toBe('sending');
  });

  it('markSent and release only move a sending item', () => {
    const a = ob.enqueue('s1', 'a', null, db);
    expect(ob.markSent(a.id, db)).toBe(false); // still ready
    ob.claim(a.id, db);
    expect(ob.release(a.id, db)).toBe(true);
    expect(ob.getItem(a.id, db)?.status).toBe('ready');
    ob.claim(a.id, db);
    expect(ob.markSent(a.id, db)).toBe(true);
    expect(ob.markSent(a.id, db)).toBe(false);
    expect(ob.list('s1', db)).toEqual([]);
  });
});
