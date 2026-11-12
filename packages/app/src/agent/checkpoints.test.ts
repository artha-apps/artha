/**
 * File checkpoints + rewind, end to end through the real filesystem tools:
 * a step overwrites one file, deletes another, moves a third and creates a
 * fourth; rewinding to that step must put every byte back (hash-verified),
 * recreate the deleted file and remove the one created afterwards. Also pins
 * the "no silent caps" rules: store-cap eviction is logged and reported, and
 * files over the size limit are recorded as skipped, never silently dropped.
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
import { configureCheckpointStore, rewindRunToStep, checkpointBeforeMutation } from './checkpoints';
import { invokeFilesystemTool } from '../tools/filesystem';

function openDb(file: string): SqlDb & { close(): void } {
  const { DatabaseSync } = createRequire(__filename)('node:sqlite') as { DatabaseSync: new (f: string) => SqlDb & { close(): void } };
  return new DatabaseSync(file);
}

let dir: string;
let store: string;
let db: SqlDb & { close(): void };
let logs: string[];

beforeEach(async () => {
  dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'artha-cp-'));
  store = path.join(dir, '.store');
  db = openDb(':memory:');
  applyDurabilitySchema(db);
  // Minimal agent_steps so rewind can order by step index like production.
  db.exec(`CREATE TABLE agent_steps (step_id TEXT PRIMARY KEY, run_id TEXT, idx INTEGER)`);
  logs = [];
  configureCheckpointStore({ db, dir: store, log: (m) => logs.push(m) });
});
afterEach(() => { configureCheckpointStore(null); db.close(); });

const w = (p: string, s: string) => fsp.writeFile(path.join(dir, p), s);
const r = (p: string) => fs.readFileSync(path.join(dir, p), 'utf8');
const at = (p: string) => path.join(dir, p);
/** Invoke an fs tool as step `idx` of run R1. */
async function step(idx: number, tool: string, args: Record<string, unknown>) {
  const stepId = `step-${idx}`;
  db.prepare(`INSERT OR IGNORE INTO agent_steps (step_id, run_id, idx) VALUES (?, 'R1', ?)`).run(stepId, idx);
  return invokeFilesystemTool(tool, args, null, { runId: 'R1', sessionId: 'S1', stepId, stepIdx: idx });
}

describe('checkpoint + rewind', () => {
  it('restores overwritten, deleted and moved files and removes files created after the step', async () => {
    await w('report.txt', 'original report');
    await w('notes.txt', 'precious notes');
    await w('draft.txt', 'old draft');
    await w('photo.txt', 'pixels');
    await fsp.mkdir(at('archive'));

    // Step 2: overwrite report.txt by copying draft.txt onto it.
    await step(2, 'fs_copy_file', { source: at('draft.txt'), destination: at('report.txt') });
    // Step 3: permanently delete notes.txt.
    await step(3, 'fs_delete_file', { path: at('notes.txt'), permanent: true });
    // Step 4: move photo.txt into archive/ (destination is created).
    await step(4, 'fs_move_file', { source: at('photo.txt'), destination: at('archive') });

    expect(r('report.txt')).toBe('old draft');
    expect(fs.existsSync(at('notes.txt'))).toBe(false);
    expect(fs.existsSync(at('photo.txt'))).toBe(false);
    expect(fs.existsSync(at('archive/photo.txt'))).toBe(true);

    const report = await rewindRunToStep('R1', 'step-2');
    expect(report.ok).toBe(true);
    expect(report.skipped).toEqual([]);
    expect(r('report.txt')).toBe('original report');   // overwrite undone
    expect(r('notes.txt')).toBe('precious notes');     // deleted file recreated
    expect(r('photo.txt')).toBe('pixels');             // moved file back in place
    expect(fs.existsSync(at('archive/photo.txt'))).toBe(false); // created-after removed
    expect(report.removed).toEqual([at('archive/photo.txt')]);
    expect(report.restored.sort()).toEqual([at('notes.txt'), at('photo.txt'), at('report.txt')].sort());
  });

  it('never destroys edits the user made after the run, and the rewind can be undone (R1 #3)', async () => {
    await w('a.txt', 'source');
    await w('report.txt', 'before the run');
    await w('v2.txt', 'what the run wrote');
    // Step 1: the run creates b.txt and overwrites report.txt.
    await step(1, 'fs_copy_file', { source: at('a.txt'), destination: at('b.txt') });
    await step(2, 'fs_copy_file', { source: at('v2.txt'), destination: at('report.txt') });
    // Later the USER writes real work into both files.
    await w('b.txt', 'my real work in b');
    await w('report.txt', 'my edits to the report');

    const rep = await rewindRunToStep('R1', 'step-1');
    expect(rep.ok).toBe(true);
    expect(fs.existsSync(at('b.txt'))).toBe(false);
    expect(r('report.txt')).toBe('before the run');
    expect(rep.preserved.sort()).toEqual([at('b.txt'), at('report.txt')].sort());
    expect(rep.undo).toBeDefined();

    // Undo the rewind: the user's work is back, byte for byte.
    const back = await rewindRunToStep(rep.undo!.runId, rep.undo!.stepId);
    expect(back.ok).toBe(true);
    expect(r('b.txt')).toBe('my real work in b');
    expect(r('report.txt')).toBe('my edits to the report');
  });

  it('leaves a file in place when its current version cannot be backed up first', async () => {
    await w('a.txt', 'small');
    await step(1, 'fs_copy_file', { source: at('a.txt'), destination: at('b.txt') });
    await w('b.txt', 'the user later made this much bigger');
    // The backup would exceed the size limit, so the rewind must not delete it.
    configureCheckpointStore({ db, dir: store, maxFileBytes: 10, log: (m) => logs.push(m) });
    const rep = await rewindRunToStep('R1', 'step-1');
    expect(rep.ok).toBe(false);
    expect(r('b.txt')).toBe('the user later made this much bigger');
    expect(rep.skipped).toEqual([{ path: at('b.txt'), reason: 'could not back up its current version first; left in place' }]);
  });

  it('rewinding to a later step leaves earlier steps in place', async () => {
    await w('a.txt', 'v1');
    await w('b.txt', 'keep me');
    await w('v2.txt', 'v2');
    await step(1, 'fs_copy_file', { source: at('v2.txt'), destination: at('a.txt') }); // a: v1 → v2
    await step(5, 'fs_delete_file', { path: at('b.txt'), permanent: true });

    const report = await rewindRunToStep('R1', 'step-5');
    expect(report.ok).toBe(true);
    expect(r('b.txt')).toBe('keep me');
    expect(r('a.txt')).toBe('v2'); // step 1 was before the target — untouched
  });

  it('does not checkpoint calls without a run (direct use behaves as before)', async () => {
    await w('x.txt', 'x');
    await invokeFilesystemTool('fs_delete_file', { path: at('x.txt'), permanent: true }, null);
    expect((db.prepare(`SELECT COUNT(*) AS n FROM checkpoint_files`).get() as { n: number }).n).toBe(0);
  });

  it('lists confirmed external actions as not reversible instead of ignoring them', async () => {
    db.exec(`CREATE TABLE external_actions (action_id TEXT, run_id TEXT, tool TEXT, state TEXT, created_at INTEGER)`);
    db.prepare(`INSERT INTO external_actions VALUES ('A1','R1','email_send','confirmed',1)`).run();
    await w('a.txt', 'v1');
    await step(1, 'fs_delete_file', { path: at('a.txt'), permanent: true });
    const report = await rewindRunToStep('R1', 'step-1');
    expect(r('a.txt')).toBe('v1');
    expect(report.externalActions).toEqual([{ actionId: 'A1', tool: 'email_send', state: 'confirmed' }]);
  });

  it('reports an unknown step instead of claiming success', async () => {
    const report = await rewindRunToStep('R1', 'nope');
    expect(report.ok).toBe(false);
    expect(report.error).toMatch(/not found/);
  });
});

