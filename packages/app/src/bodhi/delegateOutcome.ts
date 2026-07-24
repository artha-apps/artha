/**
 * The honest projection for a Delegate/scheduler run.
 *
 * Phase A.5: the UI must NOT read `agent_runs.status` (which is written when the
 * executor stops, not when the objective is met). It must render from
 * `userFacingOutcome()`, derived from evidence. This module assembles a
 * `TaskFacts` from what a run actually persisted and returns the projection plus
 * a coarse `uiStatus` the renderer groups on.
 *
 * The rule the whole trust effort turns on:
 *   - a CONFIRMED consequential action (external_actions state='confirmed', e.g.
 *     an email that Gmail acknowledged) is system evidence → "Completed";
 *   - a run that merely FINISHED with no machine-checkable criteria is NOT
 *     "completed" — it's "Ready for your review" (the user accepts it);
 *   - failed / interrupted / blocked stay honest, never collapsed to completed.
 *
 * Pure with respect to an injected `db`, so every rule is unit-testable.
 */
import {
  userFacingOutcome,
  legacyStatusToOutcome,
  type TaskFacts,
  type RunFacts,
  type Criterion,
  type AcceptanceMode,
  type ExternalActionState,
  type UserFacingOutcome,
} from './taskModel';

/** Coarse terminal grouping the renderer switches on. `needs_review` is a
 *  terminal, non-alarming state (ready to accept / stopped-not-verified) that is
 *  neither a green "completed" nor a red "failed". */
export type DelegateUiStatus = 'running' | 'completed' | 'needs_review' | 'failed';

export interface DelegateOutcome extends UserFacingOutcome {
  uiStatus: DelegateUiStatus;
}

/** Minimal DB surface (better-sqlite3-shaped), injected for testability. */
export interface OutcomeDb {
  prepare(sql: string): {
    get(...args: unknown[]): unknown;
    all(...args: unknown[]): unknown[];
  };
}

interface RunRow {
  status: string | null;
  run_outcome: string | null;
  task_id: string | null;
  tool_calls_total: number | null;
  tool_calls_failed: number | null;
  tool_calls_blocked: number | null;
  mutations_total: number | null;
  mutations_failed: number | null;
  error_detail: string | null;
}

function withUi(o: UserFacingOutcome): DelegateOutcome {
  let uiStatus: DelegateUiStatus;
  if (o.isComplete) uiStatus = 'completed';
  else if (o.taskStatus === 'failed' || o.taskStatus === 'cancelled') uiStatus = 'failed';
  else if (o.taskStatus === 'queued' || o.taskStatus === 'active') uiStatus = 'running';
  else uiStatus = 'needs_review'; // awaiting_user_review | awaiting_approval | partially_completed | blocked
  return { ...o, uiStatus };
}

export function deriveDelegateOutcome(db: OutcomeDb, runId: string): DelegateOutcome {
  const run = db.prepare(
    `SELECT status, run_outcome, task_id, tool_calls_total, tool_calls_failed, tool_calls_blocked,
            mutations_total, mutations_failed, error_detail
       FROM agent_runs WHERE run_id=?`
  ).get(runId) as RunRow | undefined;

  if (!run) {
    return withUi(userFacingOutcome({
      run: null, criteria: [], acceptanceMode: 'user_review', externalActionStates: [], evidenceCount: 0,
    }));
  }

  const legacy = run.run_outcome == null;
  const runFacts: RunFacts = {
    outcome: legacy ? legacyStatusToOutcome(run.status) : (run.run_outcome as RunFacts['outcome']),
    toolCallsTotal: run.tool_calls_total ?? 0,
    toolCallsFailed: run.tool_calls_failed ?? 0,
    toolCallsBlocked: run.tool_calls_blocked ?? 0,
    mutationsTotal: run.mutations_total ?? 0,
    mutationsFailed: run.mutations_failed ?? 0,
    errorDetail: run.error_detail,
  };

  const externalActionStates = (db.prepare(`SELECT state FROM external_actions WHERE run_id=?`).all(runId) as { state: string }[])
    .map(r => r.state as ExternalActionState);

  const realCriteria: Criterion[] = run.task_id
    ? (db.prepare(
        `SELECT kind, predicate, description, required, outcome FROM task_acceptance_criteria WHERE task_id=?`
      ).all(run.task_id) as Array<{ kind: string; predicate: string | null; description: string; required: number; outcome: string }>)
        .map(c => ({
          kind: c.kind === 'predicate' ? 'predicate' : 'prose',
          predicate: c.predicate,
          description: c.description,
          required: !!c.required,
          outcome: c.outcome as Criterion['outcome'],
        }))
    : [];

  const evidenceCount = (db.prepare(`SELECT COUNT(*) AS n FROM task_evidence WHERE run_id=?`).get(runId) as { n: number } | undefined)?.n ?? 0;

  // Decide the criteria + acceptance mode when the task didn't define its own.
  let criteria: Criterion[];
  let acceptanceMode: AcceptanceMode;
  if (realCriteria.length) {
    criteria = realCriteria;
    acceptanceMode = 'user_review';
  } else if (externalActionStates.includes('confirmed')) {
    // A consequential action completed WITH confirmation — hard system evidence.
    criteria = [{
      kind: 'predicate', predicate: 'external_identifier_returned',
      description: 'The requested action was completed and confirmed.',
      required: true, outcome: 'passed',
    }];
    acceptanceMode = 'system_verified';
  } else {
    // Finished, but nothing machine-checkable — the user accepts the result.
    criteria = [{
      kind: 'prose', description: 'Objective completed as requested.',
      required: true, outcome: 'awaiting_user_review',
    }];
    acceptanceMode = 'user_review';
  }

  return withUi(userFacingOutcome({
    run: runFacts,
    criteria,
    acceptanceMode,
    externalActionStates,
    evidenceCount,
    legacy: legacy || undefined,
  }));
}
