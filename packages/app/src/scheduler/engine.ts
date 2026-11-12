/**
 * Automation engine — the single fire path for every unattended run.
 *
 * Cron fires, one-shot fires, missed-run catch-ups, folder triggers, local
 * webhooks and "Run now" ALL go through `AutomationEngine.fire()`, so they share
 * the same guarantees:
 *   - no overlap (one in-flight run per task),
 *   - hold states checked BEFORE a run starts (needs re-auth, folder missing,
 *     model unavailable) — a held task records a 'held' execution, never a run,
 *   - every fire records a task_executions row whose status comes from the
 *     injected `run` (which projects the shared honest-outcome logic — the
 *     engine never manufactures 'ok'),
 *   - auto-pause after 3 consecutive failures, with a visible pause_reason,
 *   - the per-task notify policy.
 *
 * Storage and the actual agent run are injected (`EngineDeps`) so the rules are
 * testable without SQLite or Electron. The unattended run context itself is
 * applied by the runner in main.ts — the engine cannot bypass it.
 */
import {
  findMissedSlot, lateNote, nextFailureState, shouldNotify, summaryHash, normalizeNotifyPolicy,
  type ExecStatus, type FireTrigger, type NotifyPolicy,
} from './automationPolicy';

/** A scheduled_tasks row including the v2 automation columns. */
export interface AutomationTask {
  task_id: string;
  name: string;
  prompt: string;
  cron: string | null;
  fire_at: number | null;
  is_enabled: number;
  last_run_at: number | null;
  last_status: string | null;
  run_count: number;
  created_at: number;
  next_due_at: number | null;
  last_catchup_slot: number | null;
  consecutive_failures: number;
  pause_reason: string | null;
  on_hold: number;
  hold_reason: string | null;
  notify: NotifyPolicy | string;
  watch_folder: string | null;
  webhook_enabled: number;
  webhook_token: string | null;
}

/** The honest result of one agent run, as projected by the scheduler. */
export interface RunResult {
  status: Exclude<ExecStatus, 'running' | 'held'>;
  runId: string | null;
  /** Projected task status (bodhi/taskModel vocabulary), stored as last_outcome. */
  taskStatus: string;
  /** Honest one-line explanation from userFacingOutcome. */
  detail: string;
  /** Notification title matching the status. */
  title: string;
  /** One-line summary for the inbox (e.g. the run's final answer, truncated). */
  summary: string;
}

/** Extra context for one fire. */
export interface FireOptions {
  trigger: FireTrigger;
  /** For catch-up: the missed slot (unix s) — adds the "ran late" note. */
  lateSlot?: number;
  /** Appended to the prompt (e.g. which new files a folder trigger saw). */
  context?: string;
}

/** Fields written when an execution row finishes. */
export interface ExecutionFinish {
  status: ExecStatus;
  runId: string | null;
  summary: string;
  summaryHash: string;
  failReason: string | null;
}

/** Persistence the engine needs — implemented over SQLite by the scheduler. */
export interface TaskStore {
  get(taskId: string): AutomationTask | undefined;
  patch(taskId: string, fields: Partial<AutomationTask> & {
    last_run_id?: string | null; last_outcome?: string | null; last_detail?: string | null;
  }): void;
  /** Mark the task as running: last_run_at=now, last_status='running', run_count+1. */
  markRunning(taskId: string, nowSec: number): void;
  startExecution(taskId: string, trigger: FireTrigger, nowSec: number): string;
  finishExecution(execId: string, fields: ExecutionFinish, nowSec: number): void;
  /** summary_hash of the most recent finished execution other than `excludeExecId`. */
  previousSummaryHash(taskId: string, excludeExecId: string): string | null;
}

/** Everything the engine depends on. */
export interface EngineDeps {
  store: TaskStore;
  /** Run the agent unattended and read back the honest outcome. */
  run: (task: AutomationTask, opts: FireOptions) => Promise<RunResult>;
  notify: (title: string, body: string) => void;
  /** Pre-run hold probe: a reason string puts the task on hold, null clears it. */
  holdCheck: (task: AutomationTask) => Promise<string | null>;
  /** Called when the engine disables a task (auto-pause / one-shot done). */
  onDisabled?: (taskId: string) => void;
  /** Unix seconds; injectable for tests. */
  now?: () => number;
}

/** What one fire produced — null when it was skipped (overlap / missing task). */
export interface FireResult {
  execId: string;
  status: ExecStatus;
  notified: boolean;
  paused: boolean;
}

/** Runs automations with the shared safety/honesty rules (see file header). */
export class AutomationEngine {
  /** Task ids with a run in flight — prevents a slow job overlapping itself. */
  private inFlight = new Set<string>();

  constructor(private deps: EngineDeps) {}

  private now(): number {
    return this.deps.now ? this.deps.now() : Math.floor(Date.now() / 1000);
  }

  /** True while a run for this task is executing. */
  isRunning(taskId: string): boolean {
    return this.inFlight.has(taskId);
  }

  /** Fire one task through the shared unattended path. */
  async fire(taskId: string, opts: FireOptions): Promise<FireResult | null> {
    if (this.inFlight.has(taskId)) {
      console.warn(`[Artha] Task ${taskId} skipped: previous run still in flight.`);
      return null;
    }
    const { store } = this.deps;
    const task = store.get(taskId);
    if (!task) return null;
    this.inFlight.add(taskId);
    try {
      return await this.fireInner(task, opts);
    } finally {
      this.inFlight.delete(taskId);
    }
  }

