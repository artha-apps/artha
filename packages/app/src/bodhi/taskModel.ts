/**
 * Phase A.5 — the truthful task model.
 *
 * Three separate facts, never one boolean:
 *   RUN          — what happened to one execution attempt.
 *   VERIFICATION — what the evidence actually proves.
 *   TASK         — where the user's objective stands.
 *
 * The defect this replaces: `agent_runs.status='completed'` was written from
 * control flow (the model stopped calling tools), and every surface read it as
 * "objective achieved". Here, only `deriveTaskStatus` may conclude `completed`,
 * and only from evidence.
 *
 * Pure and dependency-free so every rule is unit-testable.
 */

// ── Dimension 1: run status ────────────────────────────────────────────────
export type RunOutcome =
  | 'queued' | 'running' | 'succeeded' | 'failed'
  | 'timed_out' | 'cancelled' | 'interrupted';

// ── Dimension 2: verification ──────────────────────────────────────────────
export type VerificationStatus =
  | 'not_evaluated' | 'verified' | 'unverified' | 'verification_failed'
  | 'not_verifiable' | 'awaiting_user_review' | 'not_applicable'
  /** Legacy rows predating Phase A.5 — never silently relabelled verified. */
  | 'unknown_legacy';

// ── Dimension 3: task lifecycle ────────────────────────────────────────────
export type TaskStatus =
  | 'draft' | 'queued' | 'active' | 'awaiting_user_input' | 'awaiting_approval'
  | 'paused' | 'blocked' | 'partially_completed' | 'awaiting_user_review'
  | 'completed' | 'failed' | 'cancelled';

/** How this task is allowed to reach `completed`. */
export type AcceptanceMode = 'system_verified' | 'user_review' | 'user_accepted';

/** Closed predicate vocabulary — the ONLY criteria that may yield `verified`.
 *  Prose criteria are storable and displayable but cap at user review, so the
 *  model can never verify its own subjective output. */
export const VERIFIABLE_PREDICATES = [
  'file_exists', 'artifact_exists', 'file_hash_matches', 'expected_section_present',
  'command_exit_code_equals', 'test_suite_passed', 'build_succeeded',
  'database_record_exists', 'external_identifier_returned',
  'browser_confirmation_observed', 'all_required_subtasks_verified', 'approval_granted',
] as const;
export type VerifiablePredicate = (typeof VERIFIABLE_PREDICATES)[number];

export function isVerifiablePredicate(p: string | null | undefined): p is VerifiablePredicate {
  return !!p && (VERIFIABLE_PREDICATES as readonly string[]).includes(p);
}

export type CriterionOutcome =
  'not_evaluated' | 'passed' | 'failed' | 'indeterminate' | 'awaiting_user_review';

export interface Criterion {
  kind: 'predicate' | 'prose';
  predicate?: string | null;
  description: string;
  required: boolean;
  outcome: CriterionOutcome;
}

/** Consequential-action states (write-ahead intent log). */
export type ExternalActionState =
  | 'planned' | 'awaiting_approval' | 'authorized' | 'dispatching' | 'dispatched'
  | 'confirmed' | 'failed' | 'outcome_unknown' | 'cancelled';

export interface RunFacts {
  outcome: RunOutcome;
  toolCallsTotal: number;
  toolCallsFailed: number;
  toolCallsBlocked: number;
  mutationsTotal: number;
  mutationsFailed: number;
  /** Terminal reason: 'stall' | 'max_iterations' | 'llm_error' | … */
  errorDetail?: string | null;
  /** True when the plan required approval and nothing executed. */
  approvalRequired?: boolean;
}

export interface TaskFacts {
  run: RunFacts | null;              // null = no run was ever created
  criteria: Criterion[];
  acceptanceMode: AcceptanceMode;
  externalActionStates: ExternalActionState[];
  evidenceCount: number;
  /** True when a run row exists but predates Phase A.5 evidence capture. */
  legacy?: boolean;
}

// ── Verification derivation ────────────────────────────────────────────────

/**
 * What does the evidence prove? Never optimistic: absence of evidence is
 * `unverified`, not `verified`.
 */
export function deriveVerification(f: TaskFacts): VerificationStatus {
  if (f.legacy) return 'unknown_legacy';
  if (!f.run) return 'not_evaluated';                    // nothing ran
  if (f.run.outcome === 'running' || f.run.outcome === 'queued') return 'not_evaluated';

  const required = f.criteria.filter(c => c.required);
  const verifiable = required.filter(c => c.kind === 'predicate' && isVerifiablePredicate(c.predicate));
  const prose = required.filter(c => c.kind === 'prose' || !isVerifiablePredicate(c.predicate));

  // A required machine-checkable criterion that failed is decisive.
  if (verifiable.some(c => c.outcome === 'failed')) return 'verification_failed';

  // An external action we dispatched but cannot confirm blocks verification.
  if (f.externalActionStates.includes('outcome_unknown')) return 'unverified';

  if (verifiable.length > 0 && verifiable.every(c => c.outcome === 'passed')) {
    // All machine-checkable criteria passed — but prose criteria still need a
    // human before the objective may be called done.
    return prose.length > 0 ? 'awaiting_user_review' : 'verified';
  }

  if (verifiable.some(c => c.outcome === 'indeterminate')) return 'not_verifiable';
  if (verifiable.length > 0) return 'unverified';        // some not yet evaluated

  // No machine-checkable criteria at all.
  if (prose.length > 0) return 'awaiting_user_review';
  return f.evidenceCount > 0 ? 'unverified' : 'not_evaluated';
}

