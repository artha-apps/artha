/**
 * Resume offer — interrupted runs are listed (unattended ones flagged, none
 * auto-resumed), the continuation prompt names the restart step and forbids
 * repeats, and — the property that matters — a resumed run CANNOT re-send an
 * email the interrupted run already confirmed, even if the model rewords it.
 * Runs against a real node:sqlite database with the production durability DDL.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createRequire } from 'module';
import * as os from 'os';
import { createHash } from 'crypto';

vi.mock('electron', () => ({ app: { getPath: () => os.tmpdir() } }));

const h = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('../db/schema', async (orig) => {
  const real = await orig<typeof import('../db/schema')>();
  return { ...real, getDb: () => h.db };
});
vi.mock('../security/secretString', () => ({
  isSecretEncryptionAvailable: () => true,
  sealSecretString: (s: string) => `enc:${s}`,
  openSecretString: (s: string | null | undefined) => (s ? s.replace(/^enc:/, '') : ''),
}));
// The embedded-browser send path is unavailable under test.
vi.mock('../browser/controller', () => ({ BrowserController: { getInstance: () => ({ getWebContents: () => null }) } }));

import { applyDurabilitySchema } from '../db/schema';
import type { SqlDb } from '../db/sqlLike';
import { listInterruptedRuns, buildResumePrompt, markInterruptedRun, getInterruptedRun } from './resume';
import { runWithContext } from './runContext';
import { invokeGmailSendTool } from '../tools/gmailSend';

let db: SqlDb;
const now = () => Math.floor(Date.now() / 1000);
const hashIdentity = (to: string) => 'sha256:' + createHash('sha256').update(to.trim().toLowerCase()).digest('hex').slice(0, 16);
const fingerprint = (a: { to: string; subject: string; body: string }) =>
  createHash('sha256').update([a.to, '', '', a.subject, a.body].join(' ')).digest('hex');

beforeEach(() => {
  const { DatabaseSync } = createRequire(__filename)('node:sqlite') as { DatabaseSync: new (f: string) => SqlDb };
  db = new DatabaseSync(':memory:');
  h.db = db;
  // The production tables this slice reads (columns trimmed to what's used).
  db.exec(`
    CREATE TABLE agent_runs (run_id TEXT PRIMARY KEY, session_id TEXT, workflow_id TEXT, parent_run_id TEXT,
      goal TEXT, status TEXT, run_outcome TEXT, created_at INTEGER);
    CREATE TABLE agent_steps (step_id TEXT PRIMARY KEY, run_id TEXT, idx INTEGER);
    CREATE TABLE chat_sessions (session_id TEXT PRIMARY KEY, origin TEXT);
    CREATE TABLE users (user_id TEXT PRIMARY KEY, settings_json TEXT);
    CREATE TABLE oauth_tokens (provider TEXT, access_token TEXT, refresh_token TEXT, expires_at INTEGER, scope TEXT);
    CREATE TABLE external_actions (action_id TEXT PRIMARY KEY, task_id TEXT, run_id TEXT, step_id TEXT, tool TEXT,
      category TEXT, target_system TEXT, target_identity TEXT, fingerprint TEXT, idempotency_key TEXT,
      approval_id TEXT, approval_scope TEXT, state TEXT, attempts INTEGER DEFAULT 0, dispatched_at INTEGER,
      external_ref TEXT, confirmation_method TEXT, outcome TEXT, retry_eligible INTEGER DEFAULT 0,
      error_redacted TEXT, created_at INTEGER DEFAULT (unixepoch()), updated_at INTEGER DEFAULT (unixepoch()));
    INSERT INTO users VALUES ('default', '{}');
  `);
  applyDurabilitySchema(db); // adds agent_runs.resume_state + durability tables
});

/** Seed an interrupted run with N recorded steps. */
function seedRun(runId: string, sessionId: string, opts: { origin?: string; steps?: number; parent?: string; outcome?: string } = {}) {
  db.prepare(`INSERT OR IGNORE INTO chat_sessions VALUES (?, ?)`).run(sessionId, opts.origin ?? 'chat');
  db.prepare(`INSERT INTO agent_runs (run_id, session_id, workflow_id, parent_run_id, goal, status, run_outcome, created_at)
              VALUES (?, ?, 'wf', ?, 'Email Jay the report', 'running', ?, ?)`)
    .run(runId, sessionId, opts.parent ?? null, opts.outcome ?? 'interrupted', now());
  for (let i = 0; i < (opts.steps ?? 0); i++) db.prepare(`INSERT INTO agent_steps VALUES (?, ?, ?)`).run(`${runId}-s${i}`, runId, i);
}

