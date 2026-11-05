/**
 * Run event log tests. The native SQLite module is built for Electron, so the
 * log runs against an in-memory RunEventStore that enforces the same
 * (run_id, seq) uniqueness as the real PRIMARY KEY. getDb is mocked with a spy
 * so we can prove the watchdog never touches the database's run status.
 *
 * Covered:
 *   - seq continuity: 1..N with no gaps or duplicates under concurrent appends
 *   - collision recovery when another writer took the next seq
 *   - replay-then-tail delivers every event exactly once, in order
 *   - heartbeat cadence, a single `stalled` after 60 s of silence, no stall
 *     while awaiting the user, and the watchdog never marks a run completed
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const { dbCalls } = vi.hoisted(() => ({ dbCalls: [] as string[] }));
vi.mock('../db/schema', () => ({
  getDb: () => {
    dbCalls.push('getDb');
    return { prepare: (sql: string) => { dbCalls.push(sql); return { run: () => ({}), get: () => undefined, all: () => [] }; } };
  },
}));

import {
  appendRunEvent, listRunEvents, subscribeRunEvents, setRunEventStore, startRunMonitor,
  runEventFromChannel, recordRunEvent, serializePayload, MAX_PAYLOAD_CHARS,
  type RunEvent, type RunEventStore,
} from './runEvents';

/** In-memory store mirroring run_events' PRIMARY KEY(run_id, seq). */
function memStore(): RunEventStore & { rows: RunEvent[] } {
  const rows: RunEvent[] = [];
  return {
    rows,
    maxSeq: id => rows.filter(r => r.runId === id).reduce((m, r) => Math.max(m, r.seq), 0),
    insert: ev => {
      if (rows.some(r => r.runId === ev.runId && r.seq === ev.seq)) throw new Error('UNIQUE constraint failed');
      rows.push({ ...ev });
    },
    list: (id, after, limit) => rows.filter(r => r.runId === id && r.seq > after).sort((a, b) => a.seq - b.seq).slice(0, limit),
  };
}

let store: ReturnType<typeof memStore>;
beforeEach(() => { store = memStore(); setRunEventStore(store); dbCalls.length = 0; });
afterEach(() => { vi.useRealTimers(); });

describe('seq continuity', () => {
  it('assigns 1..N with no gaps or duplicates under concurrent appends across runs', async () => {
    const runs = ['a', 'b', 'c'];
    // 3 runs × 200 async producers interleaving on the microtask queue.
    await Promise.all(runs.flatMap(r => Array.from({ length: 200 }, (_, i) =>
      Promise.resolve().then(async () => {
        await new Promise(res => setTimeout(res, i % 7));
        return appendRunEvent(r, 'step', { i });
      }))));
    for (const r of runs) {
      const seqs = listRunEvents(r, 0, 5000).map(e => e.seq);
      expect(seqs).toEqual(Array.from({ length: 200 }, (_, i) => i + 1));
    }
  });

  it('continues the sequence from the store (e.g. after a restart)', () => {
    store.rows.push({ runId: 'r', seq: 7, ts: 1, kind: 'status', payload: null });
    setRunEventStore(store); // clears the in-process counter cache
    expect(appendRunEvent('r', 'status', 'x')).toBe(8);
  });

  it('recovers from a seq collision by re-seeding from the store', () => {
    expect(appendRunEvent('r', 'status')).toBe(1);
    store.rows.push({ runId: 'r', seq: 2, ts: 1, kind: 'status', payload: null }); // foreign writer
    expect(appendRunEvent('r', 'status')).toBe(3);
    expect(store.rows.filter(e => e.runId === 'r').map(e => e.seq).sort()).toEqual([1, 2, 3]);
  });

  it('keeps counting after a terminal event drops the cache', () => {
    appendRunEvent('r', 'status');
    appendRunEvent('r', 'done', { outcome: 'succeeded' });
    expect(appendRunEvent('r', 'heartbeat')).toBe(3);
  });

  it('recordRunEvent never throws when storage fails', () => {
    setRunEventStore({ maxSeq: () => 0, insert: () => { throw new Error('disk full'); }, list: () => [] });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(recordRunEvent('r', 'status')).toBe(-1);
    warn.mockRestore();
  });
});

describe('listRunEvents', () => {
  it('is exclusive of fromSeq and honours limit', () => {
    for (let i = 0; i < 10; i++) appendRunEvent('r', 'step', { i });
    expect(listRunEvents('r', 3, 4).map(e => e.seq)).toEqual([4, 5, 6, 7]);
    expect(listRunEvents('other', 0, 10)).toEqual([]);
  });
});

