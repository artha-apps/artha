/**
 * DB health checkpointing — disaster-recovery layer.
 *
 * Every 30 minutes we write a heartbeat timestamp into the `db_health` table
 * and drop a Sentry breadcrumb. The point is forensic: when a crash report
 * comes in, the most recent `checkpointed_at` tells us exactly how long the app
 * had been running healthily before it died — "last healthy checkpoint was 4
 * minutes before the crash" is a very different story from "28 minutes before".
 *
 * The heartbeat is a single-row upsert (id='default'), so the table never
 * grows. Writing is wrapped in try/catch — a failed checkpoint must never take
 * down the app; it just means we'll have a slightly staler breadcrumb.
 */
import { getDb } from './schema';
import { addBreadcrumb } from '../sentry';

/** 30 minutes between heartbeats. */
const CHECKPOINT_INTERVAL_MS = 30 * 60 * 1000;

let timer: NodeJS.Timeout | null = null;

/** Write one heartbeat row + Sentry breadcrumb. Best-effort. */
function writeCheckpoint(): void {
  try {
    const db = getDb();
    const now = Math.floor(Date.now() / 1000);
    db.prepare(
      `INSERT INTO db_health (id, checkpointed_at) VALUES ('default', ?)
       ON CONFLICT(id) DO UPDATE SET checkpointed_at=excluded.checkpointed_at`,
    ).run(now);
    // Non-PII breadcrumb — only a timestamp. Surfaces in any later crash report.
    addBreadcrumb('artha.db_health', 'db checkpoint', { checkpointed_at: now });
  } catch (err) {
    console.warn('[Artha] db_health checkpoint failed:', err);
  }
}

/** The last healthy checkpoint (unix seconds), or null if none recorded yet. */
export function getLastCheckpoint(): number | null {
  try {
    const row = getDb().prepare(`SELECT checkpointed_at FROM db_health WHERE id='default'`).get() as { checkpointed_at: number } | undefined;
    return row?.checkpointed_at ?? null;
  } catch {
    return null;
  }
}

/** Start the 30-minute checkpoint loop. Writes an immediate checkpoint on
 *  start (so a session that crashes early still has one), then on interval.
 *  Idempotent — calling twice keeps a single timer. The timer is `unref`'d so
 *  it never keeps the process alive on its own. */
export function startHealthCheckpointing(): void {
  if (timer) return;
  writeCheckpoint();
  timer = setInterval(writeCheckpoint, CHECKPOINT_INTERVAL_MS);
  timer.unref?.();
}

/** Stop the checkpoint loop (called on app quit). */
export function stopHealthCheckpointing(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