describe('store limits are never silent', () => {
  it('evicts the oldest snapshot over the cap, logs it, and rewind reports it', async () => {
    configureCheckpointStore({ db, dir: store, capBytes: 20, log: (m) => logs.push(m) });
    const files = ['one.txt', 'two.txt', 'three.txt'];
    for (const [i, f] of files.entries()) await w(f, `content-${i}-xx`); // 12 bytes each
    // Snapshot in order, pinning blob mtimes so "oldest" is deterministic.
    for (const [i, f] of files.entries()) {
      await checkpointBeforeMutation({ runId: 'R2', stepId: `s${i}`, stepIdx: i }, [at(f)]);
      const sha = (db.prepare(`SELECT sha256 FROM checkpoint_files WHERE path=?`).get(at(f)) as { sha256: string }).sha256;
      const t = new Date(Date.UTC(2026, 0, 1 + i));
      await fsp.utimes(path.join(store, sha), t, t);
    }
    // The cap (20 bytes) holds only one 12-byte blob: each new snapshot evicts the previous one.
    const evicted = db.prepare(`SELECT path FROM checkpoint_files WHERE evicted_at IS NOT NULL ORDER BY id`).all() as { path: string }[];
    expect(evicted.map(e => e.path)).toEqual([at('one.txt'), at('two.txt')]);
    expect(logs.filter(l => /evicted oldest snapshot/.test(l))).toHaveLength(2);
    expect(fs.readdirSync(store)).toHaveLength(1);

    for (const f of files) await fsp.unlink(at(f));
    const report = await rewindRunToStep('R2', 's0');
    expect(report.ok).toBe(false);
    expect(report.restored).toEqual([at('three.txt')]);
    expect(report.skipped).toEqual([
      { path: at('one.txt'), reason: 'snapshot evicted (store cap)' },
      { path: at('two.txt'), reason: 'snapshot evicted (store cap)' },
    ]);
  });

  it('records files over the size limit as skipped (too_large) and says so on rewind', async () => {
    configureCheckpointStore({ db, dir: store, maxFileBytes: 4, log: (m) => logs.push(m) });
    await w('big.txt', 'way more than four bytes');
    await step(1, 'fs_delete_file', { path: at('big.txt'), permanent: true });
    const row = db.prepare(`SELECT skipped_reason, size, sha256 FROM checkpoint_files`).get() as Record<string, unknown>;
    expect(row.skipped_reason).toBe('too_large');
    expect(row.sha256).toBeNull();
    expect(logs.some(l => /checkpoint skipped/.test(l))).toBe(true);
    const report = await rewindRunToStep('R1', 'step-1');
    expect(report.ok).toBe(false);
    expect(report.skipped).toEqual([{ path: at('big.txt'), reason: 'too_large' }]);
  });
});
