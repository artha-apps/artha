/**
 * Per-run evidence read — the "show me why it's verified" data.
 *
 * Phase A.5 requires the completion-evidence record to be INSPECTABLE, not just
 * a green label. This assembles, for a run, the acceptance criteria (what was
 * checked and whether it passed) and the evidence rows (tool results, receipts,
 * artifacts) — sanitized, human-readable, no raw payloads. Pure w.r.t. an
 * injected db; never throws.
 */

export interface EvidenceDb {
  prepare(sql: string): { get(...a: unknown[]): unknown; all(...a: unknown[]): unknown[] };
}

export interface CriterionView {
  description: string;
  /** passed | failed | indeterminate | awaiting_user_review | not_evaluated */
  outcome: string;
  predicate: string | null;
  required: boolean;
}
export interface EvidenceView {
  /** tool_result | file | artifact | external_action | test | receipt | model_assessment */
  kind: string;
  /** succeeded | failed | partial | unknown */
  status: string;
  summary: string;
}
export interface RunEvidence {
  criteria: CriterionView[];
  evidence: EvidenceView[];
  /** True when there is nothing machine-checkable — the honest "review" case. */
  empty: boolean;
}

export function readRunEvidence(db: EvidenceDb, runId: string): RunEvidence {
  const empty: RunEvidence = { criteria: [], evidence: [], empty: true };
  try {
    const run = db.prepare(`SELECT task_id FROM agent_runs WHERE run_id=?`).get(runId) as
      { task_id: string | null } | undefined;
    if (!run?.task_id) return empty;

    const criteria = (db.prepare(
      `SELECT description, outcome, predicate, required
         FROM task_acceptance_criteria WHERE task_id=? ORDER BY rowid ASC`
    ).all(run.task_id) as Array<{ description: string; outcome: string; predicate: string | null; required: number }>)
      .map(c => ({ description: c.description, outcome: c.outcome, predicate: c.predicate, required: !!c.required }));

    const evidence = (db.prepare(
      `SELECT kind, status, summary FROM task_evidence
        WHERE task_id=? OR run_id=? ORDER BY rowid ASC`
    ).all(run.task_id, runId) as Array<{ kind: string; status: string; summary: string | null }>)
      .map(e => ({ kind: e.kind, status: e.status, summary: e.summary ?? '' }));

    return { criteria, evidence, empty: criteria.length === 0 && evidence.length === 0 };
  } catch {
    return empty;
  }
}
