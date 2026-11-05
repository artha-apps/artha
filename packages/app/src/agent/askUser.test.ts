/**
 * ask_user tool tests (agent/askUser.ts):
 *   - the user's answer resolves the SAME pending call (no new turn);
 *   - unattended runs fail closed with "unanswered (unattended run)" and never
 *     open a card;
 *   - Cancel resolves as declined;
 *   - argument validation (1–4 questions) and answer sanitisation.
 */
import { describe, it, expect, vi } from 'vitest';
import { createRequire } from 'module';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { INTERACTIONS_TABLE_SQL } from '../db/interactionsTable';

// ── Real SQLite for persistence tests ────────────────────────────────────────
// better-sqlite3 is compiled against Electron's ABI in dev installs (and CI
// test jobs never load it), so tests use Node's built-in node:sqlite — same
// engine, same prepare/run/get/all surface the interaction store relies on.
interface TestDb {
  exec(sql: string): void;
  prepare(sql: string): { run(...a: unknown[]): unknown; get(...a: unknown[]): unknown; all(...a: unknown[]): unknown[] };
  close(): void;
}
const nodeRequire = createRequire(path.join(process.cwd(), 'noop.js'));
/** Open (or create) a SQLite file with the interactions table bootstrapped
 *  exactly as db/schema.ts does it. */
function openTestDb(file: string): TestDb {
  const { DatabaseSync } = nodeRequire('node:sqlite') as { DatabaseSync: new (f: string) => TestDb };
  const db = new DatabaseSync(file);
  db.exec(INTERACTIONS_TABLE_SQL);
  return db;
}
/** A fresh temp DB file path for one test. */
function tempDbPath(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'artha-hitl-')), 'test.db');
}

vi.mock('../db/schema', () => ({ getDb: () => { throw new Error('use injected db'); } }));

import { InteractionHub, type Interaction } from './interactions';
import { runAskUser, parseAskUserArgs, sanitizeAnswers, UNATTENDED_RESULT, MAX_ASK_QUESTIONS } from './askUser';

const ARGS = {
  questions: [
    { id: 'fmt', question: 'Which format?', options: [{ label: 'PDF' }, { label: 'DOCX', description: 'Word' }], allow_custom: false, multi: false },
    { id: 'who', question: 'Who gets it?', options: [{ label: 'Team' }, { label: 'Boss' }], allow_custom: true, multi: true },
  ],
};

/** Hub on a fresh SQLite file that records every pending interaction. */
function makeHub() {
  const db = openTestDb(tempDbPath());
  const hub = new InteractionHub(() => db);
  const pending: Interaction[] = [];
  hub.setEmitter((c, p) => { if (c === 'interaction:pending') pending.push(p as Interaction); });
  return { hub, pending, db };
}

const ctx = { runId: 'run-1', workflowId: 'wf-1', sessionId: 's-1' };

describe('ask_user', () => {
  it('the user\'s answer resolves the same tool call', async () => {
    const { hub, pending, db } = makeHub();
    const call = runAskUser(ARGS, { ...ctx, unattended: false, hub });
    // The call is blocked on exactly one inline card.
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ kind: 'ask', run_id: 'run-1' });
    expect((pending[0].payload.questions as unknown[]).length).toBe(2);

    hub.respond(pending[0].id, 'answered', {
      fmt: { selected: ['DOCX'] },
      who: { selected: ['Team', 'Boss'], custom: 'and Priya' },
    });
    const result = JSON.parse(await call);
    expect(result.status).toBe('answered');
    expect(result.answers[0]).toMatchObject({ id: 'fmt', selected: ['DOCX'], unanswered: false });
    expect(result.answers[1]).toMatchObject({ id: 'who', selected: ['Team', 'Boss'], custom: 'and Priya' });
    db.close();
  });

  it('unattended runs return unanswered without opening a card', async () => {
    const { hub, pending, db } = makeHub();
    const result = await runAskUser(ARGS, { ...ctx, unattended: true, hub });
    expect(result.startsWith(UNATTENDED_RESULT)).toBe(true);
    expect(result).toContain('unanswered (unattended run)');
    expect(pending).toHaveLength(0);
    db.close();
  });

  it('Cancel resolves the call as declined', async () => {
    const { hub, pending, db } = makeHub();
    const call = runAskUser(ARGS, { ...ctx, unattended: false, hub });
    hub.respond(pending[0].id, 'declined');
    expect(await call).toMatch(/^declined/);
    db.close();
  });

  it('Stop on the workflow declines a pending question', async () => {
    const { hub, db } = makeHub();
    const call = runAskUser(ARGS, { ...ctx, unattended: false, hub });
    hub.declineForWorkflow('wf-1');
    expect(await call).toMatch(/^declined/);
    db.close();
  });

  it('validates 1–4 questions and defaults ids/flags', () => {
    expect(parseAskUserArgs({}).ok).toBe(false);
    expect(parseAskUserArgs({ questions: [] }).ok).toBe(false);
    const tooMany = { questions: Array.from({ length: MAX_ASK_QUESTIONS + 1 }, (_, i) => ({ question: `Q${i}?`, options: ['a'] })) };
    expect(parseAskUserArgs(tooMany).ok).toBe(false);
    expect(parseAskUserArgs({ questions: [{ question: 'No options?' }] }).ok).toBe(false);
    const ok = parseAskUserArgs({ questions: [{ question: 'Pick', options: ['x', { label: 'y' }] }] });
    expect(ok).toEqual({ ok: true, questions: [{ id: 'q1', question: 'Pick', options: [{ label: 'x' }, { label: 'y' }], allow_custom: false, multi: false }] });
  });

  it('an invalid call returns an error the model can correct, without a card', async () => {
    const { hub, pending, db } = makeHub();
    expect(await runAskUser({ questions: [] }, { ...ctx, unattended: false, hub })).toMatch(/^Error:/);
    expect(pending).toHaveLength(0);
    db.close();
  });

  it('sanitises answers to what each question allows', () => {
    const parsed = parseAskUserArgs(ARGS);
    if (!parsed.ok) throw new Error('fixture invalid');
    const clean = sanitizeAnswers(parsed.questions, {
      fmt: { selected: ['PDF', 'DOCX', 'EXE'], custom: 'ignored — custom not allowed' },
      who: { selected: ['Nobody'] },
    });
    expect(clean.fmt).toEqual({ selected: ['PDF'] });
    expect(clean.who).toEqual({ selected: [] });
  });
});
