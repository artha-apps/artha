/**
 * Retention for the run event log (`run_events`, agent/runEvents.ts).
 *
 * Purpose: the log is append-only and grows with every run (heartbeats every
 * 10 s included), and it had no retention. This prune keeps the last 30 days
 * OR the last 200 runs, whichever keeps more: a run's events are deleted only
 * when the run is BOTH older than the window AND outside the most recent 200.
 * A run's age is the time of its newest event. Ids recorded under a workflow
 * id (plan reviews before a run exists) are ranked as their own group.
 *
 * Never silent: every prune logs one line with what it removed (also when it
 * removed nothing), and a failure is logged and returned, never thrown, so it
 * can't block startup. Runs that are still active are never pruned.
 *
 * Only `run_events` rows are deleted. Receipts, steps, task executions and
 * verification evidence live in other tables and are untouched.
 */

/** Minimal DB surface (better-sqlite3 in production, node:sqlite in tests). */
export interface RetentionDb {
  prepare(sql: string): {
    all(...params: unknown[]): unknown[];
    run(...params: unknown[]): { changes: number | bigint };
  };
}

export const RUN_EVENTS_KEEP_DAYS = 30;
export const RUN_EVENTS_KEEP_RUNS = 200;
const DAY_MS = 86_400_000;

export interface PruneOptions {
  /** Epoch ms "now" (injected for tests). */
  now?: number;
  keepDays?: number;
  keepRuns?: number;
  /** Run ids currently executing — never pruned. */
  activeRunIds?: Iterable<string>;
  /** Where the summary line goes (console by default). */
  log?: (line: string) => void;
  warn?: (line: string, err: unknown) => void;
}

export type PruneResult =
  | { ok: true; runsPruned: number; eventsPruned: number }
  | { ok: false; error: string };

/** Delete run_events for runs outside both retention windows. */
export function pruneRunEvents(db: RetentionDb, opts: PruneOptions = {}): PruneResult {
  const now = opts.now ?? Date.now();
  const keepDays = opts.keepDays ?? RUN_EVENTS_KEEP_DAYS;
  const keepRuns = opts.keepRuns ?? RUN_EVENTS_KEEP_RUNS;
  const log = opts.log ?? ((l: string) => console.info(l));
  const warn = opts.warn ?? ((l: string, e: unknown) => console.warn(l, e));
  const active = new Set(opts.activeRunIds ?? []);
  const cutoff = now - keepDays * DAY_MS;
  try {
    // Rank runs newest first by their newest event; candidates are outside the
    // top `keepRuns` AND older than the cutoff.
    const candidates = db.prepare(`
      WITH per_run AS (SELECT run_id, MAX(ts) AS last_ts FROM run_events GROUP BY run_id),
      ranked AS (
        SELECT run_id, last_ts, ROW_NUMBER() OVER (ORDER BY last_ts DESC, run_id DESC) AS rn FROM per_run
      )
      SELECT run_id FROM ranked WHERE rn > ? AND last_ts < ?
    `).all(keepRuns, cutoff) as Array<{ run_id: string }>;

    const del = db.prepare(`DELETE FROM run_events WHERE run_id=?`);
    let runsPruned = 0;
    let eventsPruned = 0;
    for (const { run_id } of candidates) {
      if (active.has(run_id)) continue;
      const n = Number(del.run(run_id).changes);
      if (n > 0) { runsPruned++; eventsPruned += n; }
    }
    log(`[Artha] run_events retention: pruned ${eventsPruned} event(s) from ${runsPruned} run(s); kept the last ${keepDays} days or the last ${keepRuns} runs, whichever is larger.`);
    return { ok: true, runsPruned, eventsPruned };
  } catch (err) {
    warn('[Artha] run_events retention prune failed (it will be retried at the next prune):', err);
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
