/**
 * Resume offer for runs the app interrupted.
 *
 * On startup, runMigrations() reconciles any run left 'running' by a quit or
 * crash as run_outcome='interrupted' (never completed). This module turns
 * those rows into an explicit offer: the renderer lists them with Resume /
 * Dismiss. Nothing is ever resumed automatically — including unattended
 * (scheduled) runs, which are offered exactly like interactive ones — because
 * a resumed run may act again and the user must choose that.
 *
 * Resuming continues in the SAME session with a prompt that says where the
 * app stopped and forbids repeating any external action the interrupted run
 * already confirmed (or dispatched with unknown outcome). Those action ids are
 * also passed in the run context, where the email tool enforces them in code;
 * the prompt is guidance, the guard is the guarantee.
 */
import type { SqlDb } from '../db/sqlLike';

/** One external action an interrupted run had already performed/attempted. */
export interface PriorExternalAction {
  actionId: string;
  tool: string;
  /** 'confirmed' = provider acknowledged; 'dispatching' = outcome unknown. */
  state: string;
}

/** An interrupted run as offered to the user. */
export interface InterruptedRun {
  runId: string;
  sessionId: string;
  goal: string;
  createdAt: number;
  /** Highest agent_steps.idx recorded before the interruption (-1 if none). */
  lastStepIdx: number;
  /** True for scheduled-task sessions — offered, never auto-resumed. */
  unattended: boolean;
  confirmedActions: PriorExternalAction[];
}

/** External actions of a run that must never be repeated on resume. */
export function confirmedActionsForRun(db: SqlDb, runId: string): PriorExternalAction[] {
  try {
    return (db.prepare(
      `SELECT action_id, tool, state FROM external_actions
        WHERE run_id=? AND state IN ('confirmed','dispatching') ORDER BY created_at`
    ).all(runId) as { action_id: string; tool: string; state: string }[])
      .map(r => ({ actionId: r.action_id, tool: r.tool, state: r.state }));
  } catch {
    return [];
  }
}

/**
 * Interrupted top-level runs still awaiting a decision, newest first. Child
 * runs (parent_run_id set) are covered by their parent. Only the last
 * `maxAgeDays` are offered so an ancient crash doesn't nag forever.
 */
export function listInterruptedRuns(db: SqlDb, opts: { maxAgeDays?: number; limit?: number } = {}): InterruptedRun[] {
  const since = Math.floor(Date.now() / 1000) - (opts.maxAgeDays ?? 7) * 86400;
  const rows = db.prepare(
    `SELECT r.run_id, r.session_id, r.goal, r.created_at,
            (SELECT MAX(idx) FROM agent_steps s WHERE s.run_id = r.run_id) AS last_idx,
            cs.origin AS origin
       FROM agent_runs r
       LEFT JOIN chat_sessions cs ON cs.session_id = r.session_id
      WHERE r.run_outcome = 'interrupted' AND r.resume_state IS NULL
        AND r.parent_run_id IS NULL AND r.created_at >= ?
      ORDER BY r.created_at DESC LIMIT ?`
  ).all(since, opts.limit ?? 10) as {
    run_id: string; session_id: string; goal: string; created_at: number; last_idx: number | null; origin: string | null;
  }[];
  return rows.map(r => ({
    runId: r.run_id,
    sessionId: r.session_id,
    goal: r.goal,
    createdAt: Number(r.created_at),
    lastStepIdx: r.last_idx == null ? -1 : Number(r.last_idx),
    unattended: r.origin === 'scheduled',
    confirmedActions: confirmedActionsForRun(db, r.run_id),
  }));
}

/** Fetch one still-offered interrupted run by id (null if handled/unknown). */
export function getInterruptedRun(db: SqlDb, runId: string): InterruptedRun | null {
  return listInterruptedRuns(db, { maxAgeDays: 3650, limit: 1000 }).find(r => r.runId === runId) ?? null;
}

/** Record the user's decision so the offer is not shown again. Returns false
 *  when the run was already handled (double-click / two windows). */
export function markInterruptedRun(db: SqlDb, runId: string, state: 'dismissed' | 'resumed'): boolean {
  const r = db.prepare(
    `UPDATE agent_runs SET resume_state=? WHERE run_id=? AND run_outcome='interrupted' AND resume_state IS NULL`
  ).run(state, runId);
  return Number(r.changes) > 0;
}

/** The continuation prompt sent into the same session on Resume. */
export function buildResumePrompt(run: Pick<InterruptedRun, 'goal' | 'lastStepIdx' | 'confirmedActions'>): string {
  const step = Math.max(0, run.lastStepIdx);
  const lines = [
    `The app restarted at step ${step} of the task below; continue it from where it stopped.`,
    `Original task: ${run.goal}`,
    'First check the current state (files, results) instead of assuming earlier steps finished.',
  ];
  // Always present: the rule holds even when the list is empty, because an
  // action could have been confirmed by another path the model can't see.
  lines.push('Do NOT repeat actions already confirmed in external_actions.');
  if (run.confirmedActions.length) {
    lines.push(
      'These were already performed (or attempted with an unknown outcome) before the restart ' +
      'and must not be done again: ' +
      run.confirmedActions.map(a => `${a.tool} [${a.actionId}, ${a.state}]`).join('; ') + '.',
    );
  } else {
    lines.push('No external actions (such as sent emails) were recorded before the restart.');
  }
  return lines.join('\n');
}