/** Record the email the interrupted run had already sent. */
function seedConfirmedEmail(runId: string, actionId: string, to: string, subject: string, body: string) {
  db.prepare(`INSERT INTO external_actions (action_id, run_id, tool, category, target_identity, fingerprint, state, external_ref)
              VALUES (?, ?, 'email_send', 'send', ?, ?, 'confirmed', 'gmail-1')`)
    .run(actionId, runId, hashIdentity(to), fingerprint({ to, subject, body }));
}

describe('listing interrupted runs', () => {
  it('offers interrupted top-level runs with step + confirmed actions; flags unattended; skips handled', () => {
    seedRun('R1', 'S1', { steps: 7 });
    seedRun('R2', 'S2', { origin: 'scheduled', steps: 2 });
    seedRun('R3', 'S1', { parent: 'R1' });              // child run — covered by its parent
    seedRun('R4', 'S1', { outcome: 'succeeded' });      // finished normally
    seedConfirmedEmail('R1', 'A1', 'jay@example.com', 'Report', 'Attached.');

    const runs = listInterruptedRuns(db);
    expect(runs.map(r => r.runId).sort()).toEqual(['R1', 'R2']);
    const r1 = runs.find(r => r.runId === 'R1')!;
    expect(r1.lastStepIdx).toBe(6);
    expect(r1.unattended).toBe(false);
    expect(r1.confirmedActions).toEqual([{ actionId: 'A1', tool: 'email_send', state: 'confirmed' }]);
    expect(runs.find(r => r.runId === 'R2')!.unattended).toBe(true);

    // Listing is read-only: nothing was resumed (unattended included).
    const states = db.prepare(`SELECT resume_state FROM agent_runs WHERE run_id IN ('R1','R2')`).all() as { resume_state: string | null }[];
    expect(states.every(s => s.resume_state === null)).toBe(true);

    expect(markInterruptedRun(db, 'R2', 'dismissed')).toBe(true);
    expect(markInterruptedRun(db, 'R2', 'resumed')).toBe(false); // already handled
    expect(listInterruptedRuns(db).map(r => r.runId)).toEqual(['R1']);
    expect(getInterruptedRun(db, 'R2')).toBeNull();
  });

  it('builds a continuation prompt naming the restart step and the actions not to repeat', () => {
    const p = buildResumePrompt({
      goal: 'Email Jay the report', lastStepIdx: 6,
      confirmedActions: [{ actionId: 'A1', tool: 'email_send', state: 'confirmed' }],
    });
    expect(p).toContain('The app restarted at step 6');
    expect(p).toContain('Do NOT repeat actions already confirmed in external_actions');
    expect(p).toContain('email_send [A1, confirmed]');
    expect(buildResumePrompt({ goal: 'x', lastStepIdx: -1, confirmedActions: [] }))
      .toContain('Do NOT repeat actions already confirmed in external_actions');
  });
});

describe('resume cannot re-send a confirmed email', () => {
  const to = 'jay@example.com';
  beforeEach(() => {
    seedRun('R1', 'S1', { steps: 4 });
    seedConfirmedEmail('R1', 'A1', to, 'Report', 'Attached.');
    global.fetch = vi.fn().mockRejectedValue(new Error('network must not be touched')) as never;
  });
  const resumed = <T,>(fn: () => Promise<T>) =>
    runWithContext({ actor: 'local', lan: false, resume: { fromRunId: 'R1', confirmedActionIds: ['A1'] } }, fn);
  const rows = () => (db.prepare(`SELECT COUNT(*) AS n FROM external_actions`).get() as { n: number }).n;

  it('refuses the identical email (write-ahead fingerprint guard)', async () => {
    const out = JSON.parse(await resumed(() => invokeGmailSendTool('email_send', { to, subject: 'Report', body: 'Attached.' })));
    expect(out.sent).toBe(false);
    expect(out.duplicate).toBe(true);
    expect(Number(rows())).toBe(1);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('refuses a REWORDED email to the same recipient (resume guard)', async () => {
    const out = JSON.parse(await resumed(() =>
      invokeGmailSendTool('email_send', { to: 'Jay@Example.com', subject: 'Re: the report', body: 'Sending again!' }, { runId: 'R5' })));
    expect(out.sent).toBe(false);
    expect(out.resumed).toBe(true);
    expect(out.message).toMatch(/did not send another/);
    expect(Number(rows())).toBe(1); // no new write-ahead row: nothing was attempted
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('does not block a different recipient (guard is scoped to confirmed actions)', async () => {
    const out = await resumed(() => invokeGmailSendTool('email_send', { to: 'pat@example.com', subject: 'Hi', body: 'Hello' }));
    // Reaches the normal send path, which fails cleanly here (Google not connected).
    expect(out).not.toMatch(/"resumed":true/);
    expect(out).toMatch(/isn.t connected/i);
  });
});
