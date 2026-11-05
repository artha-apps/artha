/**
 * Subscription registry tests: resubscribe replaces (no double stream),
 * unsubscribe stops delivery, a throwing client is dropped without breaking
 * the appender, and a reload-style resubscribe from lastSeq gets exactly the
 * missed events once.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../db/schema', () => ({ getDb: () => { throw new Error('no db in tests'); } }));

import { appendRunEvent, setRunEventStore, type RunEvent, type RunEventStore } from './runEvents';
import { createRunSubscriptions, type RunEventMessage } from './runEventIpc';

/** Minimal in-memory store with PK semantics. */
function memStore(): RunEventStore {
  const rows: RunEvent[] = [];
  return {
    maxSeq: id => rows.filter(r => r.runId === id).reduce((m, r) => Math.max(m, r.seq), 0),
    insert: ev => {
      if (rows.some(r => r.runId === ev.runId && r.seq === ev.seq)) throw new Error('dup');
      rows.push(ev);
    },
    list: (id, after, limit) => rows.filter(r => r.runId === id && r.seq > after).sort((a, b) => a.seq - b.seq).slice(0, limit),
  };
}

beforeEach(() => setRunEventStore(memStore()));

describe('createRunSubscriptions', () => {
  it('reload: resubscribing from lastSeq yields the missed events exactly once', () => {
    const subs = createRunSubscriptions();
    const before: RunEventMessage[] = [];
    subs.subscribe(1, 'r', 0, m => before.push(m));
    appendRunEvent('r', 'status', 'a');
    appendRunEvent('r', 'step', {});
    expect(before.map(m => [m.event.seq, m.replayed])).toEqual([[1, false], [2, false]]);
    const lastSeq = before[before.length - 1].event.seq;

    // Renderer reloads: its subscriptions go away, events keep coming.
    subs.unsubscribeClient(1);
    appendRunEvent('r', 'tool_call', {});
    appendRunEvent('r', 'tool_result', {});

    const after: RunEventMessage[] = [];
    subs.subscribe(1, 'r', lastSeq, m => after.push(m));
    appendRunEvent('r', 'done', { outcome: 'succeeded' });
    expect(after.map(m => [m.event.seq, m.replayed])).toEqual([[3, true], [4, true], [5, false]]);
  });

  it('a repeat subscribe for the same client+run replaces the old stream', () => {
    const subs = createRunSubscriptions();
    const a: number[] = []; const b: number[] = [];
    subs.subscribe(1, 'r', 0, m => a.push(m.event.seq));
    subs.subscribe(1, 'r', 0, m => b.push(m.event.seq));
    appendRunEvent('r', 'status');
    expect(a).toEqual([]);
    expect(b).toEqual([1]);
    expect(subs.size()).toBe(1);
  });

  it('unsubscribe stops delivery and reports whether a sub existed', () => {
    const subs = createRunSubscriptions();
    const got: number[] = [];
    subs.subscribe('lan-1', 'r', 0, m => got.push(m.event.seq));
    expect(subs.unsubscribe('lan-1', 'r')).toBe(true);
    expect(subs.unsubscribe('lan-1', 'r')).toBe(false);
    appendRunEvent('r', 'status');
    expect(got).toEqual([]);
  });

  it('drops a client whose send throws, without breaking the appender', () => {
    const subs = createRunSubscriptions();
    subs.subscribe(1, 'r', 0, () => { throw new Error('webContents destroyed'); });
    expect(() => appendRunEvent('r', 'status')).not.toThrow();
    expect(subs.size()).toBe(0);
    // Failure during replay is handled too.
    appendRunEvent('r', 'status');
    subs.subscribe(2, 'r', 0, () => { throw new Error('gone'); });
    expect(subs.size()).toBe(0);
    expect(() => appendRunEvent('r', 'status')).not.toThrow();
  });
});
