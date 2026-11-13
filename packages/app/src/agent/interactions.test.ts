/**
 * Unified interaction frame tests (agent/interactions.ts) against a REAL
 * SQLite file (node:sqlite — see testSqlite.ts):
 *   - a pending interaction persists across a DB close + reopen and is
 *     re-listed for the renderer;
 *   - settle is first-wins and releases the awaiting promise;
 *   - respond() routes to a flow's own responder when one is registered;
 *   - Stop (declineForWorkflow) declines every pending pause of that run;
 *   - the startup reconciliation expires orphaned pending rows.
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

// The hub defaults to getDb(); every test passes its own provider instead, so
// the real schema module (Electron-bound) is never loaded.
vi.mock('../db/schema', () => ({ getDb: () => { throw new Error('use injected db'); } }));

import {
  InteractionHub, listPendingInteractions, getInteraction,
  INTERACTION_PENDING_CHANNEL, INTERACTION_RESOLVED_CHANNEL,
} from './interactions';

describe('interactions persistence', () => {
  it('a pending interaction survives a DB reopen and is re-shown', () => {
    const file = tempDbPath();
    let db: TestDb = openTestDb(file);
    const hub = new InteractionHub(() => db);
    const { interaction } = hub.open({
      runId: 'run-1', workflowId: 'wf-1', kind: 'ask',
      payload: { sessionId: 's1', questions: [{ id: 'q1', question: 'Which?' }] },
    });

    // Simulate the connection going away (renderer reload / handle recycle).
    db.close();
    db = openTestDb(file);

    const rows = listPendingInteractions(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: interaction.id, run_id: 'run-1', kind: 'ask', status: 'pending' });
    expect(rows[0].payload).toMatchObject({ workflowId: 'wf-1', sessionId: 's1' });
    // The hub still holds the live waiter, so it is offered for re-show.
    expect(hub.listPending().map(i => i.id)).toEqual([interaction.id]);
    db.close();
  });

  it('lists a live interaction even when its row could not be written, oldest first', () => {
    const file = tempDbPath();
    const db = openTestDb(file);
    let failWrites = false;
    const flaky = {
      prepare: (sql: string) => {
        if (failWrites && /^\s*INSERT/i.test(sql)) throw new Error('disk full');
        return db.prepare(sql);
      },
      exec: (sql: string) => db.exec(sql),
    };
    const hub = new InteractionHub(() => flaky as never);
    const first = hub.open({ runId: 'r1', workflowId: 'wf-1', kind: 'confirm', payload: { approvalId: 'a1', toolName: 'fs_copy_file' } }).interaction;
    failWrites = true; // the next prompt cannot be persisted
    const second = hub.open({ runId: 'r2', workflowId: 'wf-2', kind: 'confirm', payload: { approvalId: 'a2', toolName: 'fs_move_file' } }).interaction;
    failWrites = false;

    // Prompts wait until answered, so BOTH must be listed or the second would
    // wait with nothing on screen.
    expect(hub.isLive(second.id)).toBe(true);
    expect(hub.listPending().map(i => i.id)).toEqual([first.id, second.id]);

    hub.settle(first.id, 'answered', { approved: true });
    expect(hub.listPending().map(i => i.id)).toEqual([second.id]);
    hub.settle(second.id, 'declined', { approved: false });
    expect(hub.listPending()).toEqual([]);
    db.close();
  });

  it('startup reconciliation expires orphaned pending rows (same SQL as runMigrations)', () => {
    const file = tempDbPath();
    const db = openTestDb(file);
    const hub = new InteractionHub(() => db);
    const { interaction } = hub.open({ runId: 'r', kind: 'plan', payload: {} });
    db.prepare(`UPDATE interactions SET status='expired', answered_at=unixepoch() WHERE status='pending'`).run();
    expect(listPendingInteractions(db)).toHaveLength(0);
    expect(getInteraction(db, interaction.id)?.status).toBe('expired');
    // A fresh hub (app restart) has no waiter → nothing is re-shown.
    expect(new InteractionHub(() => db).listPending()).toEqual([]);
    db.close();
  });
});

describe('InteractionHub lifecycle', () => {
  it('settle resolves the waiter once, persists the answer, and emits', async () => {
    const db = openTestDb(tempDbPath());
    const emitted: Array<[string, unknown]> = [];
    const hub = new InteractionHub(() => db);
    hub.setEmitter((c, p) => emitted.push([c, p]));
    const { interaction, outcome } = hub.open({ runId: 'r', kind: 'ask', payload: {} });
    expect(emitted[0][0]).toBe(INTERACTION_PENDING_CHANNEL);

    expect(hub.respond(interaction.id, 'answered', { q1: { selected: ['A'] } })).toBe(true);
    expect(hub.respond(interaction.id, 'declined')).toBe(false); // first wins
    await expect(outcome).resolves.toEqual({ status: 'answered', answer: { q1: { selected: ['A'] } } });

    const row = getInteraction(db, interaction.id)!;
    expect(row.status).toBe('answered');
    expect(JSON.parse(row.answer_json!)).toEqual({ q1: { selected: ['A'] } });
    expect(row.answered_at).not.toBeNull();
    expect(emitted.at(-1)).toEqual([INTERACTION_RESOLVED_CHANNEL, { id: interaction.id, status: 'answered' }]);
    db.close();
  });

  it('respond routes to the flow responder instead of settling directly', () => {
    const db = openTestDb(tempDbPath());
    const hub = new InteractionHub(() => db);
    const responder = vi.fn();
    const { interaction } = hub.open({ runId: 'r', kind: 'confirm', payload: {} }, responder);
    hub.respond(interaction.id, 'answered', { approved: true });
    expect(responder).toHaveBeenCalledWith('answered', { approved: true });
    // Still pending until the flow settles it itself.
    expect(hub.isLive(interaction.id)).toBe(true);
    db.close();
  });

  it('declineForWorkflow declines only that workflow\'s pending interactions', async () => {
    const db = openTestDb(tempDbPath());
    const hub = new InteractionHub(() => db);
    const a = hub.open({ runId: 'r1', workflowId: 'wf-a', kind: 'ask', payload: {} });
    const b = hub.open({ runId: 'r2', workflowId: 'wf-b', kind: 'ask', payload: {} });
    hub.declineForWorkflow('wf-a');
    await expect(a.outcome).resolves.toMatchObject({ status: 'declined' });
    expect(hub.isLive(b.interaction.id)).toBe(true);
    db.close();
  });

  it('keeps working in memory when persistence fails', async () => {
    const hub = new InteractionHub(() => { throw new Error('db down'); });
    const { interaction, outcome } = hub.open({ runId: 'r', kind: 'ask', payload: {} });
    hub.respond(interaction.id, 'declined');
    await expect(outcome).resolves.toMatchObject({ status: 'declined' });
  });
});