  private async fireInner(task: AutomationTask, opts: FireOptions): Promise<FireResult> {
    const { store } = this.deps;
    const policy = normalizeNotifyPolicy(task.notify);
    const note = opts.lateSlot != null ? lateNote(opts.lateSlot) : '';

    // ── Hold states: checked before anything runs. ──────────────────────────
    let hold: string | null = null;
    try { hold = await this.deps.holdCheck(task); } catch (err) {
      hold = `Pre-run check failed: ${err instanceof Error ? err.message : String(err)}`;
    }
    if (hold) {
      store.patch(task.task_id, { on_hold: 1, hold_reason: hold, last_status: 'held', last_detail: hold });
      const execId = store.startExecution(task.task_id, opts.trigger, this.now());
      const summary = `On hold — ${hold}`;
      const hash = summaryHash('held', hold);
      const prev = store.previousSummaryHash(task.task_id, execId);
      store.finishExecution(execId, { status: 'held', runId: null, summary, summaryHash: hash, failReason: hold }, this.now());
      const notified = shouldNotify(policy, 'held', hash, prev);
      if (notified) this.deps.notify('Artha — scheduled task on hold', `${task.name} — ${hold}`);
      return { execId, status: 'held', notified, paused: false };
    }
    if (task.on_hold) store.patch(task.task_id, { on_hold: 0, hold_reason: null });

    // ── Run. ────────────────────────────────────────────────────────────────
    store.markRunning(task.task_id, this.now());
    const execId = store.startExecution(task.task_id, opts.trigger, this.now());
    let result: RunResult;
    try {
      result = await this.deps.run(task, opts);
    } catch (err) {
      const msg = (err instanceof Error ? err.message : String(err)).slice(0, 300);
      result = {
        status: 'error', runId: null, taskStatus: 'failed', detail: msg,
        title: 'Artha — scheduled task failed', summary: msg,
      };
    }

    const summary = [note, result.summary || result.detail].filter(Boolean).join(' ').slice(0, 400);
    // Hash excludes the late note so a late-but-identical result is "no change".
    const hash = summaryHash(result.status, result.summary || result.detail);
    const prev = store.previousSummaryHash(task.task_id, execId);
    store.finishExecution(execId, {
      status: result.status, runId: result.runId, summary, summaryHash: hash,
      failReason: result.status === 'ok' ? null : result.detail.slice(0, 300),
    }, this.now());

    // ── Failure streak → auto-pause. ────────────────────────────────────────
    // Re-read the row: `task` was loaded before the hold check and the run
    // (which can take minutes). If the user resumed the task meanwhile, its
    // streak was reset to 0 — counting on the stale value could auto-pause
    // a task the user just resumed.
    const current = store.get(task.task_id) ?? task;
    const fail = nextFailureState(current.consecutive_failures ?? 0, result.status);
    store.patch(task.task_id, {
      last_status: result.status === 'cancelled' ? 'cancelled' : result.status,
      last_run_id: result.runId, last_outcome: result.taskStatus, last_detail: result.detail,
      consecutive_failures: fail.consecutive,
      ...(fail.pauseReason ? { is_enabled: 0, pause_reason: fail.pauseReason } : {}),
    });

    // ── One-shot tasks disable after their scheduled fire. ─────────────────
    const oneShotDone = !task.cron && !!task.fire_at && (opts.trigger === 'schedule' || opts.trigger === 'catchup');
    if (oneShotDone) store.patch(task.task_id, { is_enabled: 0 });
    if (fail.pauseReason || oneShotDone) this.deps.onDisabled?.(task.task_id);

    // ── Notify. ─────────────────────────────────────────────────────────────
    const notified = shouldNotify(policy, result.status, hash, prev);
    if (notified) {
      this.deps.notify(result.title, `${task.name} — ${note ? `${note} ` : ''}${result.detail}`);
    }
    // A pause is always surfaced, regardless of the notify policy.
    if (fail.pauseReason) this.deps.notify('Artha — scheduled task paused', `${task.name} — ${fail.pauseReason}`);

    return { execId, status: result.status, notified, paused: !!fail.pauseReason };
  }

  /**
   * Run each missed task once, late. `snapshots` are task rows as they were
   * BEFORE this session re-armed them (their next_due_at is the slot armed
   * last time). The decision per task is `findMissedSlot`; the slot is recorded
   * BEFORE firing so a second wake event can't double-run it. Returns the ids
   * that were caught up.
   */
  async catchUp(snapshots: AutomationTask[], beforeFire?: (taskId: string) => void): Promise<string[]> {
    const { store } = this.deps;
    const fired: string[] = [];
    for (const snap of snapshots) {
      const id = snap.task_id;
      if (this.inFlight.has(id)) continue;
      const slot = findMissedSlot(snap, this.now());
      if (slot == null) continue;
      // Re-read: another catch-up (or a run) may have covered this slot since
      // the snapshot was taken.
      const current = store.get(id);
      if (!current || !current.is_enabled) continue;
      if (current.last_catchup_slot != null && current.last_catchup_slot >= slot) continue;
      store.patch(id, { last_catchup_slot: slot });
      beforeFire?.(id);
      fired.push(id);
      await this.fire(id, { trigger: 'catchup', lateSlot: slot });
    }
    return fired;
  }
}
