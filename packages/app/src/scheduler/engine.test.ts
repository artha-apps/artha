/**
 * AutomationEngine tests against an in-memory TaskStore: catch-up runs exactly
 * once, three failures auto-pause with a reason, on_change suppresses an
 * identical summary, hold states stop the run, and one-shots disable.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AutomationEngine, type AutomationTask, type RunResult, type TaskStore, type ExecutionFinish } from './engine';

/** Minimal in-memory TaskStore mirroring the SQL implementation. */
function makeStore(tasks: AutomationTask[]) {
  const rows = new Map(tasks.map(t => [t.task_id, { ...t } as AutomationTask & Record<string, unknown>]));
  const execs: Array<{ exec_id: string; task_id: string; trigger: string } & Partial<ExecutionFinish>> = [];
  let n = 0;
  const store: TaskStore = {
    get: id => (rows.has(id) ? { ...rows.get(id)! } : undefined),
    patch: (id, f) => { const r = rows.get(id); if (r) Object.assign(r, f); },
    markRunning: (id, now) => { const r = rows.get(id)!; r.last_run_at = now; r.last_status = 'running'; r.run_count++; },
    startExecution: (task_id, trigger) => { const exec_id = `e${++n}`; execs.push({ exec_id, task_id, trigger, status: 'running' }); return exec_id; },
    finishExecution: (id, f) => { Object.assign(execs.find(e => e.exec_id === id)!, f); },
    previousSummaryHash: (taskId, exclude) => {
      const prev = execs.filter(e => e.task_id === taskId && e.exec_id !== exclude && e.status !== 'running');
      return prev.length ? prev[prev.length - 1].summaryHash ?? null : null;
    },
  };
  return { store, rows, execs };
}

function task(over: Partial<AutomationTask> = {}): AutomationTask {
  return {
    task_id: 't1', name: 'Invoices', prompt: 'Check invoices', cron: '0 8 * * *', fire_at: null,
    is_enabled: 1, last_run_at: 1_000, last_status: 'ok', run_count: 1, created_at: 0,
    next_due_at: 10_000, last_catchup_slot: null, consecutive_failures: 0, pause_reason: null,
    on_hold: 0, hold_reason: null, notify: 'always', watch_folder: null, webhook_enabled: 0, webhook_token: null,
    ...over,
  };
}

const ok = (summary = 'No new invoices.'): RunResult => ({
  status: 'ok', runId: 'r1', taskStatus: 'completed', detail: 'done (verified).', title: 'done', summary,
});
const failed = (): RunResult => ({
  status: 'error', runId: 'r2', taskStatus: 'failed', detail: 'LLM error', title: 'failed', summary: 'LLM error',
});

let notify: ReturnType<typeof vi.fn>;
beforeEach(() => { notify = vi.fn(); });

describe('missed-run catch-up', () => {
  it('runs a missed slot exactly once, with a "ran late" note, even across repeated wakes', async () => {
    const { store, execs } = makeStore([task()]);
    const run = vi.fn(async () => ok());
    const engine = new AutomationEngine({ store, run, notify, holdCheck: async () => null, now: () => 20_000 });

    const snapshot = [store.get('t1')!];
    expect(await engine.catchUp(snapshot)).toEqual(['t1']);
    // A second startup/wake with the same (stale) snapshot must not re-run it.
    expect(await engine.catchUp(snapshot)).toEqual([]);
    expect(await engine.catchUp([store.get('t1')!])).toEqual([]);

    expect(run).toHaveBeenCalledTimes(1);
    expect(execs).toHaveLength(1);
    expect(execs[0].trigger).toBe('catchup');
    expect(execs[0].summary).toMatch(/^Ran late/);
    expect(notify.mock.calls[0][1]).toMatch(/Ran late/);
  });

  it('does nothing when the slot has not passed', async () => {
    const { store } = makeStore([task({ next_due_at: 30_000 })]);
    const run = vi.fn(async () => ok());
    const engine = new AutomationEngine({ store, run, notify, holdCheck: async () => null, now: () => 20_000 });
    expect(await engine.catchUp([store.get('t1')!])).toEqual([]);
    expect(run).not.toHaveBeenCalled();
  });
});

