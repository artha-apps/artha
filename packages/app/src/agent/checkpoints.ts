/**
 * File checkpoints — pre-mutation snapshots that let a run be rewound.
 *
 * Before a filesystem tool overwrites, moves, deletes or trashes a file, the
 * file's current bytes are copied into a content-addressed store
 * (`<userData>/checkpoints/<sha256>`) and a `checkpoint_files` row records
 * what the path looked like immediately before that step. `rewindRunToStep`
 * then puts every touched path back the way it was before a chosen step:
 * overwritten/deleted files are restored, files the run created afterwards are
 * removed. Restores are verified by re-hashing — a rewind only reports a path
 * as restored when the bytes on disk match the snapshot.
 *
 * Nothing is capped silently:
 *   - files over MAX_FILE_BYTES are not snapshotted; the row says `too_large`;
 *   - directories are not snapshotted; the row says `directory`;
 *   - when the store exceeds STORE_CAP_BYTES the oldest blobs are evicted,
 *     each eviction is logged and the affected rows get `evicted_at`, so a
 *     later rewind reports those paths as "snapshot evicted" instead of
 *     pretending they were restored.
 *
 * Checkpointing is best-effort bookkeeping: it never throws into a tool call.
 */
import { createHash } from 'crypto';
import { createReadStream, promises as fsp } from 'fs';
import path from 'path';
import type { SqlDb } from '../db/sqlLike';

/** Total size the blob store may reach before the oldest blobs are evicted. */
export const STORE_CAP_BYTES = 500 * 1024 * 1024;
/** Files bigger than this are not snapshotted (recorded as `too_large`). */
export const MAX_FILE_BYTES = 50 * 1024 * 1024;

/** Where the store lives and how it is limited. Limits are overridable so
 *  tests can exercise eviction without writing hundreds of megabytes. */
export interface CheckpointStoreConfig {
  db: SqlDb;
  /** Blob directory, normally `<userData>/checkpoints`. */
  dir: string;
  capBytes?: number;
  maxFileBytes?: number;
  /** Eviction / skip log sink. Defaults to console.warn. */
  log?: (msg: string) => void;
}

/** Identity of the step about to mutate files. Without a runId nothing is
 *  checkpointed (direct, non-agent calls have no run to rewind). */
export interface CheckpointOrigin {
  runId?: string | null;
  stepId?: string | null;
  /** agent_steps.idx of the step — orders checkpoints for rewind. */
  stepIdx?: number | null;
}

let config: CheckpointStoreConfig | null = null;

/** Enable checkpointing (main process, after migrations). null disables it. */
export function configureCheckpointStore(c: CheckpointStoreConfig | null): void {
  config = c;
}

/** Whether a store is configured — lets callers skip path resolution work. */
export function checkpointsEnabled(): boolean {
  return config !== null;
}

/** Stream-hash a file (bounded memory even at the 50 MB limit). */
async function sha256File(p: string): Promise<string> {
  const h = createHash('sha256');
  await new Promise<void>((resolve, reject) => {
    createReadStream(p).on('data', (c) => h.update(c)).on('end', () => resolve()).on('error', reject);
  });
  return h.digest('hex');
}

