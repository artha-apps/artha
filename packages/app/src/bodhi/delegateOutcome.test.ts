/**
 * Honest-projection tests. Pins the mapping from what a run persisted to what
 * the user is shown — the whole point of Phase A.5: no green "completed" without
 * evidence, no red "failed" for a finished-but-unverified task, no collapsing
 * partial/interrupted into completed.
 */
import { describe, it, expect } from 'vitest';
import { deriveDelegateOutcome, type OutcomeDb } from './delegateOutcome';

/** Build a fake DB from a run row + optional external actions / criteria / evidence. */
function fakeDb(opts: {
  run?: Record<string, unknown> | undefined;
  extStates?: string[];
  criteria?: Array<Record<string, unknown>>;
  evidence?: number;
}): OutcomeDb {
  return {
    prepare(sql: string) {
      return {
        get: () => {
          if (sql.includes('FROM agent_runs')) return opts.run;
          if (sql.includes('FROM task_evidence')) return { n: opts.evidence ?? 0 };
          return undefined;
        },
        all: () => {
          if (sql.includes('FROM external_actions')) return (opts.extStates ?? []).map(s => ({ state: s }));
          if (sql.includes('FROM task_acceptance_criteria')) return opts.criteria ?? [];
          return [];
        },
      };
    },
  };
}

const succeededRun = { status: 'completed', run_outcome: 'succeeded', task_id: null, tool_calls_total: 2, tool_calls_failed: 0, tool_calls_blocked: 0, mutations_total: 1, mutations_failed: 0, error_detail: null };

describe('deriveDelegateOutcome', () => {
  it('a CONFIRMED consequential action (e.g. sent email) → Completed/verified', () => {
    const o = deriveDelegateOutcome(fakeDb({ run: succeededRun, extStates: ['confirmed'] }), 'r');
    expect(o.uiStatus).toBe('completed');
    expect(o.isComplete).toBe(true);
    expect(o.label).toMatch(/completed/i);
  });

  it('a finished run with no machine-checkable criteria → Ready for your review (NOT a green completed)', () => {
    const o = deriveDelegateOutcome(fakeDb({ run: succeededRun, evidence: 1 }), 'r');
    expect(o.uiStatus).toBe('needs_review');
    expect(o.isComplete).toBe(false);
    expect(o.label).toMatch(/review/i);
  });

  it('a failed run → Failed', () => {
    const o = deriveDelegateOutcome(fakeDb({ run: { ...succeededRun, status: 'failed', run_outcome: 'failed', error_detail: 'email_not_sent' } }), 'r');
    expect(o.uiStatus).toBe('failed');
    expect(o.message).toMatch(/failed|email_not_sent/i);
  });

  it('an interrupted run → needs_review, "not verified" (never completed)', () => {
    const o = deriveDelegateOutcome(fakeDb({ run: { ...succeededRun, run_outcome: 'interrupted' } }), 'r');
    expect(o.uiStatus).toBe('needs_review');
    expect(o.isComplete).toBe(false);
    expect(o.message).toMatch(/not verified|interrupted/i);
  });

  it('an outcome_unknown external action blocks completion', () => {
    const o = deriveDelegateOutcome(fakeDb({ run: succeededRun, extStates: ['outcome_unknown'] }), 'r');
    expect(o.uiStatus).toBe('needs_review');
    expect(o.isComplete).toBe(false);
  });

  it('a still-running run → running', () => {
    const o = deriveDelegateOutcome(fakeDb({ run: { ...succeededRun, status: 'running', run_outcome: 'running' } }), 'r');
    expect(o.uiStatus).toBe('running');
  });

  it('no run row yet → not completed', () => {
    const o = deriveDelegateOutcome(fakeDb({ run: undefined }), 'r');
    expect(o.isComplete).toBe(false);
    expect(o.uiStatus).not.toBe('completed');
  });

  it('a legacy run (no run_outcome) is never silently called verified', () => {
    const o = deriveDelegateOutcome(fakeDb({ run: { status: 'completed', run_outcome: null, task_id: null } }), 'r');
    expect(o.isComplete).toBe(false);
    expect(o.verification).toBe('unknown_legacy');
    expect(o.uiStatus).toBe('needs_review');
  });

  it('real predicate criteria that passed → Completed/verified', () => {
    const o = deriveDelegateOutcome(fakeDb({
      run: { ...succeededRun, task_id: 't1' },
      criteria: [{ kind: 'predicate', predicate: 'file_exists', description: 'report.pdf exists', required: 1, outcome: 'passed' }],
    }), 'r');
    expect(o.uiStatus).toBe('completed');
    expect(o.isComplete).toBe(true);
  });

  it('a required predicate that FAILED → blocked, not completed', () => {
    const o = deriveDelegateOutcome(fakeDb({
      run: { ...succeededRun, task_id: 't1' },
      criteria: [{ kind: 'predicate', predicate: 'file_exists', description: 'report.pdf exists', required: 1, outcome: 'failed' }],
    }), 'r');
    expect(o.isComplete).toBe(false);
    expect(o.uiStatus).toBe('needs_review'); // blocked → needs attention, never completed
    expect(o.label).toMatch(/check failed|blocked/i);
  });
});
