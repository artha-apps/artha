/**
 * Regression for the cron "double fire" bug (bug-hunt R3 #1).
 *
 * Jitter can fire a cron slot up to 90 s early. The re-arm after the run used
 * to compute the next slot from the wall clock, which was still before the
 * slot, so it found the SAME slot and ran the task a second time. These tests
 * drive the real node-schedule timers under fake time and check each slot
 * runs exactly once.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('electron', () => ({ app: { getPath: () => '/tmp' } }));
vi.mock('../notify', () => ({ sendNotification: vi.fn() }));
vi.mock('../sentry', () => ({
  startCheckIn: vi.fn(), finishCheckIn: vi.fn(), addBreadcrumb: vi.fn(), captureException: vi.fn(),
}));
vi.mock('../db/schema', () => ({ getDb: () => { throw new Error('no db in this test'); } }));
// Fire 72 s early every time (rand 0.1 → offset −72 s): the worst case for the bug.
vi.mock('./automationPolicy', async (orig) => {
  const real = await orig<typeof import('./automationPolicy')>();
  return { ...real, applyJitter: (slot: Date, now: Date) => real.applyJitter(slot, now, () => 0.1) };
});

import { SchedulerService } from './scheduler';

type Row = Record<string, unknown>;

/** Build a service whose store is a single in-memory task row. */
function makeService(row: Row) {
  const svc = new (SchedulerService as unknown as { new(): SchedulerService })();
  const internals = svc as unknown as {
    store: { get(id: string): Row | undefined; patch(id: string, f: Row): void };
    runTask: unknown;
    armNextCronSlot(id: string, cron: string, after?: number): void;
  };
  internals.store = {
    get: () => row,
    patch: (_id, f) => { Object.assign(row, f); },
  };
  internals.runTask = async () => ({ sessionId: 's' });
  return { svc, internals };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 10, 12, 8, 58, 0)); // local time: cron is local
});
afterEach(() => { vi.useRealTimers(); });

describe('cron re-arm after an early (jittered) fire', () => {
  it('runs the 09:00 slot once, then arms the next day', async () => {
    const row: Row = { task_id: 't1', cron: '0 9 * * *', is_enabled: 1, last_catchup_slot: null };
    const { svc, internals } = makeService(row);
    const fire = vi.spyOn(svc.engine, 'fire').mockImplementation(async () => {
      await new Promise(r => setTimeout(r, 10_000)); // a 10 s run
      return null;
    });

    internals.armNextCronSlot('t1', '0 9 * * *');
    const slot = new Date(2026, 10, 12, 9, 0, 0).getTime() / 1000;
    expect(row.next_due_at).toBe(slot);

    // Through the early fire, the run, and well past the real slot.
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000);

    expect(fire).toHaveBeenCalledTimes(1);
    expect(row.last_catchup_slot).toBe(slot);
    expect(row.next_due_at).toBe(slot + 24 * 3600);
    svc.shutdown();
  });

  it('skips a duplicate timer for a slot that already ran', async () => {
    const slot = new Date(2026, 10, 12, 9, 0, 0).getTime() / 1000;
    const row: Row = { task_id: 't1', cron: '0 9 * * *', is_enabled: 1, last_catchup_slot: slot };
    const { svc, internals } = makeService(row);
    const fire = vi.spyOn(svc.engine, 'fire').mockResolvedValue(null);

    internals.armNextCronSlot('t1', '0 9 * * *');
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);

    expect(fire).not.toHaveBeenCalled();
    svc.shutdown();
  });
});