/** Insert one checkpoint row. */
function insertRow(
  c: CheckpointStoreConfig, o: CheckpointOrigin, p: string,
  r: { sha256?: string | null; existed: boolean; size?: number | null; skipped?: string | null },
): void {
  c.db.prepare(
    `INSERT INTO checkpoint_files (run_id, step_id, step_idx, path, sha256, existed, size, skipped_reason)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(o.runId, o.stepId ?? null, o.stepIdx ?? null, p, r.sha256 ?? null, r.existed ? 1 : 0, r.size ?? null, r.skipped ?? null);
}

/** Copy `p` into the content-addressed store (if not already there) and
 *  return its sha256. Throws on any I/O error. */
async function storeBlob(c: CheckpointStoreConfig, p: string): Promise<string> {
  const sha = await sha256File(p);
  await fsp.mkdir(c.dir, { recursive: true });
  const blob = path.join(c.dir, sha);
  const have = await fsp.stat(blob).then(() => true).catch(() => false);
  if (have) {
    // Touch so a re-used blob counts as recent for oldest-first eviction.
    const now = new Date();
    await fsp.utimes(blob, now, now).catch(() => { /* best-effort */ });
  } else {
    const tmp = `${blob}.tmp-${process.pid}-${Date.now()}`;
    await fsp.copyFile(p, tmp);
    await fsp.rename(tmp, blob); // atomic: a crash never leaves a half blob under the real name
  }
  return sha;
}

/**
 * Snapshot each path's current state before a step mutates it. Call with every
 * path the operation can change — the source of a move (it will vanish), the
 * destination of a move/copy (it may be overwritten or created), the target of
 * a delete. Never throws.
 */
export async function checkpointBeforeMutation(origin: CheckpointOrigin | undefined, paths: string[]): Promise<void> {
  const c = config;
  if (!c || !origin?.runId) return;
  const max = c.maxFileBytes ?? MAX_FILE_BYTES;
  const log = c.log ?? ((m: string) => console.warn(m));
  for (const p of [...new Set(paths.filter(Boolean))]) {
    try {
      let st: import('fs').Stats;
      try {
        st = await fsp.stat(p);
      } catch {
        insertRow(c, origin, p, { existed: false }); // will be created → rewind removes it
        continue;
      }
      if (st.isDirectory()) { insertRow(c, origin, p, { existed: true, skipped: 'directory' }); continue; }
      if (st.size > max) {
        log(`[Artha] checkpoint skipped (file over ${Math.round(max / 1024 / 1024)} MB): ${p}`);
        insertRow(c, origin, p, { existed: true, size: st.size, skipped: 'too_large' });
        continue;
      }
      const sha = await storeBlob(c, p);
      insertRow(c, origin, p, { sha256: sha, existed: true, size: st.size });
      await enforceStoreCap(sha);
    } catch (err) {
      try { insertRow(c, origin, p, { existed: true, skipped: 'unreadable' }); } catch { /* db gone */ }
      log(`[Artha] checkpoint failed for ${p}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

/** Result of one eviction pass — returned for tests and logged per blob. */
export interface EvictionResult { evicted: { sha256: string; bytes: number }[]; totalBytes: number }

/**
 * Evict the oldest blobs (by mtime) until the store fits its cap. `keep` is a
 * blob that must survive this pass (the one just written). Every eviction is
 * logged and stamped on its rows.
 */
export async function enforceStoreCap(keep?: string): Promise<EvictionResult> {
  const c = config;
  if (!c) return { evicted: [], totalBytes: 0 };
  const cap = c.capBytes ?? STORE_CAP_BYTES;
  const log = c.log ?? ((m: string) => console.warn(m));
  let names: string[] = [];
  try { names = await fsp.readdir(c.dir); } catch { return { evicted: [], totalBytes: 0 }; }
  const blobs: { sha: string; bytes: number; mtime: number }[] = [];
  for (const n of names) {
    if (!/^[0-9a-f]{64}$/.test(n)) continue; // ignore tmp files
    try {
      const st = await fsp.stat(path.join(c.dir, n));
      blobs.push({ sha: n, bytes: st.size, mtime: st.mtimeMs });
    } catch { /* raced with another eviction */ }
  }
  let total = blobs.reduce((a, b) => a + b.bytes, 0);
  const evicted: EvictionResult['evicted'] = [];
  blobs.sort((a, b) => a.mtime - b.mtime || a.sha.localeCompare(b.sha));
  for (const b of blobs) {
    if (total <= cap) break;
    if (b.sha === keep) continue;
    try {
      await fsp.unlink(path.join(c.dir, b.sha));
      c.db.prepare(`UPDATE checkpoint_files SET evicted_at=unixepoch() WHERE sha256=? AND evicted_at IS NULL`).run(b.sha);
      total -= b.bytes;
      evicted.push({ sha256: b.sha, bytes: b.bytes });
      log(`[Artha] checkpoint store over ${Math.round(cap / 1024 / 1024)} MB cap: evicted oldest snapshot ${b.sha.slice(0, 12)} (${b.bytes} bytes)`);
    } catch { /* already gone */ }
  }
  return { evicted, totalBytes: total };
}

/** What a rewind did, path by path. `ok` is true only when nothing failed or
 *  was left unrestorable. */
export interface RewindReport {
  ok: boolean;
  runId: string;
  stepId: string;
  restored: string[];
  removed: string[];
  /** Paths that could not be put back, with why (too_large, evicted, …). */
  skipped: { path: string; reason: string }[];
  /** External actions (e.g. sent emails) from this run — a file rewind can
   *  never reverse these, so they are listed rather than silently ignored. */
  externalActions: { actionId: string; tool: string; state: string }[];
  /** Paths whose CURRENT version (e.g. the user's own edits made after the
   *  run) was backed up before the rewind replaced or removed it. */
  preserved: string[];
  /** Pass to rewindRunToStep to undo this rewind (put every file back the
   *  way it was just before it). Absent when the rewind changed nothing. */
  undo?: { runId: string; stepId: string };
  error?: string;
}

/** step_id used for the checkpoints a rewind records about itself. */
export const REWIND_STEP_ID = 'rewind';

interface CheckpointRow {
  id: number; path: string; sha256: string | null; existed: number;
  skipped_reason: string | null; evicted_at: number | null;
}

/**
 * Restore every file this run touched to its state immediately BEFORE step
 * `stepId` ran (that step and all later ones are undone on disk). The earliest
 * checkpoint of each path at/after the step is its pre-state.
 */
export async function rewindRunToStep(runId: string, stepId: string): Promise<RewindReport> {
  const report: RewindReport = { ok: false, runId, stepId, restored: [], removed: [], skipped: [], externalActions: [], preserved: [] };
  const c = config;
  if (!c) return { ...report, error: 'File checkpoints are not available.' };
  const db = c.db;

  // Locate the step: by its agent_steps index when known, else by the first
  // checkpoint row recorded for it.
  let fromId: number | null = null;
  let idx: number | null = null;
  try {
    const s = db.prepare(`SELECT idx FROM agent_steps WHERE run_id=? AND step_id=?`).get(runId, stepId) as { idx: number } | undefined;
    if (s) idx = Number(s.idx);
  } catch { /* agent_steps missing (tests) */ }
  const minRow = (idx !== null
    ? db.prepare(`SELECT MIN(id) AS m FROM checkpoint_files WHERE run_id=? AND step_idx >= ?`).get(runId, idx)
    : db.prepare(`SELECT MIN(id) AS m FROM checkpoint_files WHERE run_id=? AND step_id=?`).get(runId, stepId)) as { m: number | null } | undefined;
  fromId = minRow?.m ?? null;
  if (idx === null && fromId === null) return { ...report, error: 'That step was not found in this run.' };

  try {
    report.externalActions = (db.prepare(
      `SELECT action_id, tool, state FROM external_actions WHERE run_id=? AND state IN ('confirmed','dispatching') ORDER BY created_at`
    ).all(runId) as { action_id: string; tool: string; state: string }[])
      .map(a => ({ actionId: a.action_id, tool: a.tool, state: a.state }));
  } catch { /* external_actions missing (tests) */ }

  if (fromId === null) { // step exists but nothing on disk changed from it onwards
    report.ok = true;
    return report;
  }

  const rows = db.prepare(
    `SELECT id, path, sha256, existed, skipped_reason, evicted_at FROM checkpoint_files
      WHERE run_id=? AND id >= ? ORDER BY id ASC`
  ).all(runId, fromId) as CheckpointRow[];
  const firstByPath = new Map<string, CheckpointRow>();
  for (const r of rows) if (!firstByPath.has(r.path)) firstByPath.set(r.path, r);

  // Removals first (a move's destination), then restores (its source), so a
  // path that was both created and later replaced ends in its pre-state.
  const entries = [...firstByPath.values()].sort((a, b) => a.existed - b.existed);

  // Never clobber: every file the rewind is about to remove or overwrite is
  // first backed up as a checkpoint of the rewind ITSELF, so edits the user
  // made after the run survive and the rewind can be undone
  // (report.undo). If the backup fails, that file is left in place.
  const undo: CheckpointOrigin = { runId: `rewind:${runId}:${Date.now()}`, stepId: REWIND_STEP_ID, stepIdx: 0 };
  let recordedUndo = false;
  /** Back up `p` as it is now. True = safe to change it. */
  const preserveCurrent = async (p: string, st: import('fs').Stats | null): Promise<boolean> => {
    if (!st) { insertRow(c, undo, p, { existed: false }); recordedUndo = true; return true; }
    const max = c.maxFileBytes ?? MAX_FILE_BYTES;
    if (st.size > max) return false;
    const sha = await storeBlob(c, p);
    insertRow(c, undo, p, { sha256: sha, existed: true, size: st.size });
    recordedUndo = true;
    report.preserved.push(p);
    return true;
  };
  const notBackedUp = 'could not back up its current version first; left in place';

  for (const r of entries) {
    try {
      if (!r.existed) {
        const st = await fsp.lstat(r.path).catch(() => null);
        if (!st) continue; // already gone — nothing to remove
        if (!st.isFile()) { report.skipped.push({ path: r.path, reason: 'now a folder; left in place' }); continue; }
        if (!(await preserveCurrent(r.path, st).catch(() => false))) {
          report.skipped.push({ path: r.path, reason: notBackedUp }); continue;
        }
        await fsp.unlink(r.path);
        report.removed.push(r.path);
        continue;
      }
      if (r.skipped_reason) { report.skipped.push({ path: r.path, reason: r.skipped_reason }); continue; }
      if (r.evicted_at != null || !r.sha256) { report.skipped.push({ path: r.path, reason: 'snapshot evicted (store cap)' }); continue; }
      const cur = await fsp.lstat(r.path).catch(() => null);
      if (cur && !cur.isFile()) { report.skipped.push({ path: r.path, reason: 'now a folder; left in place' }); continue; }
      if (cur && (await sha256File(r.path)) === r.sha256) { report.restored.push(r.path); continue; } // already as it was
      if (!(await preserveCurrent(r.path, cur).catch(() => false))) {
        report.skipped.push({ path: r.path, reason: notBackedUp }); continue;
      }
      const blob = path.join(c.dir, r.sha256);
      await fsp.mkdir(path.dirname(r.path), { recursive: true });
      const tmp = `${r.path}.artha-restore-${Date.now()}`;
      await fsp.copyFile(blob, tmp);
      await fsp.rename(tmp, r.path);
      // System-verified, not assumed: the restored bytes must hash to the snapshot.
      if ((await sha256File(r.path)) !== r.sha256) {
        report.skipped.push({ path: r.path, reason: 'restore did not verify (hash mismatch)' });
        continue;
      }
      report.restored.push(r.path);
    } catch (err) {
      report.skipped.push({ path: r.path, reason: err instanceof Error ? err.message : String(err) });
    }
  }
  report.ok = report.skipped.length === 0;
  if (recordedUndo) report.undo = { runId: undo.runId!, stepId: REWIND_STEP_ID };
  // Cap the store once, after every restore has read its blob (evicting
  // mid-loop could drop a snapshot a later file still needed). The backups
  // just written are the newest, so they are evicted last.
  await enforceStoreCap().catch(() => { /* best-effort */ });
  return report;
}
