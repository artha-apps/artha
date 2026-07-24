/**
 * Acceptance-criteria tests.
 *
 * The property that matters: a run earns "verified" ONLY when its concrete
 * claims survive a reality check. A run that says it generated report.pdf when
 * report.pdf does not exist must FAIL — that is the false-completion class this
 * whole effort exists to kill.
 */
import { describe, it, expect } from 'vitest';
import {
  deriveCriteriaFromMutations,
  evaluateCriterion,
  recordAcceptanceCriteria,
  extractDocsPath,
  MAX_BATCH_CRITERIA,
  type MutationLike,
  type CriteriaDb,
} from './criteria';

const ok = (tool: string, args: Record<string, unknown>, result = '{}'): MutationLike =>
  ({ tool, args, result, success: true });

/** The REAL docs_generate result is human-readable text, not JSON. Using the
 *  actual format here — an invented JSON fixture would hide a parser bug. */
const REAL_DOCS_RESULT =
  'Created report.pdf (PDF) at /Users/x/Documents/report.pdf. ' +
  '3 provenance-anchored section(s); receipt written to report.receipt.json. The file has been opened.';

describe('extractDocsPath (real docs_generate text format)', () => {
  it('parses the path out of the human-readable result', () => {
    expect(extractDocsPath(REAL_DOCS_RESULT)).toBe('/Users/x/Documents/report.pdf');
  });

  it('handles a path containing dots', () => {
    expect(extractDocsPath('Created a.b.pdf (PDF) at /Users/x/v1.2/a.b.pdf. The file has been opened.'))
      .toBe('/Users/x/v1.2/a.b.pdf');
  });

  it('still accepts a JSON result (future-proof)', () => {
    expect(extractDocsPath(JSON.stringify({ outPath: '/a/b.pdf' }))).toBe('/a/b.pdf');
  });

  it('returns null when no path is claimed — no bogus criterion', () => {
    expect(extractDocsPath('Something went wrong.')).toBeNull();
  });
});

describe('deriveCriteriaFromMutations', () => {
  it('turns a generated document into an artifact_exists check on its real path', () => {
    const d = deriveCriteriaFromMutations([ok('docs_generate', {}, REAL_DOCS_RESULT)]);
    expect(d).toHaveLength(1);
    expect(d[0].predicate).toBe('artifact_exists');
    expect(d[0].target).toBe('/Users/x/Documents/report.pdf');
    expect(d[0].description).toContain('report.pdf');   // basename only, no full path
    expect(d[0].description).not.toContain('/Users');
  });

  it('turns file moves/copies/dirs into file_exists checks on their destinations', () => {
    const d = deriveCriteriaFromMutations([
      ok('fs_move_file', { destination: '/a/moved.txt' }),
      ok('fs_copy_file', { destination: '/a/copied.txt' }),
      ok('fs_create_directory', { path: '/a/newdir' }),
    ]);
    expect(d.map(c => c.target)).toEqual(['/a/moved.txt', '/a/copied.txt', '/a/newdir']);
    expect(d.every(c => c.predicate === 'file_exists')).toBe(true);
  });

  it('ignores FAILED mutations — a failed tool asserted nothing to verify', () => {
    expect(deriveCriteriaFromMutations([
      { tool: 'fs_move_file', args: { destination: '/a/x.txt' }, result: 'Error: nope', success: false },
    ])).toEqual([]);
  });

  it('produces NO criteria for non-filesystem work (research/summary) → review, not false green', () => {
    expect(deriveCriteriaFromMutations([
      ok('web_search', { query: 'x' }), ok('email_compose', { to: 'a@b.com' }),
    ])).toEqual([]);
  });

  it('dedupes repeated destinations', () => {
    const d = deriveCriteriaFromMutations([
      ok('fs_move_file', { destination: '/a/same.txt' }),
      ok('fs_copy_file', { destination: '/a/same.txt' }),
    ]);
    expect(d).toHaveLength(1);
  });

  it('bounds a huge batch to MAX_BATCH_CRITERIA', () => {
    const moves = Array.from({ length: 100 }, (_, i) => ({ source: `/s/${i}`, destination: `/d/${i}.txt` }));
    expect(deriveCriteriaFromMutations([ok('fs_move_batch', { moves })])).toHaveLength(MAX_BATCH_CRITERIA);
  });
});

