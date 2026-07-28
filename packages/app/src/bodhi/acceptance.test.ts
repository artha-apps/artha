/**
 * User-acceptance tests. The property that matters: an explicit Accept makes a
 * reviewed task reach `completed` THROUGH the evidence projection (a recorded
 * approval_granted criterion) — never a fabricated flag — and Reject neither
 * fakes a completion nor mislabels the task as a system failure.
 */
import { describe, it, expect } from 'vitest';
import { recordAcceptance, type AcceptanceDb } from './acceptance';
import { deriveDelegateOutcome, type OutcomeDb } from './delegateOutcome';

/** A DB that both records inserts (acceptance) and answers reads
 *  (deriveDelegateOutcome), so we test the WHOLE loop: accept → projection. */
function loopDb(opts: { runTaskId?: string | null; runOutcome?: string } = {}) {
  const criteria: Array<Record<string, unknown>> = [];
  const evidence: Array<Record<string, unknown>> = [];
  let taskId = opts.runTaskId ?? null;
  const run = {
    status: 'completed', run_outcome: opts.runOutcome ?? 'succeeded',
    get task_id() { return taskId; },
    tool_calls_total: 1, tool_calls_failed: 0, tool_calls_blocked: 0,
    mutations_total: 0, mutations_failed: 0, error_detail: null,
  };
  const db = {
    prepare(sql: string) {
      return {
        get: (...a: unknown[]) => {
          if (sql.includes('FROM agent_runs')) return { ...run, task_id: taskId };
          if (sql.includes('FROM task_evidence')) return { n: evidence.length };
          return undefined;
        },
        all: () => {
          if (sql.includes('task_acceptance_criteria')) {
            return criteria.map(c => ({
              kind: 'predicate', predicate: c.predicate, description: c.description,
              required: 1, outcome: c.outcome,
            }));
          }
          if (sql.includes('external_actions')) return [];
          return [];
        },
        run: (...a: unknown[]) => {
          if (sql.includes('INSERT INTO agent_tasks')) taskId = a[0] as string;
          else if (sql.includes('UPDATE agent_runs SET task_id')) taskId = a[0] as string;
          else if (sql.includes('INSERT INTO task_acceptance_criteria')) {
            // ACCEPT inserts a fixed approval_granted/passed row (no bound args).
            criteria.push({ predicate: 'approval_granted', outcome: 'passed', description: 'accepted' });
          } else if (sql.includes('INSERT INTO task_evidence')) {
            evidence.push({ status: a[2] });
          }
          return {};
        },
      };
    },
  };
  return { db: db as AcceptanceDb & OutcomeDb, criteria, evidence, currentTaskId: () => taskId };
}

describe('recordAcceptance — Accept', () => {
  it('records an approval_granted/passed criterion and evidence', () => {
    const { db, criteria, evidence } = loopDb();
    const r = recordAcceptance(db, { runId: 'run1', sessionId: 's1', goal: 'summarize the docs', decision: 'accepted', newId: () => 'task1' });
    expect(r).toMatchObject({ ok: true, decision: 'accepted', taskId: 'task1' });
    expect(criteria).toHaveLength(1);
    expect(criteria[0]).toMatchObject({ predicate: 'approval_granted', outcome: 'passed' });
    expect(evidence[0]).toMatchObject({ status: 'succeeded' });
  });

  it('a reviewed run becomes Completed — verified AFTER the user accepts (full loop)', () => {
    const ctx = loopDb();
    // Before acceptance: a finished run with no criteria → needs_review.
    expect(deriveDelegateOutcome(ctx.db, 'run1').uiStatus).toBe('needs_review');
    // User accepts.
    recordAcceptance(ctx.db, { runId: 'run1', sessionId: 's1', goal: 'g', decision: 'accepted', newId: () => 'task1' });
    // Now the projection reads the approval_granted criterion → completed.
    const after = deriveDelegateOutcome(ctx.db, 'run1');
    expect(after.uiStatus).toBe('completed');
    expect(after.isComplete).toBe(true);
    expect(after.label).toMatch(/completed/i);
  });

  it('anchors the run to a NEW task row when it had none', () => {
    const ctx = loopDb({ runTaskId: null });
    recordAcceptance(ctx.db, { runId: 'run1', sessionId: 's1', goal: 'g', decision: 'accepted', newId: () => 'newtask' });
    expect(ctx.currentTaskId()).toBe('newtask');
  });
});

describe('recordAcceptance — Reject', () => {
  it('records evidence but does NOT insert an approval criterion (no fake completion, no fake failure)', () => {
    const { db, criteria, evidence } = loopDb();
    const r = recordAcceptance(db, { runId: 'run1', sessionId: 's1', goal: 'g', decision: 'rejected', newId: () => 'task1' });
    expect(r.ok).toBe(true);
    expect(criteria).toHaveLength(0);              // no criterion → not "blocked/failed"
    expect(evidence[0]).toMatchObject({ status: 'partial' });
  });

  it('a rejected task stays needs_review (reviewable/continuable), never completed or failed', () => {
    const ctx = loopDb();
    recordAcceptance(ctx.db, { runId: 'run1', sessionId: 's1', goal: 'g', decision: 'rejected', newId: () => 'task1' });
    const after = deriveDelegateOutcome(ctx.db, 'run1');
    expect(after.uiStatus).toBe('needs_review');
    expect(after.isComplete).toBe(false);
  });
});

describe('recordAcceptance — safety', () => {
  it('never throws — a DB failure returns ok:false instead of breaking the app', () => {
    const broken = { prepare: () => { throw new Error('db gone'); } } as unknown as AcceptanceDb;
    const r = recordAcceptance(broken, { runId: 'r', sessionId: 's', goal: 'g', decision: 'accepted' });
    expect(r.ok).toBe(false);
    expect(r.error).toBeTruthy();
  });
});