// ── Task-status derivation (the only place `completed` may be produced) ────

export function deriveTaskStatus(f: TaskFacts, verification: VerificationStatus): TaskStatus {
  // Approval gate: no execution occurred. Never a completion.
  if (f.run?.approvalRequired) return 'awaiting_approval';
  if (!f.run) return 'queued';

  switch (f.run.outcome) {
    case 'queued':   return 'queued';
    case 'running':  return 'active';
    case 'cancelled':return 'cancelled';
    case 'failed':   return 'failed';
    case 'timed_out':
    case 'interrupted': return 'partially_completed';
    case 'succeeded': break;
  }

  // The executor finished — that alone proves nothing about the objective.
  if (verification === 'verified') {
    // user_accepted tasks stay open until the user says so.
    return f.acceptanceMode === 'user_accepted' ? 'awaiting_user_review' : 'completed';
  }
  if (verification === 'awaiting_user_review') return 'awaiting_user_review';
  if (verification === 'verification_failed') return 'blocked';
  if (verification === 'unknown_legacy') return 'partially_completed';
  // unverified / not_verifiable / not_evaluated
  return 'partially_completed';
}

// ── The single source of user-facing wording ───────────────────────────────

export interface UserFacingOutcome {
  taskStatus: TaskStatus;
  verification: VerificationStatus;
  /** Short label. Never says "completed" unless taskStatus === 'completed'. */
  label: string;
  /** One honest sentence. */
  message: string;
  remainingWork: string[];
  requiredUserAction: string | null;
  /** True only when the objective is genuinely verified-complete. */
  isComplete: boolean;
}

const plural = (n: number, s: string) => `${n} ${s}${n === 1 ? '' : 's'}`;

/**
 * THE projection. Every surface — Delegate UI, scheduler notification, CLI —
 * must render from this. No UI, notification or scheduler path may
 * independently manufacture the words "completed", "successful", "finished"
 * or "done".
 */
export function userFacingOutcome(f: TaskFacts): UserFacingOutcome {
  const verification = deriveVerification(f);
  const taskStatus = deriveTaskStatus(f, verification);
  const remainingWork = f.criteria
    .filter(c => c.required && c.outcome !== 'passed')
    .map(c => c.description)
    .filter(Boolean);

  const failedTools = f.run
    ? f.run.toolCallsFailed + (f.run.toolCallsBlocked > 0 ? 0 : 0)
    : 0;

  let label = 'In progress';
  let message = 'Working…';
  let requiredUserAction: string | null = null;

  switch (taskStatus) {
    case 'awaiting_approval':
      label = 'Blocked — needs approval';
      message = 'This task requires your approval before it can continue. No consequential action was performed.';
      requiredUserAction = 'Review and approve the plan to continue.';
      break;
    case 'queued':
      label = 'Queued';
      message = 'This task has not started yet.';
      break;
    case 'active':
      label = 'Running';
      message = 'Artha is working on this task.';
      break;
    case 'cancelled':
      label = 'Cancelled';
      message = 'You cancelled this run.';
      break;
    case 'failed':
      label = 'Failed';
      message = f.run?.errorDetail
        ? `The run failed: ${f.run.errorDetail}.`
        : 'The run failed before finishing.';
      requiredUserAction = 'Review the error and retry if appropriate.';
      break;
    case 'blocked':
      label = 'Blocked — check failed';
      message = 'The run finished, but a required check did not pass.';
      requiredUserAction = 'Review the failed requirement below.';
      break;
    case 'awaiting_user_review':
      label = 'Ready for your review';
      message = 'The requested output is ready for your review.';
      requiredUserAction = 'Review the result and accept it, or tell Artha what to change.';
      break;
    case 'partially_completed': {
      label = 'Stopped — not verified';
      if (f.run?.outcome === 'interrupted') {
        message = 'The run was interrupted (Artha closed) and completion was not verified.';
      } else if (f.run?.outcome === 'timed_out') {
        message = 'The run hit its time limit and completion was not verified.';
      } else if (f.externalActionStates.includes('outcome_unknown')) {
        message = 'The external action may have been attempted, but its outcome could not be confirmed.';
      } else if (verification === 'unknown_legacy') {
        message = 'This run predates verification, so its outcome cannot be confirmed.';
      } else if (f.run && f.run.toolCallsTotal > 0 && failedTools === f.run.toolCallsTotal) {
        message = `The run stopped, but every tool call failed (${plural(failedTools, 'call')}), so completion was not verified.`;
      } else if (f.run && failedTools > 0) {
        message = `The run stopped with ${plural(failedTools, 'failed tool call')}; completion was not verified.`;
      } else {
        message = 'The run stopped, but completion was not verified.';
      }
      requiredUserAction = remainingWork.length
        ? 'Review what remains, or tell Artha to continue.'
        : 'Review the evidence, or tell Artha to continue.';
      break;
    }
    case 'completed':
      label = 'Completed — verified';
      message = 'The objective was completed and verified against its acceptance criteria.';
      break;
    default:
      break;
  }

  return {
    taskStatus,
    verification,
    label,
    message,
    remainingWork,
    requiredUserAction,
    isComplete: taskStatus === 'completed',
  };
}

/** Map a legacy `agent_runs.status` to a run outcome without inventing facts. */
export function legacyStatusToOutcome(status: string | null | undefined): RunOutcome {
  switch (status) {
    case 'completed': return 'succeeded';   // executor finished — NOT "objective done"
    case 'failed':    return 'failed';
    case 'cancelled': return 'cancelled';
    case 'running':   return 'running';
    default:          return 'queued';
  }
}