describe('auto-pause after consecutive failures', () => {
  it('pauses on the 3rd failure with a visible reason and always notifies the pause', async () => {
    const { store, rows } = makeStore([task({ notify: 'on_change' })]);
    const onDisabled = vi.fn();
    const engine = new AutomationEngine({ store, run: async () => failed(), notify, holdCheck: async () => null, onDisabled });

    await engine.fire('t1', { trigger: 'schedule' });
    await engine.fire('t1', { trigger: 'schedule' });
    expect(rows.get('t1')!.is_enabled).toBe(1);
    const r = await engine.fire('t1', { trigger: 'schedule' });

    expect(r?.paused).toBe(true);
    expect(rows.get('t1')!.is_enabled).toBe(0);
    expect(rows.get('t1')!.pause_reason).toMatch(/3 consecutive failed runs/);
    expect(onDisabled).toHaveBeenCalledWith('t1');
    expect(notify.mock.calls.some(c => /paused/.test(c[0]))).toBe(true);
  });

  it('a thrown runner counts as a failure (never as success)', async () => {
    const { store, execs } = makeStore([task()]);
    const engine = new AutomationEngine({ store, run: async () => { throw new Error('boom'); }, notify, holdCheck: async () => null });
    const r = await engine.fire('t1', { trigger: 'manual' });
    expect(r?.status).toBe('error');
    expect(execs[0]).toMatchObject({ status: 'error', failReason: 'boom' });
  });

  it('a user resume during a run resets the streak it counts from (R3 #4)', async () => {
    const { store, rows } = makeStore([task({ consecutive_failures: 2 })]);
    const engine = new AutomationEngine({
      store, notify, holdCheck: async () => null,
      run: async () => {
        // The user resumes the task while this (failing) run is in flight.
        store.patch('t1', { consecutive_failures: 0, is_enabled: 1, pause_reason: null });
        return failed();
      },
    });
    const r = await engine.fire('t1', { trigger: 'schedule' });
    expect(r?.paused).toBe(false);
    expect(rows.get('t1')!.is_enabled).toBe(1);
    expect(rows.get('t1')!.consecutive_failures).toBe(1);
  });

  it('a success resets the streak', async () => {
    const { store, rows } = makeStore([task({ consecutive_failures: 2 })]);
    const engine = new AutomationEngine({ store, run: async () => ok(), notify, holdCheck: async () => null });
    await engine.fire('t1', { trigger: 'schedule' });
    expect(rows.get('t1')!.consecutive_failures).toBe(0);
  });
});

describe('notify policy', () => {
  it('on_change suppresses an identical summary and notifies a changed one', async () => {
    const { store } = makeStore([task({ notify: 'on_change' })]);
    let summary = 'No new invoices.';
    const engine = new AutomationEngine({ store, run: async () => ok(summary), notify, holdCheck: async () => null });

    expect((await engine.fire('t1', { trigger: 'schedule' }))?.notified).toBe(true);   // first run
    expect((await engine.fire('t1', { trigger: 'schedule' }))?.notified).toBe(false);  // identical
    summary = '2 new invoices from Acme.';
    expect((await engine.fire('t1', { trigger: 'schedule' }))?.notified).toBe(true);   // changed
    expect(notify).toHaveBeenCalledTimes(2);
  });

  it('on_failure stays quiet on success', async () => {
    const { store } = makeStore([task({ notify: 'on_failure' })]);
    const engine = new AutomationEngine({ store, run: async () => ok(), notify, holdCheck: async () => null });
    expect((await engine.fire('t1', { trigger: 'schedule' }))?.notified).toBe(false);
    expect(notify).not.toHaveBeenCalled();
  });
});

describe('hold states', () => {
  it('records a held execution and does not run the agent', async () => {
    const { store, rows, execs } = makeStore([task()]);
    const run = vi.fn(async () => ok());
    const engine = new AutomationEngine({ store, run, notify, holdCheck: async () => 'Model unavailable: not installed' });
    const r = await engine.fire('t1', { trigger: 'schedule' });
    expect(r?.status).toBe('held');
    expect(run).not.toHaveBeenCalled();
    expect(rows.get('t1')!).toMatchObject({ on_hold: 1, hold_reason: 'Model unavailable: not installed' });
    expect(execs[0]).toMatchObject({ status: 'held', failReason: 'Model unavailable: not installed' });
    // Holds don't push the task toward auto-pause.
    expect(rows.get('t1')!.consecutive_failures).toBe(0);
  });

  it('clears the hold once the probe passes', async () => {
    const { store, rows } = makeStore([task({ on_hold: 1, hold_reason: 'x' })]);
    const engine = new AutomationEngine({ store, run: async () => ok(), notify, holdCheck: async () => null });
    await engine.fire('t1', { trigger: 'schedule' });
    expect(rows.get('t1')!).toMatchObject({ on_hold: 0, hold_reason: null });
  });
});

describe('overlap + one-shot', () => {
  it('skips a fire while the previous run is in flight', async () => {
    const { store } = makeStore([task()]);
    let release!: () => void;
    const engine = new AutomationEngine({
      store, notify, holdCheck: async () => null,
      run: () => new Promise<RunResult>(res => { release = () => res(ok()); }),
    });
    const first = engine.fire('t1', { trigger: 'schedule' });
    await Promise.resolve(); await Promise.resolve();
    expect(await engine.fire('t1', { trigger: 'webhook' })).toBeNull();
    release();
    expect((await first)?.status).toBe('ok');
  });

  it('disables a one-shot after its scheduled fire but not after Run now', async () => {
    const { store, rows } = makeStore([task({ cron: null, fire_at: 5_000, next_due_at: null })]);
    const engine = new AutomationEngine({ store, run: async () => ok(), notify, holdCheck: async () => null });
    await engine.fire('t1', { trigger: 'manual' });
    expect(rows.get('t1')!.is_enabled).toBe(1);
    await engine.fire('t1', { trigger: 'schedule' });
    expect(rows.get('t1')!.is_enabled).toBe(0);
  });
});
