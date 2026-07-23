/**
 * Phase A.5 — persist the execution facts the ReAct loop already computes.
 *
 * Before this, `toolCallsTotal`, `toolCallErrors` and `mutations[]` were
 * calculated during a run, used for one sentence of prose, and then thrown
 * away when the function returned (evidence audit E2/E3). A completion
 * validator cannot exist without them, and neither can an honest scheduler
 * notification: both need to know what actually happened, not merely that the
 * executor stopped.
 *
 * Every terminal path in `runReactLoop` calls `persistRunFacts` exactly once.
 * Writes are best-effort and never throw — losing a statistic must never take
 * down a run that otherwise completed.
 */
import type { RunOutcome } from './taskModel';

/** Minimal DB surface (keeps this unit-testable without better-sqlite3). */
export interface RunFactsDb {
  prepare(sql: string): { run(...args: unknown[]): unknown };
}

export interface RunFactsInput {
  outcome: RunOutcome;
  toolCallsTotal: number;
  toolCallsFailed: number;
  toolCallsBlocked: number;
  mutationsTotal: number;
  mutationsFailed: number;
  /** Terminal reason — 'stall' | 'max_iterations' | 'llm_error' | 'cancelled' | … */
  errorDetail?: string | null;
}

/**
 * Write one run's evidence tallies + outcome. Idempotent per run: calling it
 * twice with the same facts is harmless, and the LAST terminal path wins
 * (there is exactly one per run).
 */
export function persistRunFacts(db: RunFactsDb, runId: string, f: RunFactsInput): void {
  if (!runId) return;
  try {
    db.prepare(
      `UPDATE agent_runs
          SET run_outcome=?, tool_calls_total=?, tool_calls_failed=?,
              tool_calls_blocked=?, mutations_total=?, mutations_failed=?,
              error_detail=?, finished_at=unixepoch()
        WHERE run_id=?`
    ).run(
      f.outcome,
      f.toolCallsTotal,
      f.toolCallsFailed,
      f.toolCallsBlocked,
      f.mutationsTotal,
      f.mutationsFailed,
      f.errorDetail ?? null,
      runId,
    );
  } catch (err) {
    // Never let bookkeeping break a run.
    console.warn('[Artha] persistRunFacts failed for run', runId, (err as Error)?.name ?? 'Error');
  }
}

/** Sanitized evidence record. References + short summaries only — never
 *  secrets, never raw tool payloads (threat model §3). */
export interface EvidenceInput {
  taskId?: string | null;
  runId: string;
  criterionId?: string | null;
  kind: 'tool_result' | 'file' | 'artifact' | 'external_action' | 'test' | 'receipt' | 'model_assessment';
  ref?: string | null;
  status: 'succeeded' | 'failed' | 'partial' | 'unknown';
  summary?: string | null;
}

const MAX_SUMMARY = 300;

/** Record one piece of evidence. Best-effort; truncates summaries. */
export function recordEvidence(db: RunFactsDb, e: EvidenceInput): void {
  try {
    db.prepare(
      `INSERT INTO task_evidence (task_id, run_id, criterion_id, kind, ref, status, summary)
       VALUES (?,?,?,?,?,?,?)`
    ).run(
      e.taskId ?? null,
      e.runId,
      e.criterionId ?? null,
      e.kind,
      e.ref ?? null,
      e.status,
      e.summary ? e.summary.slice(0, MAX_SUMMARY) : null,
    );
  } catch (err) {
    console.warn('[Artha] recordEvidence failed:', (err as Error)?.name ?? 'Error');
  }
}
