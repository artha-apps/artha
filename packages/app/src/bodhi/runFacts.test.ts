/**
 * Evidence-preservation tests (Phase A.5 commit 2).
 *
 * The audit found `toolCallsTotal`, `toolCallErrors` and `mutations[]` were
 * computed during every run and discarded at the end. These tests pin the
 * contract that they are now persisted, that bookkeeping can never break a
 * run, and that evidence records never carry raw payloads.
 */
import { describe, it, expect, vi } from 'vitest';
import { persistRunFacts, recordEvidence, type RunFactsDb } from './runFacts';

function captureDb() {
  const calls: { sql: string; args: unknown[] }[] = [];
  const db: RunFactsDb = {
    prepare: (sql: string) => ({ run: (...args: unknown[]) => { calls.push({ sql, args }); return {}; } }),
  };
  return { db, calls };
}

describe('persistRunFacts', () => {
  it('writes outcome and every tally to the run row', () => {
    const { db, calls } = captureDb();
    persistRunFacts(db, 'run-1', {
      outcome: 'succeeded', toolCallsTotal: 5, toolCallsFailed: 2,
      toolCallsBlocked: 1, mutationsTotal: 3, mutationsFailed: 1, errorDetail: null,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].sql).toMatch(/UPDATE agent_runs/);
    expect(calls[0].sql).toMatch(/finished_at=unixepoch\(\)/);
    expect(calls[0].args).toEqual(['succeeded', 5, 2, 1, 3, 1, null, 'run-1']);
  });

  it('distinguishes the outcomes the old single status could not express', () => {
    for (const outcome of ['succeeded', 'failed', 'timed_out', 'cancelled', 'interrupted'] as const) {
      const { db, calls } = captureDb();
      persistRunFacts(db, 'r', {
        outcome, toolCallsTotal: 0, toolCallsFailed: 0, toolCallsBlocked: 0,
        mutationsTotal: 0, mutationsFailed: 0,
      });
      expect(calls[0].args[0]).toBe(outcome);
    }
  });

  it('never throws — bookkeeping must not break a run that otherwise finished', () => {
    const db: RunFactsDb = { prepare: () => ({ run: () => { throw new Error('disk full'); } }) };
    expect(() => persistRunFacts(db, 'r', {
      outcome: 'succeeded', toolCallsTotal: 1, toolCallsFailed: 0, toolCallsBlocked: 0,
      mutationsTotal: 0, mutationsFailed: 0,
    })).not.toThrow();
  });

  it('is a no-op without a run id', () => {
    const { db, calls } = captureDb();
    persistRunFacts(db, '', {
      outcome: 'succeeded', toolCallsTotal: 0, toolCallsFailed: 0, toolCallsBlocked: 0,
      mutationsTotal: 0, mutationsFailed: 0,
    });
    expect(calls).toEqual([]);
  });
});

describe('recordEvidence', () => {
  it('inserts a sanitized evidence row', () => {
    const { db, calls } = captureDb();
    recordEvidence(db, { runId: 'r1', kind: 'tool_result', ref: 'fs_move_file', status: 'failed', summary: 'fs_move_file failed' });
    expect(calls[0].sql).toMatch(/INSERT INTO task_evidence/);
    expect(calls[0].args).toEqual([null, 'r1', null, 'tool_result', 'fs_move_file', 'failed', 'fs_move_file failed']);
  });

  it('truncates long summaries so raw payloads cannot land in evidence', () => {
    const { db, calls } = captureDb();
    recordEvidence(db, { runId: 'r1', kind: 'tool_result', status: 'succeeded', summary: 'x'.repeat(5000) });
    expect((calls[0].args[6] as string).length).toBe(300);
  });

  it('never throws', () => {
    const db: RunFactsDb = { prepare: () => ({ run: () => { throw new Error('locked'); } }) };
    expect(() => recordEvidence(db, { runId: 'r', kind: 'file', status: 'unknown' })).not.toThrow();
  });
});

describe('the evidence the validator now receives', () => {
  it('a run where every tool failed is distinguishable from a clean run', () => {
    const { db, calls } = captureDb();
    persistRunFacts(db, 'bad', {
      outcome: 'succeeded', toolCallsTotal: 4, toolCallsFailed: 4, toolCallsBlocked: 0,
      mutationsTotal: 0, mutationsFailed: 0,
    });
    const [, total, failed] = calls[0].args as [string, number, number];
    // Before Phase A.5 both of these rows read identically as 'completed'.
    expect(total).toBe(4);
    expect(failed).toBe(4);
  });

  it('policy-blocked calls are counted separately from genuine failures', () => {
    const { db, calls } = captureDb();
    persistRunFacts(db, 'blocked', {
      outcome: 'succeeded', toolCallsTotal: 3, toolCallsFailed: 3, toolCallsBlocked: 3,
      mutationsTotal: 0, mutationsFailed: 0,
    });
    expect(calls[0].args[3]).toBe(3); // blocked column
  });
});
