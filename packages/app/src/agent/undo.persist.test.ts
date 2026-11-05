/**
 * Durable undo — the registry must survive an app restart. Exercised against
 * a REAL SQLite file (Node's built-in node:sqlite; the Electron-built
 * better-sqlite3 binary can't load under vitest) using the production DDL
 * from applyDurabilitySchema, closed and reopened between record and revert.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'module';
import { promises as fsp } from 'fs';
import * as fs from 'fs';
import * as os from 'os';
import path from 'path';

vi.mock('electron', () => ({ app: { getPath: () => os.tmpdir() } }));

import { applyDurabilitySchema } from '../db/schema';
import type { SqlDb } from '../db/sqlLike';
import { configureUndoStore, recordFilesystemEffect, listUndoable, revert, mostRecentUndoable, MAX_ENTRIES_PER_SESSION } from './undo';

/** Open (or reopen) a node:sqlite database file as a SqlDb. */
function openDb(file: string): SqlDb & { close(): void } {
  const { DatabaseSync } = createRequire(__filename)('node:sqlite') as { DatabaseSync: new (f: string) => SqlDb & { close(): void } };
  return new DatabaseSync(file);
}

let dir: string;
let dbFile: string;
let db: (SqlDb & { close(): void }) | null = null;

beforeEach(async () => {
  dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'artha-undo-db-'));
  dbFile = path.join(dir, 'artha.db');
  db = openDb(dbFile);
  applyDurabilitySchema(db);
  configureUndoStore(db);
});
afterEach(() => { configureUndoStore(null); try { db?.close(); } catch { /* closed */ } db = null; });

describe('undo survives a DB reopen', () => {
  it('records a move, reopens the database, and still reverts it', async () => {
    const a = path.join(dir, 'a.txt');
    const b = path.join(dir, 'sub', 'a.txt');
    await fsp.writeFile(a, 'hi');
    await fsp.mkdir(path.dirname(b), { recursive: true });
    await fsp.rename(a, b);
    recordFilesystemEffect('fs_move_file', JSON.stringify({ moved: a, to: b, success: true }), { runId: 'r1', sessionId: 's1', stepId: 'st1' });

    // Simulate an app restart: drop the handle, open a fresh one, re-run DDL.
    db!.close();
    configureUndoStore(null);
    expect(listUndoable()).toEqual([]); // nothing left in process memory
    db = openDb(dbFile);
    applyDurabilitySchema(db); // idempotent on an existing DB
    configureUndoStore(db);

    const listed = listUndoable(20, 's1');
    expect(listed).toHaveLength(1);
    expect(listed[0].kind).toBe('move');
    const row = db.prepare(`SELECT run_id, session_id, step_id, op FROM undo_entries`).get() as Record<string, string>;
    expect(row).toEqual({ run_id: 'r1', session_id: 's1', step_id: 'st1', op: 'move' });

    const r = await revert(listed[0].id);
    expect(r.ok).toBe(true);
    expect(fs.existsSync(a)).toBe(true);
    expect(fs.existsSync(b)).toBe(false);

    // The undone flag is persisted too: after another reopen it stays undone.
    db.close();
    db = openDb(dbFile);
    configureUndoStore(db);
    expect(listUndoable(20, 's1')).toEqual([]);
    expect((await revert(listed[0].id)).ok).toBe(false);
  });

  it('caps each session at MAX_ENTRIES_PER_SESSION, pruning the oldest', () => {
    for (let i = 0; i < MAX_ENTRIES_PER_SESSION + 5; i++) {
      recordFilesystemEffect('fs_create_directory', JSON.stringify({ created: path.join(dir, `d${i}`) }), { sessionId: 's1' });
    }
    recordFilesystemEffect('fs_create_directory', JSON.stringify({ created: path.join(dir, 'other') }), { sessionId: 's2' });

    const n = (sid: string) => (db!.prepare(`SELECT COUNT(*) AS n FROM undo_entries WHERE session_id=?`).get(sid) as { n: number }).n;
    expect(Number(n('s1'))).toBe(MAX_ENTRIES_PER_SESSION);
    expect(Number(n('s2'))).toBe(1); // another session's cap is independent
    const labels = listUndoable(100, 's1').map(e => e.label);
    expect(labels[0]).toBe(`Created folder d${MAX_ENTRIES_PER_SESSION + 4}`); // newest first
    expect(labels).not.toContain('Created folder d0'); // oldest pruned
    expect(mostRecentUndoable('s2')?.label).toBe('Created folder other');
  });
});
