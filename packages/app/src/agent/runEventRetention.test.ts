/** run_events retention (agent/runEventRetention.ts): last 30 days OR last
 *  200 runs, whichever keeps more; active runs kept; always logged. */
import { describe, it, expect } from 'vitest';
import { pruneRunEvents, type RetentionDb } from './runEventRetention';

const DAY = 86_400_000;
const NOW = 1_800_000_000_000;

/** In-memory node:sqlite DB with the production run_events DDL. */
function makeDb(): RetentionDb & { exec(sql: string): void } {
  const { DatabaseSync } = process.getBuiltinModule('node:sqlite') as unknown as {
    DatabaseSync: new (path: string) => RetentionDb & { exec(sql: string): void };
  };
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE run_events (
    run_id TEXT NOT NULL, seq INTEGER NOT NULL, ts INTEGER NOT NULL, kind TEXT NOT NULL,
    payload_json TEXT NOT NULL DEFAULT 'null', PRIMARY KEY (run_id, seq))`);
  return db;
}

/** Add a run with `n` events, the newest at `lastTs`. */
function addRun(db: RetentionDb, runId: string, lastTs: number, n = 2): void {
  const ins = db.prepare(`INSERT INTO run_events (run_id, seq, ts, kind) VALUES (?, ?, ?, 'status')`);
  for (let i = 1; i <= n; i++) ins.run(runId, i, lastTs - (n - i) * 1000);
}
const runIds = (db: RetentionDb) =>
  (db.prepare(`SELECT DISTINCT run_id FROM run_events ORDER BY run_id`).all() as Array<{ run_id: string }>).map(r => r.run_id);

describe('pruneRunEvents', () => {
  it('keeps everything inside the 30-day window, even beyond 200 runs', () => {
    const db = makeDb();
    for (let i = 0; i < 5; i++) addRun(db, `r${i}`, NOW - i * DAY);
    const lines: string[] = [];
    const res = pruneRunEvents(db, { now: NOW, keepRuns: 2, log: l => lines.push(l) });
    expect(res).toEqual({ ok: true, runsPruned: 0, eventsPruned: 0 });
    expect(runIds(db)).toHaveLength(5);
    // Logged even when nothing was removed.
    expect(lines[0]).toMatch(/pruned 0 event\(s\) from 0 run\(s\)/);
  });

  it('keeps the newest 200 runs even when they are all older than 30 days', () => {
    const db = makeDb();
    for (let i = 0; i < 4; i++) addRun(db, `old${i}`, NOW - (40 + i) * DAY);
    const res = pruneRunEvents(db, { now: NOW, keepRuns: 3, log: () => {} });
    // Only the oldest falls outside BOTH windows.
    expect(res).toEqual({ ok: true, runsPruned: 1, eventsPruned: 2 });
    expect(runIds(db)).toEqual(['old0', 'old1', 'old2']);
  });

  it('a run counts as recent by its newest event; active runs are never pruned', () => {
    const db = makeDb();
    addRun(db, 'longrun', NOW - 1 * DAY, 3);
    // Started long ago but its first event is old: still recent overall.
    db.prepare(`INSERT INTO run_events (run_id, seq, ts, kind) VALUES ('longrun', 99, ?, 'status')`).run(NOW - 90 * DAY);
    addRun(db, 'stale', NOW - 60 * DAY);
    addRun(db, 'live', NOW - 60 * DAY);
    const res = pruneRunEvents(db, { now: NOW, keepRuns: 0, activeRunIds: ['live'], log: () => {} });
    expect(res).toEqual({ ok: true, runsPruned: 1, eventsPruned: 2 });
    expect(runIds(db)).toEqual(['live', 'longrun']);
  });

  it('uses the defaults (30 days / 200 runs) and reports failures instead of throwing', () => {
    const db = makeDb();
    for (let i = 0; i < 201; i++) addRun(db, `r${String(i).padStart(3, '0')}`, NOW - 31 * DAY - i, 1);
    expect(pruneRunEvents(db, { now: NOW, log: () => {} })).toEqual({ ok: true, runsPruned: 1, eventsPruned: 1 });

    const warned: string[] = [];
    const broken: RetentionDb = { prepare: () => { throw new Error('disk I/O error'); } };
    const res = pruneRunEvents(broken, { now: NOW, log: () => {}, warn: l => warned.push(l) });
    expect(res).toEqual({ ok: false, error: 'disk I/O error' });
    expect(warned[0]).toMatch(/retention prune failed/);
  });
});
