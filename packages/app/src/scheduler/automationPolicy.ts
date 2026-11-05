/**
 * Automation policy — the pure decision rules behind scheduled tasks v2.
 *
 * Everything here is side-effect free (no DB, no timers, no fs) so the rules
 * that keep unattended automations safe and honest are unit-testable in
 * isolation:
 *   - schedule frequency floor (nothing tighter than every 15 minutes),
 *   - ±90 s jitter so many installs/tasks don't stampede at :00,
 *   - missed-run catch-up (at most ONE late run per missed slot),
 *   - auto-pause after 3 consecutive failures,
 *   - per-task notify policy (always / on_change / on_failure),
 *   - folder-trigger scope confinement and webhook token checks.
 *
 * The scheduler (scheduler.ts) and engine (engine.ts) apply these rules; they
 * never re-derive them inline.
 */
import * as schedule from 'node-schedule';
import * as path from 'path';
import { createHash, randomBytes, timingSafeEqual } from 'crypto';

/** Minimum allowed spacing between two fires of one cron task (seconds). */
export const MIN_INTERVAL_SECONDS = 15 * 60;
/** Jitter half-width applied to each cron fire (seconds): fire ∈ slot ± 90 s. */
export const JITTER_SECONDS = 90;
/** Consecutive failed runs after which a task auto-pauses. */
export const MAX_CONSECUTIVE_FAILURES = 3;

/** How a task decides whether a finished run is worth a desktop notification. */
export type NotifyPolicy = 'always' | 'on_change' | 'on_failure';
export const NOTIFY_POLICIES: readonly NotifyPolicy[] = ['always', 'on_change', 'on_failure'];

/** Status recorded on a task_executions row. 'ok' is the ONLY success state
 *  and is produced solely by the shared honest-outcome logic (bodhi/taskModel). */
export type ExecStatus = 'running' | 'ok' | 'error' | 'blocked' | 'unverified' | 'cancelled' | 'held';

/** What started a run — recorded on each execution row for the inbox. */
export type FireTrigger = 'schedule' | 'catchup' | 'folder' | 'webhook' | 'manual';

/** Narrow an arbitrary string to a valid notify policy (defaults to 'always'). */
export function normalizeNotifyPolicy(v: unknown): NotifyPolicy {
  return NOTIFY_POLICIES.includes(v as NotifyPolicy) ? (v as NotifyPolicy) : 'always';
}

/**
 * The next fire time of `cron` strictly after `after`, using node-schedule's own
 * parser (so validation and arming can never disagree). Null for an invalid
 * expression or one with no future fire.
 */
export function nextCronFire(cron: string, after: Date): Date | null {
  let job: schedule.Job | null = null;
  try {
    job = schedule.scheduleJob({ start: after, rule: cron }, () => { /* probe only */ });
    if (!job) return null;
    const next = job.nextInvocation() as unknown as { getTime(): number } | null;
    if (!next) return null;
    const t = next.getTime();
    return t > after.getTime() ? new Date(t) : null;
  } catch {
    return null;
  } finally {
    job?.cancel();
  }
}

/**
 * Smallest gap (seconds) between consecutive fires of `cron`, sampled over the
 * next `samples` fires. Null when the expression is invalid. Sampling ~48 fires
 * catches every common pattern ("*\/5 * * * *", "0,5 9 * * *", 6-field second
 * schedules) without hand-rolling a cron parser.
 */
export function minCronIntervalSeconds(cron: string, from = new Date(), samples = 48): number | null {
  let prev = nextCronFire(cron, from);
  if (!prev) return null;
  let min = Infinity;
  for (let i = 0; i < samples; i++) {
    // +1 ms so a sub-second rule can't return the same instant twice.
    const next = nextCronFire(cron, new Date(prev.getTime() + 1));
    if (!next) break;
    min = Math.min(min, (next.getTime() - prev.getTime()) / 1000);
    prev = next;
  }
  return Number.isFinite(min) ? min : Infinity;
}

/** Result of validating a schedule: ok, or rejected with a user-visible reason. */
export type ScheduleCheck = { ok: true } | { ok: false; reason: string };

/**
 * Reject invalid cron expressions and anything that fires more often than every
 * 15 minutes. An unattended agent run every minute burns the local model and
 * floods the inbox — the floor is a product rule, not a preference.
 */
export function validateSchedule(cron: string | null | undefined, from = new Date()): ScheduleCheck {
  if (!cron) return { ok: true };
  const gap = minCronIntervalSeconds(cron, from);
  if (gap === null) return { ok: false, reason: `"${cron}" is not a valid cron expression.` };
  if (gap < MIN_INTERVAL_SECONDS) {
    const mins = Math.max(0, Math.round(gap / 60));
    return {
      ok: false,
      reason: `Schedule "${cron}" fires every ${mins < 1 ? `${Math.round(gap)}s` : `${mins} min`}; ` +
        `scheduled tasks can run at most every ${MIN_INTERVAL_SECONDS / 60} minutes.`,
    };
  }
  return { ok: true };
}

/**
 * Shift a cron slot by a uniform random offset in [−90 s, +90 s], never earlier
 * than one second from `now` (a jittered time in the past would fire instantly
 * and could reorder with the previous run). `rand` is injectable for tests.
 */
export function applyJitter(slot: Date, now: Date, rand: () => number = Math.random): Date {
  const offsetMs = Math.round((rand() * 2 - 1) * JITTER_SECONDS * 1000);
  const t = Math.max(slot.getTime() + offsetMs, now.getTime() + 1000);
  return new Date(t);
}

