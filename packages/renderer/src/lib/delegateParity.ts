/**
 * Pure helpers that give the Delegate tab parity with Chat:
 *
 *  1. Outbox composer: while a Delegate run is active, the follow-up box
 *     QUEUES (outbox IPC) instead of being disabled. Main drains the queue
 *     with the same rules as chat: never during a run, never past a pending
 *     approval / ask card / plan review, paused after Stop or the stop
 *     shortcut. A drained item starts a Delegate continuation and main emits
 *     `delegate:followUpStarted`; `shouldFollowRun` decides whether the open
 *     Delegate view should switch to that run.
 *
 *  2. Plan step comments: DelegatePlanView lets the user comment on steps and
 *     Accept / Accept with comments / Reject, decided by the S5 plan-review
 *     logic (app/src/agent/planReview.ts, pure). Delegate's pre-run plan is
 *     built locally without a planner model, so there is nothing to revise:
 *     comments are carried into the run as review notes — S5's "accepted with
 *     comments, no further revision" branch. Reject never runs the task.
 *
 * DOM-free so it is unit-testable under the node vitest environment.
 */
import { decidePlanReview, MAX_PLAN_REVISIONS, type PlanReview } from '../../../app/src/agent/planReview';
import type { DelegateStatus } from '../services/delegateService';

/** Statuses in which no run is executing (the composer sends directly). */
const NOT_RUNNING: ReadonlySet<DelegateStatus> = new Set<DelegateStatus>([
  'idle', 'completed', 'needs_review', 'failed', 'awaiting_confirmation',
]);

/** True while a Delegate run is executing (the Stop button is shown). */
export function isDelegateRunning(status: DelegateStatus): boolean {
  return !NOT_RUNNING.has(status);
}

/** What the follow-up composer's primary action does:
 *  - 'send'     — no run: Continue the task right away;
 *  - 'queue'    — a run is active (renderer status or main's outbox driver):
 *                 park the message in the outbox;
 *  - 'disabled' — a run is starting but the task has no session yet, so there
 *                 is nowhere to queue. */
export function delegateComposerMode(
  status: DelegateStatus,
  sessionId: string | null,
  snapshot: { active: boolean } | null,
): 'send' | 'queue' | 'disabled' {
  const running = isDelegateRunning(status) || !!snapshot?.active;
  if (!running) return 'send';
  return sessionId ? 'queue' : 'disabled';
}

/** Placeholder text for each composer mode. */
export function delegateComposerPlaceholder(mode: 'send' | 'queue' | 'disabled'): string {
  switch (mode) {
    case 'queue': return 'Artha is working — type a follow-up and it will be queued.';
    case 'disabled': return 'Artha is starting the task…';
    default: return 'Continue this task: "that\'s not complete", "you missed X", "retry the failed step"…';
  }
}

/** Whether the open Delegate view should follow a run started by an outbox
 *  drain: only for the task on screen, and only for a run it isn't already on. */
export function shouldFollowRun(
  view: { sessionId: string | null; runId: string | null },
  ev: { sessionId: string; runId: string },
): boolean {
  return !!view.sessionId && ev.sessionId === view.sessionId && ev.runId !== view.runId;
}

/** Minimal plan shape the review reads. */
export interface ReviewablePlan {
  goal: string;
  steps: Array<{ index: number; description: string }>;
}

/** Step comment drafts (by step index) → the S5 comment list, trimmed, with
 *  empty drafts dropped. */
export function draftsToComments(plan: ReviewablePlan, drafts: Record<number, string>) {
  return plan.steps
    .filter(s => (drafts[s.index] ?? '').trim())
    .map(s => ({ step_index: s.index, original_text: s.description, comment: drafts[s.index].trim() }));
}

/** What the Delegate store does with a plan review. */
export type DelegateReviewOutcome =
  | { kind: 'run'; goal: string; notes: string | null }
  | { kind: 'reject'; reason: string };

/** Decide a Delegate plan review through the S5 logic. `goal` is what the run
 *  is started with: the original goal plus the review notes, when any. */
export function delegatePlanReviewOutcome(plan: ReviewablePlan, review: PlanReview): DelegateReviewOutcome {
  // No planner model to revise with: start at the revision cap so comments
  // become execution notes instead of a re-plan.
  const action = decidePlanReview(review, { goal: plan.goal, steps: plan.steps, revisions: MAX_PLAN_REVISIONS });
  if (action.kind === 'cancel') return { kind: 'reject', reason: action.reason };
  if (action.kind === 'revise') {
    // Unreachable at the cap; fail closed rather than run unreviewed.
    return { kind: 'reject', reason: 'plan revision is not available for Delegate' };
  }
  const notes = action.reviewNotes;
  return { kind: 'run', goal: notes ? `${plan.goal}\n\n${notes}` : plan.goal, notes };
}