describe('subscribeRunEvents — replay then tail', () => {
  it('delivers persisted then live events exactly once and in order', () => {
    for (let i = 0; i < 5; i++) appendRunEvent('r', 'step', { i });
    const got: number[] = [];
    const off = subscribeRunEvents('r', 2, ev => got.push(ev.seq));
    expect(got).toEqual([3, 4, 5]);
    appendRunEvent('r', 'tool_call', {});
    appendRunEvent('r', 'tool_result', {});
    appendRunEvent('other', 'step', {}); // different run — not delivered
    expect(got).toEqual([3, 4, 5, 6, 7]);
    off();
    appendRunEvent('r', 'done', {});
    expect(got).toEqual([3, 4, 5, 6, 7]);
  });

  it('does not double-deliver an event appended DURING replay', () => {
    for (let i = 0; i < 3; i++) appendRunEvent('r', 'step', { i });
    // A store whose list() triggers a live append mid-replay: that event is
    // both persisted (so a later page sees it) and buffered by the listener.
    const inner = store;
    let injected = false;
    setRunEventStore({
      maxSeq: inner.maxSeq,
      insert: inner.insert,
      list: (id, after, limit) => {
        const page = inner.list(id, after, limit);
        if (!injected) { injected = true; appendRunEvent('r', 'status', 'mid-replay'); }
        return page;
      },
    });
    const got: number[] = [];
    subscribeRunEvents('r', 0, ev => got.push(ev.seq));
    appendRunEvent('r', 'step', {});
    expect(got).toEqual([1, 2, 3, 4, 5]);
  });

  it('pages through long histories', () => {
    for (let i = 0; i < 1203; i++) appendRunEvent('r', 'step', { i });
    const got: number[] = [];
    subscribeRunEvents('r', 0, ev => got.push(ev.seq));
    expect(got.length).toBe(1203);
    expect(new Set(got).size).toBe(1203);
    expect(got[1202]).toBe(1203);
  });
});

describe('startRunMonitor — heartbeat + watchdog', () => {
  it('heartbeats every 10 s and emits a single stalled after 60 s of silence', () => {
    vi.useFakeTimers();
    const stop = startRunMonitor('r');
    vi.advanceTimersByTime(10_000);
    expect(store.rows.map(e => e.kind)).toEqual(['heartbeat']);
    vi.advanceTimersByTime(60_000);
    const kinds = store.rows.map(e => e.kind);
    expect(kinds.filter(k => k === 'heartbeat').length).toBe(7);
    expect(kinds.filter(k => k === 'stalled').length).toBe(1);
    vi.advanceTimersByTime(60_000); // still silent — no repeated stalled
    expect(store.rows.filter(e => e.kind === 'stalled').length).toBe(1);
    stop();
  });

  it('re-arms after activity and stays quiet while awaiting the user', () => {
    vi.useFakeTimers();
    const stop = startRunMonitor('r');
    vi.advanceTimersByTime(50_000);
    appendRunEvent('r', 'interaction', { phase: 'request' });
    vi.advanceTimersByTime(120_000);
    expect(store.rows.filter(e => e.kind === 'stalled').length).toBe(0);
    appendRunEvent('r', 'interaction', { phase: 'response', approved: true });
    vi.advanceTimersByTime(70_000);
    expect(store.rows.filter(e => e.kind === 'stalled').length).toBe(1);
    stop();
  });

  it('never marks the run completed', () => {
    vi.useFakeTimers();
    const stop = startRunMonitor('r');
    vi.advanceTimersByTime(10 * 60_000);
    stop();
    const kinds = new Set(store.rows.map(e => e.kind));
    expect([...kinds].sort()).toEqual(['heartbeat', 'stalled']);
    // No DB access at all — so in particular no `UPDATE agent_runs SET status`.
    expect(dbCalls).toEqual([]);
  });

  it('stops on a terminal event and on stop()', () => {
    vi.useFakeTimers();
    startRunMonitor('r');
    vi.advanceTimersByTime(10_000);
    appendRunEvent('r', 'done', { outcome: 'failed' });
    const n = store.rows.length;
    vi.advanceTimersByTime(120_000);
    expect(store.rows.length).toBe(n);

    const stop = startRunMonitor('s');
    stop(); stop(); // idempotent
    vi.advanceTimersByTime(120_000);
    expect(store.rows.filter(e => e.runId === 's')).toEqual([]);
  });
});

describe('runEventFromChannel', () => {
  it('maps lifecycle channels and ignores stream detail', () => {
    expect(runEventFromChannel('agent:status', 'Planning')).toEqual({ kind: 'status', payload: { text: 'Planning' } });
    expect(runEventFromChannel('agent:toolCall', { type: 'tool_invoke', name: 'fs_read_file', args: '{}' })?.kind).toBe('tool_call');
    const r = runEventFromChannel('agent:toolCall', { type: 'tool_result', name: 'x', status: 'error', result: 'y'.repeat(9000) });
    expect(r?.kind).toBe('tool_result');
    expect(String((r?.payload as { result: string }).result).length).toBeLessThan(4100);
    expect(runEventFromChannel('agent:token', 'hi')).toBeNull();
    expect(runEventFromChannel('agent:reasoning', {})).toBeNull();
  });

  it('bounds oversize payloads', () => {
    const s = serializePayload({ big: 'z'.repeat(MAX_PAYLOAD_CHARS * 2) });
    expect(JSON.parse(s).truncated).toBe(true);
    expect(s.length).toBeLessThan(MAX_PAYLOAD_CHARS + 100);
  });
});
