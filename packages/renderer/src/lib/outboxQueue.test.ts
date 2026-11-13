/** Composer outbox helpers: Send→Queue mode, the queue status line (incl.
 *  "Queue paused after cancel"), and drag reorder. */
import { describe, it, expect } from 'vitest';
import { composerMode, queueStatusLine, moveId, type OutboxSnapshotLike } from './outboxQueue';

const snap = (over: Partial<OutboxSnapshotLike> = {}): OutboxSnapshotLike => ({
  items: [{ id: 'a', status: 'ready' }], paused: false, pausedReason: null, steering: [], active: true, ...over,
});

describe('outbox composer helpers', () => {
  it('Send becomes Queue while a run is active (renderer or main)', () => {
    expect(composerMode(false, null)).toBe('send');
    expect(composerMode(true, null)).toBe('queue');
    expect(composerMode(false, { active: true })).toBe('queue');
    expect(composerMode(false, { active: false })).toBe('send');
  });

  it('status line explains a cancel pause', () => {
    expect(queueStatusLine(null)).toBeNull();
    expect(queueStatusLine(snap({ items: [] }))).toBeNull();
    expect(queueStatusLine(snap({ paused: true, pausedReason: 'cancel' }))).toBe('Queue paused after cancel');
    expect(queueStatusLine(snap({ paused: true, pausedReason: 'user' }))).toBe('Queue paused');
    expect(queueStatusLine(snap())).toBe('1 queued — sends when Artha finishes');
    expect(queueStatusLine(snap({ active: false }))).toBe('1 queued');
  });

  it('moveId reorders without mutating', () => {
    const ids = ['a', 'b', 'c'];
    expect(moveId(ids, 2, 0)).toEqual(['c', 'a', 'b']);
    expect(moveId(ids, 0, 2)).toEqual(['b', 'c', 'a']);
    expect(moveId(ids, 0, 9)).toEqual(ids);
    expect(ids).toEqual(['a', 'b', 'c']);
  });
});

describe('queueStatusLine after the global stop shortcut', () => {
  it('says "Queue paused after stop"', () => {
    expect(queueStatusLine(snap({ paused: true, pausedReason: 'stop' }))).toBe('Queue paused after stop');
  });
});
