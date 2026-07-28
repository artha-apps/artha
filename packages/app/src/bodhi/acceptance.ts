/**
 * User acceptance of a reviewed task — the action that makes
 * "Ready for your review" a real decision instead of a dead end.
 *
 * A task that finished without machine-checkable evidence sits at
 * `needs_review`. When the user explicitly ACCEPTS it, that IS the evidence:
 * we record an `approval_granted` predicate criterion (outcome=passed), which
 * `deriveDelegateOutcome` already reads as verification. So an accepted task
 * honestly reaches `completed` — backed by a durable record that a human signed
 * off, not by the model asserting success.
 *
 * REJECT is the opposite signal: the user says "not right". We record that as
 * evidence and leave the task at review so the conversation can continue — we
 * never fabricate a completion, and we never mark it a system failure (it isn't
 * one; the user just wants changes).
 *
 * Pure with respect to an injected `db`; never throws (bookkeeping must not be
 * able to break the app).
 */

export interface AcceptanceDb {
  prepare(sql: string): {
    run(...args: unknown[]): unknown;
    get(...args: unknown[]): unknown;
  };
}

export type AcceptanceDecision = 'accepted' | 'rejected';

export interface AcceptanceResult {
  ok: boolean;
  taskId: string | null;
  decision: AcceptanceDecision;
  error?: string;
}

/** Ensure the run is anchored to an agent_tasks row; return its id (creating one
 *  if the run has none, as pure-review tasks often do). */
function ensureTask(db: AcceptanceDb, runId: string, sessionId: string, goal: string, newId: () => string): string | null {
  const row = db.prepare(`SELECT task_id FROM agent_runs WHERE run_id=?`).get(runId) as
    { task_id: string | null } | undefined;
  if (row?.task_id) return row.task_id;
  const taskId = newId();
  db.prepare(
    `INSERT INTO agent_tasks (task_id, source_type, source_id, conversation_id, objective, acceptance_mode, last_run_id)
     VALUES (?, 'delegate', ?, ?, ?, 'user_accepted', ?)`
  ).run(taskId, runId, sessionId, goal.slice(0, 500), runId);
  db.prepare(`UPDATE agent_runs SET task_id=? WHERE run_id=?`).run(taskId, runId);
  return taskId;
}

/**
 * Record a user's accept/reject on a reviewed task.
 *
 * Accept → an `approval_granted` criterion (passed) + a receipt evidence row.
 *          deriveDelegateOutcome then reports the task `completed`.
 * Reject → a failed `approval_granted` criterion + evidence noting the user
 *          asked for changes. The task stays reviewable/continuable; it is NOT
 *          reported as a system failure.
 */
export function recordAcceptance(
  db: AcceptanceDb,
  opts: {
    runId: string;
    sessionId: string;
    goal: string;
    decision: AcceptanceDecision;
    newId?: () => string;
  },
): AcceptanceResult {
  const newId = opts.newId ?? (() => Math.random().toString(16).slice(2) + Date.now().toString(16));
  try {
    const taskId = ensureTask(db, opts.runId, opts.sessionId, opts.goal, newId);
    if (!taskId) return { ok: false, taskId: null, decision: opts.decision, error: 'no task to accept' };

    const accepted = opts.decision === 'accepted';

    // ACCEPT records the decisive criterion. approval_granted is in the closed
    // verifiable vocabulary, so a passed one lets deriveVerification reach
    // `verified` → the task honestly becomes `completed`.
    //
    // REJECT does NOT insert a failed criterion: that would make the outcome
    // read "Blocked — check failed", which mislabels a request-for-changes as a
    // system error. Reject only records evidence + keeps the task reviewable, so
    // the user can continue it with feedback (never a fabricated completion,
    // never a fake failure).
    if (accepted) {
      db.prepare(
        `INSERT INTO task_acceptance_criteria
           (task_id, kind, predicate, inputs_json, description, required, outcome, expected, actual, evaluated_at)
         VALUES (?, 'predicate', 'approval_granted', '{}', 'You reviewed and accepted this result.', 1, 'passed', 'user_accepts', 'accepted', unixepoch())`
      ).run(taskId);
    }

    // Durable evidence of the human decision (sanitized, no payload).
    db.prepare(
      `INSERT INTO task_evidence (task_id, run_id, kind, ref, status, summary)
       VALUES (?, ?, 'receipt', 'user', ?, ?)`
    ).run(
      taskId, opts.runId,
      accepted ? 'succeeded' : 'partial',
      accepted ? 'User accepted the result.' : 'User requested changes.',
    );

    // Reflect the decision on the task row so a later reader is consistent.
    db.prepare(
      `UPDATE agent_tasks SET task_status=?, verification_status=?, acceptance_mode='user_accepted',
         completed_at=CASE WHEN ?='completed' THEN unixepoch() ELSE completed_at END, updated_at=unixepoch()
       WHERE task_id=?`
    ).run(
      accepted ? 'completed' : 'awaiting_user_review',
      accepted ? 'verified' : 'awaiting_user_review',
      accepted ? 'completed' : 'awaiting_user_review',
      taskId,
    );

    return { ok: true, taskId, decision: opts.decision };
  } catch (e) {
    return { ok: false, taskId: null, decision: opts.decision, error: e instanceof Error ? e.message : String(e) };
  }
}