/** The subset of a task row the catch-up rule reads. */
export interface CatchUpFields {
  cron: string | null;
  fire_at: number | null;
  is_enabled: number;
  pause_reason: string | null;
  last_run_at: number | null;
  /** The slot (unix s) the task was armed for when the app last ran. */
  next_due_at: number | null;
  /** The last slot (unix s) already caught up — guarantees at most one late run per slot. */
  last_catchup_slot: number | null;
}

/**
 * If a task's scheduled time passed while Artha was closed or the machine
 * slept, return that missed slot (unix s) so it runs ONCE, late. Otherwise null.
 *
 * Only the single armed slot is considered, never the full backlog: a daily
 * task missed for three days runs once, not three times. `last_catchup_slot`
 * makes the decision idempotent across repeated wake events.
 */
export function findMissedSlot(t: CatchUpFields, nowSec: number): number | null {
  if (!t.is_enabled || t.pause_reason) return null;
  const slot = t.cron ? t.next_due_at : t.fire_at;
  if (!slot || slot > nowSec) return null;
  if (t.last_catchup_slot != null && t.last_catchup_slot >= slot) return null;
  // A run that started within the jitter window of the slot already covered it.
  if (t.last_run_at != null && t.last_run_at >= slot - JITTER_SECONDS) return null;
  // A one-shot that ever ran is finished.
  if (!t.cron && t.last_run_at != null) return null;
  return slot;
}

/** Human note prefixed to a late run's summary + notification. */
export function lateNote(slotSec: number): string {
  return `Ran late — scheduled for ${new Date(slotSec * 1000).toLocaleString()} while Artha was off or asleep.`;
}

/** Statuses that count as a failure toward auto-pause. 'held' does not count:
 *  the run never started, so nothing about the task itself failed. */
export function isFailureStatus(s: ExecStatus): boolean {
  return s === 'error';
}

/**
 * Advance the consecutive-failure counter for a finished run. Any non-failure
 * resets it; reaching the limit returns a visible pause reason.
 */
export function nextFailureState(
  prevConsecutive: number,
  status: ExecStatus,
): { consecutive: number; pauseReason: string | null } {
  if (status === 'held') return { consecutive: prevConsecutive, pauseReason: null };
  if (!isFailureStatus(status)) return { consecutive: 0, pauseReason: null };
  const consecutive = prevConsecutive + 1;
  return {
    consecutive,
    pauseReason: consecutive >= MAX_CONSECUTIVE_FAILURES
      ? `Auto-paused after ${consecutive} consecutive failed runs. Fix the cause, then resume.`
      : null,
  };
}

/** Stable hash of a run's status + summary, used by the on_change policy. */
export function summaryHash(status: ExecStatus, summary: string): string {
  const normalized = `${status}\n${summary.replace(/\s+/g, ' ').trim().toLowerCase()}`;
  return createHash('sha256').update(normalized).digest('hex');
}

/**
 * Decide whether to notify. Failures (anything but a verified 'ok') always
 * notify under on_failure; on_change notifies only when the status+summary
 * hash differs from the previous execution (the first run always notifies).
 */
export function shouldNotify(
  policy: NotifyPolicy,
  status: ExecStatus,
  hash: string,
  prevHash: string | null,
): boolean {
  if (policy === 'always') return true;
  if (policy === 'on_failure') return status !== 'ok';
  return prevHash === null || prevHash !== hash;
}

/** True when `target` is the root itself or nested inside it. */
function isWithin(target: string, root: string): boolean {
  const rel = path.relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * Folder triggers may only watch a folder inside one of the user's attached
 * folder scopes — the same boundary the agent's file tools already honour.
 */
export function isFolderWithinScopes(folder: string, scopeFolders: string[]): boolean {
  if (!folder || !path.isAbsolute(folder)) return false;
  const target = path.resolve(folder);
  return scopeFolders.some(root => root && isWithin(target, path.resolve(root)));
}

/** Per-task webhook secret: 32 random bytes, hex (256 bits). */
export function generateWebhookToken(): string {
  return randomBytes(32).toString('hex');
}

/** The webhook-relevant subset of a task row. */
export interface WebhookFields {
  is_enabled: number;
  webhook_enabled: number;
  webhook_token: string | null;
}

/**
 * Fail-closed webhook authorisation: the task must exist, be enabled, have its
 * webhook switched on AND carry a token, and the presented token must match in
 * constant time. Any missing piece rejects.
 */
export function authorizeWebhook(
  task: WebhookFields | undefined,
  presented: string | null | undefined,
): { ok: true } | { ok: false; status: number; reason: string } {
  if (!task) return { ok: false, status: 404, reason: 'Unknown task.' };
  if (!task.webhook_enabled || !task.webhook_token) {
    return { ok: false, status: 403, reason: 'Webhook trigger is not enabled for this task.' };
  }
  if (!presented) return { ok: false, status: 401, reason: 'Missing task token.' };
  const a = Buffer.from(presented, 'utf8');
  const b = Buffer.from(task.webhook_token, 'utf8');
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { ok: false, status: 401, reason: 'Invalid task token.' };
  }
  if (!task.is_enabled) return { ok: false, status: 409, reason: 'Task is paused.' };
  return { ok: true };
}

/** Prompts that obviously need the Google connection (Gmail/Calendar/Drive). */
export function promptNeedsGoogle(prompt: string): boolean {
  return /\b(gmail|e-?mails?|inbox|calendar|google drive)\b/i.test(prompt);
}
