/**
 * Run resume cursor tests: lastSeq advances monotonically, duplicates and
 * foreign runs are ignored, only replayed events produce view actions, and a
 * terminal event clears the cursor without claiming success.
 */
import { describe, it, expect } from 'vitest';
import { applyRunEvent, loadRunCursor, saveRunCursor, RUN_CURSOR_KEY, type CursorStorage } from './runResume';

/** Map-backed storage double. */
function mem(): CursorStorage & { m: Map<string, string> } {
  const m = new Map<string, string>();
  return { m, getItem: k => m.get(k) ?? null, setItem: (k, v) => { m.set(k, v); }, removeItem: k => { m.delete(k); } };
}
const ev = (seq: number, kind: string, payload: unknown = {}, runId = 'r') => ({ runId, seq, kind, payload });

describe('runResume', () => {
  it('advances lastSeq and ignores duplicates and other runs', () => {
    const s = mem();
    saveRunCursor(s, { runId: 'r', lastSeq: 0 });
    applyRunEvent(s, ev(1, 'step'), false);
    applyRunEvent(s, ev(2, 'status', { text: 'hi' }), false);
    expect(applyRunEvent(s, ev(2, 'status', { text: 'hi' }), true)).toEqual({ type: 'none' });
    expect(applyRunEvent(s, ev(9, 'status', { text: 'x' }, 'other'), true)).toEqual({ type: 'none' });
    expect(loadRunCursor(s)).toEqual({ runId: 'r', lastSeq: 2 });
  });

  it('turns only replayed events into view actions', () => {
    const s = mem();
    saveRunCursor(s, { runId: 'r', lastSeq: 0 });
    expect(applyRunEvent(s, ev(1, 'status', { text: 'Working' }), false)).toEqual({ type: 'none' });
    expect(applyRunEvent(s, ev(2, 'status', { text: 'Working' }), true)).toEqual({ type: 'status', text: 'Working' });
    expect(applyRunEvent(s, ev(3, 'tool_call', { name: 'fs_read_file', args: '{}' }), true))
      .toEqual({ type: 'tool', ev: { type: 'tool_invoke', name: 'fs_read_file', args: '{}' } });
    expect(applyRunEvent(s, ev(4, 'tool_result', { name: 'fs_read_file', result: 'ok', status: 'error' }), true))
      .toEqual({ type: 'tool', ev: { type: 'tool_result', name: 'fs_read_file', result: 'ok', status: 'error' } });
    expect(applyRunEvent(s, ev(5, 'heartbeat'), true)).toEqual({ type: 'none' });
    expect(loadRunCursor(s)?.lastSeq).toBe(5);
  });

  it('clears the cursor on a terminal event', () => {
    const s = mem();
    saveRunCursor(s, { runId: 'r', lastSeq: 3 });
    expect(applyRunEvent(s, ev(4, 'done', { outcome: 'failed' }), true)).toEqual({ type: 'ended' });
    expect(loadRunCursor(s)).toBeNull();
  });

  it('survives malformed or blocked storage', () => {
    const s = mem();
    s.m.set(RUN_CURSOR_KEY, '{nope');
    expect(loadRunCursor(s)).toBeNull();
    const blocked: CursorStorage = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); }, removeItem: () => { throw new Error('denied'); } };
    expect(loadRunCursor(blocked)).toBeNull();
    expect(() => saveRunCursor(blocked, { runId: 'r', lastSeq: 1 })).not.toThrow();
    expect(applyRunEvent(blocked, ev(1, 'status'), true)).toEqual({ type: 'none' });
  });
});
