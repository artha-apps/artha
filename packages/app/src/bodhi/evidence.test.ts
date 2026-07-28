import { describe, it, expect } from 'vitest';
import { readRunEvidence, type EvidenceDb } from './evidence';

function db(opts: { taskId?: string | null; criteria?: unknown[]; evidence?: unknown[] }): EvidenceDb {
  return {
    prepare(sql: string) {
      return {
        get: () => (sql.includes('FROM agent_runs') ? { task_id: opts.taskId ?? null } : undefined),
        all: () => {
          if (sql.includes('task_acceptance_criteria')) return opts.criteria ?? [];
          if (sql.includes('task_evidence')) return opts.evidence ?? [];
          return [];
        },
      };
    },
  };
}

describe('readRunEvidence', () => {
  it('returns criteria + evidence for a run with a task', () => {
    const r = readRunEvidence(db({
      taskId: 't1',
      criteria: [{ description: 'report.pdf was generated', outcome: 'passed', predicate: 'artifact_exists', required: 1 }],
      evidence: [{ kind: 'tool_result', status: 'succeeded', summary: 'docs_generate succeeded' }],
    }), 'run1');
    expect(r.empty).toBe(false);
    expect(r.criteria[0]).toMatchObject({ outcome: 'passed', predicate: 'artifact_exists', required: true });
    expect(r.evidence[0]).toMatchObject({ kind: 'tool_result', status: 'succeeded' });
  });

  it('is empty (honest "nothing machine-checkable") when the run has no task', () => {
    expect(readRunEvidence(db({ taskId: null }), 'run1')).toMatchObject({ empty: true, criteria: [], evidence: [] });
  });

  it('surfaces a FAILED criterion so the user sees why it is not verified', () => {
    const r = readRunEvidence(db({
      taskId: 't1',
      criteria: [{ description: 'report.pdf was generated', outcome: 'failed', predicate: 'artifact_exists', required: 1 }],
    }), 'run1');
    expect(r.criteria[0].outcome).toBe('failed');
    expect(r.empty).toBe(false);
  });

  it('never throws — a DB failure degrades to empty', () => {
    const broken = { prepare: () => { throw new Error('x'); } } as unknown as EvidenceDb;
    expect(readRunEvidence(broken, 'r')).toMatchObject({ empty: true });
  });
});
