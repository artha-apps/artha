/**
 * Goals + stop gate, against a REAL SQLite database.
 *
 * better-sqlite3 is built for Electron and can't load under vitest, so these
 * tests use Node's built-in `node:sqlite` (same prepare/run/get/all surface)
 * and the exact DDL from db/schema.ts — extracted from the source text, so a
 * schema change that breaks goals breaks these tests too.
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DatabaseSync } from 'node:sqlite';
import {
  createGoal, getOpenGoal, getGoal, modelUpdateGoal, userSetGoalStatus,
  markGoalCompletedByEvaluator, goalElapsedMs, userStatedOutcome, GoalError, type GoalsDb,
} from './goals';
import { applyStopGate, evaluateGoal, type GoalVerdict } from './goalEvaluator';
import { deriveDelegateOutcome } from './delegateOutcome';
import { persistRunFacts } from './runFacts';

const SCHEMA = fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.ts'), 'utf8');

/** Pull one `CREATE TABLE IF NOT EXISTS <name> (...)` statement out of schema.ts. */
function ddl(table: string): string {
  const m = SCHEMA.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\([\\s\\S]*?\\n    \\);`));
  if (!m) throw new Error(`table ${table} not found in schema.ts`);
  return m[0];
}

/** Open (or reopen) a database file with every table the goal path touches. */
function openDb(file: string): DatabaseSync {
  const db = new DatabaseSync(file);
  for (const t of ['goals', 'agent_runs', 'agent_tasks', 'task_acceptance_criteria', 'task_evidence', 'external_actions']) {
    db.exec(ddl(t));
  }
  // agent_runs' evidence columns are added by runMigrations(); mirror them here.
  const cols = (db.prepare(`PRAGMA table_info(agent_runs)`).all() as { name: string }[]).map(c => c.name);
  for (const [c, d] of [['task_id', 'TEXT'], ['run_outcome', 'TEXT'], ['tool_calls_total', 'INTEGER'],
    ['tool_calls_failed', 'INTEGER'], ['tool_calls_blocked', 'INTEGER'], ['mutations_total', 'INTEGER'],
    ['mutations_failed', 'INTEGER'], ['error_detail', 'TEXT'], ['finished_at', 'INTEGER']]) {
    if (!cols.includes(c)) db.exec(`ALTER TABLE agent_runs ADD COLUMN ${c} ${d}`);
  }
  return db;
}

const asDb = (d: DatabaseSync) => d as unknown as GoalsDb;
const tmpFiles: string[] = [];
function tmpDbFile(): string {
  const f = path.join(os.tmpdir(), `artha-goals-${process.pid}-${Math.random().toString(16).slice(2)}.db`);
  tmpFiles.push(f);
  return f;
}
afterEach(() => {
  for (const f of tmpFiles.splice(0)) for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(f + s); } catch { /* gone */ } }
});

function freshGoal(db: GoalsDb, now = 1_000) {
  return createGoal(db, { sessionId: 's1', objective: 'Write the Q3 report', condition: 'q3.pdf exists with a revenue table', now, newId: () => 'g1' });
}

describe('goals — model cannot complete', () => {
  it('goal_update rejects completed and terminated with a clear error', () => {
    const db = asDb(openDb(':memory:'));
    freshGoal(db);
    expect(() => modelUpdateGoal(db, 's1', { status: 'completed', reason: 'done' })).toThrow(GoalError);
    expect(() => modelUpdateGoal(db, 's1', { status: 'completed', reason: 'done' })).toThrow(/cannot mark a goal completed/);
    expect(() => modelUpdateGoal(db, 's1', { status: 'terminated', reason: 'x' })).toThrow(/only the user/);
    expect(() => modelUpdateGoal(db, 's1', { status: 'active', reason: 'x' })).toThrow(/blocked" or "paused/);
    expect(getOpenGoal(db, 's1')!.status).toBe('active');
  });

  it('goal_update can block with a reason, and needs one', () => {
    const db = asDb(openDb(':memory:'));
    freshGoal(db);
    expect(() => modelUpdateGoal(db, 's1', { status: 'blocked', reason: '  ' })).toThrow(/reason/);
    const g = modelUpdateGoal(db, 's1', { status: 'blocked', reason: 'Need the Q3 export file' }, 2_000);
    expect(g.status).toBe('blocked');
    expect(g.blockedReason).toBe('Need the Q3 export file');
  });

  it('the user cannot set completed either; only a met verdict completes', () => {
    const db = asDb(openDb(':memory:'));
    freshGoal(db);
    expect(() => userSetGoalStatus(db, 'g1', 'completed')).toThrow(GoalError);
    expect(() => markGoalCompletedByEvaluator(db, 'g1', { verdict: 'unknown' })).toThrow(/met/);
    expect(() => markGoalCompletedByEvaluator(db, 'g1', { verdict: 'unmet' })).toThrow(/met/);
    expect(markGoalCompletedByEvaluator(db, 'g1', { verdict: 'met' }).status).toBe('completed');
  });

  it('the DB CHECK constraint rejects an unknown status', () => {
    const db = openDb(':memory:');
    freshGoal(asDb(db));
    expect(() => db.prepare(`UPDATE goals SET status='done' WHERE goal_id='g1'`).run()).toThrow();
  });

  it('a finished goal is frozen, and a session holds one open goal at a time', () => {
    const db = asDb(openDb(':memory:'));
    freshGoal(db);
    expect(() => createGoal(db, { sessionId: 's1', objective: 'easier', condition: 'nothing' })).toThrow(/already has a goal/);
    userSetGoalStatus(db, 'g1', 'terminated');
    expect(() => userSetGoalStatus(db, 'g1', 'active')).toThrow(/terminated/);
    expect(getOpenGoal(db, 's1')).toBeNull();
    expect(createGoal(db, { sessionId: 's1', objective: 'next', condition: 'next.txt exists', newId: () => 'g2' }).status).toBe('active');
  });

  it('accumulates active time only while active', () => {
    const db = asDb(openDb(':memory:'));
    freshGoal(db, 1_000);
    userSetGoalStatus(db, 'g1', 'paused', 4_000);       // +3000 active
    userSetGoalStatus(db, 'g1', 'active', 10_000);      // paused gap not counted
    const g = getGoal(db, 'g1')!;
    expect(g.activeMs).toBe(3_000);
    expect(goalElapsedMs(g, 12_000)).toBe(5_000);
  });
});

describe('goals — persistence', () => {
  it('a goal survives closing and reopening the database', () => {
    const file = tmpDbFile();
    const db1 = openDb(file);
    freshGoal(asDb(db1));
    modelUpdateGoal(asDb(db1), 's1', { status: 'paused', reason: 'waiting on data' }, 5_000);
    db1.close();

    const db2 = openDb(file); // CREATE TABLE IF NOT EXISTS must not clobber it
    const g = getOpenGoal(asDb(db2), 's1');
    expect(g).not.toBeNull();
    expect(g!.objective).toBe('Write the Q3 report');
    expect(g!.status).toBe('paused');
    expect(g!.blockedReason).toBe('waiting on data');
    expect(g!.activeMs).toBe(4_000);
    db2.close();
  });
});

describe('goal_set approval rule', () => {
  it('skips approval only when the user stated the outcome', () => {
    const msg = 'Create q3.pdf in Documents with a revenue table for the Q3 report';
    expect(userStatedOutcome(msg, 'Create the Q3 report', 'q3.pdf exists with a revenue table')).toBe(true);
    expect(userStatedOutcome(msg, 'Email the board', 'board receives slides by Friday')).toBe(false);
    expect(userStatedOutcome('do it', '', '')).toBe(false);
  });
});

describe('stop gate', () => {
  /** A run row the gate can anchor its task/evidence to. */
  function seedRun(db: DatabaseSync, runId = 'r1') {
    db.prepare(`INSERT INTO agent_runs (run_id, session_id, workflow_id, goal) VALUES (?, 's1', 'w1', 'Write the Q3 report')`).run(runId);
  }
  const unmet: GoalVerdict = { verdict: 'unmet', gaps: ['q3.pdf has no revenue table'], evidence_refs: [], source: 'judge' };

  it('continues with gaps as feedback twice, then ends needs-review listing the gaps', () => {
    const raw = openDb(':memory:');
    const db = asDb(raw);
    seedRun(raw);
    let goal = freshGoal(db);
    const base = { runId: 'r1', sessionId: 's1', objective: goal.objective };

    const r1 = applyStopGate(db, { ...base, goal, verdict: unmet, roundsUsed: 0 });
    expect(r1.action).toBe('continue');
    expect(r1.feedback).toContain('q3.pdf has no revenue table');
    expect(r1.feedback).toContain('attempt 1 of 2');
    goal = r1.goal!;
    expect(goal.status).toBe('active');

    const r2 = applyStopGate(db, { ...base, goal, verdict: unmet, roundsUsed: 1 });
    expect(r2.action).toBe('continue');
    goal = r2.goal!;

    const r3 = applyStopGate(db, { ...base, goal, verdict: unmet, roundsUsed: 2 });
    expect(r3.action).toBe('needs_review');
    expect(r3.goal!.status).toBe('blocked');
    expect(r3.goal!.blockedReason).toMatch(/Needs you/);
    expect(r3.goal!.blockedReason).toContain('q3.pdf has no revenue table');

    // The executor finished — the projection must still say needs review, with the gap as remaining work.
    persistRunFacts(raw as never, 'r1', {
      outcome: 'succeeded', toolCallsTotal: 3, toolCallsFailed: 0, toolCallsBlocked: 0, mutationsTotal: 1, mutationsFailed: 0,
    });
    const outcome = deriveDelegateOutcome(raw as never, 'r1');
    expect(outcome.uiStatus).toBe('needs_review');
    expect(outcome.isComplete).toBe(false);
    expect(outcome.remainingWork.join(' ')).toContain('q3.pdf has no revenue table');
  });

  it('records a false_completion_attempt every time the run tries to finish unmet', () => {
    const raw = openDb(':memory:');
    const db = asDb(raw);
    seedRun(raw);
    const goal = freshGoal(db);
    applyStopGate(db, { goal, verdict: unmet, roundsUsed: 0, runId: 'r1', sessionId: 's1', objective: goal.objective });
    const unknown: GoalVerdict = { verdict: 'unknown', gaps: ['unreadable'], evidence_refs: [], source: 'judge' };
    const r = applyStopGate(db, { goal: getGoal(db, 'g1')!, verdict: unknown, roundsUsed: 1, runId: 'r1', sessionId: 's1', objective: goal.objective });
    expect(r.action).toBe('needs_review'); // unknown never loops and never completes
    expect(getGoal(db, 'g1')!.status).toBe('active');

    const rows = raw.prepare(`SELECT kind, status, task_id FROM task_evidence WHERE run_id='r1' ORDER BY rowid`).all() as
      { kind: string; status: string; task_id: string }[];
    expect(rows.map(x => [x.kind, x.status])).toEqual([
      ['false_completion_attempt', 'failed'],
      ['false_completion_attempt', 'unknown'],
    ]);
    expect(rows.every(x => !!x.task_id)).toBe(true);
  });

  it('met completes the goal with evidence and records no false completion', async () => {
    const raw = openDb(':memory:');
    const db = asDb(raw);
    seedRun(raw);
    const goal = freshGoal(db);
    const verdict = await evaluateGoal({
      objective: goal.objective, condition: goal.condition,
      runFacts: { toolCallsTotal: 1, toolCallsFailed: 0, mutationsTotal: 1, mutationsFailed: 0 },
      criteria: [{ description: 'q3.pdf was generated', outcome: 'passed', required: true }],
      evidence: [{ id: 'E1', kind: 'tool_result', status: 'succeeded', summary: 'docs_generate created q3.pdf with table Revenue' }],
    }, async () => '{"verdict":"met","gaps":[],"evidence_refs":["E1"]}');
    const r = applyStopGate(db, { goal, verdict, roundsUsed: 0, runId: 'r1', sessionId: 's1', objective: goal.objective });
    expect(r.action).toBe('complete');
    expect(getGoal(db, 'g1')!.status).toBe('completed');
    const kinds = (raw.prepare(`SELECT kind FROM task_evidence`).all() as { kind: string }[]).map(x => x.kind);
    expect(kinds).toEqual(['model_assessment']);
  });
});