describe('evaluateCriterion — reality check', () => {
  const draft = { predicate: 'file_exists' as const, description: 'x', required: true, target: '/a/x.txt' };

  it('passes when the file really exists', () => {
    expect(evaluateCriterion(draft, () => true)).toBe('passed');
  });

  it('FAILS when the claimed file does not exist (the false-completion killer)', () => {
    expect(evaluateCriterion(draft, () => false)).toBe('failed');
  });

  it('is indeterminate — never "passed" — when the check itself throws', () => {
    expect(evaluateCriterion(draft, () => { throw new Error('EACCES'); })).toBe('indeterminate');
  });
});

/** Capture-all fake DB. */
function fakeDb(existingTaskId: string | null = null) {
  const calls: { sql: string; args: unknown[] }[] = [];
  const db: CriteriaDb = {
    prepare: (sql: string) => ({
      run: (...args: unknown[]) => { calls.push({ sql, args }); return {}; },
      get: () => (sql.includes('FROM agent_runs') ? { task_id: existingTaskId } : undefined),
    }),
  };
  return { db, calls };
}

describe('recordAcceptanceCriteria', () => {
  const mutations = [ok('docs_generate', {}, 'Created report.pdf (PDF) at /a/report.pdf. The file has been opened.')];

  it('folds in authoritative artifact paths from the artifacts table', () => {
    const { db } = fakeDb('t');
    const r = recordAcceptanceCriteria(db, {
      runId: 'r', sessionId: 's', goal: 'g',
      mutations: [], exists: () => true,
      artifactPaths: ['/a/from-artifacts.pdf'],
    });
    expect(r).toMatchObject({ recorded: 1, passed: 1 });
  });

  it('dedupes an artifact path already derived from the tool result', () => {
    const { db } = fakeDb('t');
    const r = recordAcceptanceCriteria(db, {
      runId: 'r', sessionId: 's', goal: 'g',
      mutations, exists: () => true,
      artifactPaths: ['/a/report.pdf'],   // same file, must not double-count
    });
    expect(r.recorded).toBe(1);
  });

  it('creates a task anchor, links the run, and records a PASSED criterion when the file exists', () => {
    const { db, calls } = fakeDb(null);
    const r = recordAcceptanceCriteria(db, {
      runId: 'run1', sessionId: 's1', goal: 'make a report', mutations,
      exists: () => true, newId: () => 'task1',
    });
    expect(r).toMatchObject({ taskId: 'task1', recorded: 1, passed: 1, failed: 0 });
    expect(calls.some(c => c.sql.includes('INSERT INTO agent_tasks'))).toBe(true);
    expect(calls.some(c => c.sql.includes('UPDATE agent_runs SET task_id'))).toBe(true);
    expect(calls.some(c => c.sql.includes('INSERT INTO task_acceptance_criteria'))).toBe(true);
  });

  it('records a FAILED criterion when the claimed file is missing', () => {
    const { db } = fakeDb('existing-task');
    const r = recordAcceptanceCriteria(db, {
      runId: 'run1', sessionId: 's1', goal: 'make a report', mutations, exists: () => false,
    });
    expect(r).toMatchObject({ recorded: 1, passed: 0, failed: 1, taskId: 'existing-task' });
  });

  it('records nothing when there is no checkable claim (stays user-review)', () => {
    const { db, calls } = fakeDb(null);
    const r = recordAcceptanceCriteria(db, {
      runId: 'run1', sessionId: 's1', goal: 'research X', mutations: [ok('web_search', {})], exists: () => true,
    });
    expect(r.recorded).toBe(0);
    expect(calls.some(c => c.sql.includes('INSERT INTO task_acceptance_criteria'))).toBe(false);
  });

  it('reports how many batch destinations went unverified (cap is never silent)', () => {
    const moves = Array.from({ length: 40 }, (_, i) => ({ source: `/s/${i}`, destination: `/d/${i}` }));
    const { db } = fakeDb('t');
    const r = recordAcceptanceCriteria(db, {
      runId: 'r', sessionId: 's', goal: 'move files', mutations: [ok('fs_move_batch', { moves })], exists: () => true,
    });
    expect(r.recorded).toBe(MAX_BATCH_CRITERIA);
    expect(r.truncated).toBe(40 - MAX_BATCH_CRITERIA);
  });

  it('never throws — a DB failure degrades to "no criteria", not a broken run', () => {
    const broken: CriteriaDb = { prepare: () => { throw new Error('db gone'); } };
    expect(() => recordAcceptanceCriteria(broken, {
      runId: 'r', sessionId: 's', goal: 'g', mutations, exists: () => true,
    })).not.toThrow();
  });
});
