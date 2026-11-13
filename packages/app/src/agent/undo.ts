/**
 * Undo registry for reversible filesystem actions the agent performed.
 *
 * Artha's blast-radius already classifies these ops as reversible; this is the
 * other half — actually reversing them. Every successful mutating `fs_*` tool
 * call is recorded here with enough information to invert it:
 *
 *   move / move_batch → move back (dest → source)
 *   copy             → delete the copy
 *   create_directory → remove the created dir (only if still empty)
 *   delete (trashed) → restore from ~/.Trash
 *   delete (permanent) → NOT recorded here (no Trash copy exists; the file
 *                        checkpoint store in agent/checkpoints.ts covers it)
 *
 * Storage: once `configureUndoStore(db)` has been called (main process, after
 * migrations) entries live in the `undo_entries` table, so "Undo" survives an
 * app restart. Before that — and in unit tests that don't configure a DB — an
 * in-memory list is used with identical semantics. Either way each session
 * keeps at most MAX_ENTRIES_PER_SESSION entries; older ones are pruned.
 */
import { promises as fsp } from 'fs';
import path from 'path';
import type { SqlDb } from '../db/sqlLike';

export type UndoKind = 'move' | 'move_batch' | 'copy' | 'create_dir' | 'trash';

export interface UndoEntry {
  id: string;
  kind: UndoKind;
  /** Human-readable summary, e.g. "Moved report.pdf → Documents". */
  label: string;
  ts: number;
  undone: boolean;
  // Reversal payloads (only the relevant one is set per kind):
  pairs?: { from: string; to: string }[]; // move/move_batch: undo = rename `to`→`from`
  copied?: string;                          // copy: undo = unlink this path
  created?: string;                         // create_dir: undo = rmdir this path
  trashFrom?: string;                       // trash: original path
  trashTo?: string;                         // trash: ~/.Trash path
}

/** Which run/session/step produced an action — persisted alongside it so the
 *  undo list can be scoped per session and traced back to the step. */
export interface UndoOrigin {
  runId?: string | null;
  sessionId?: string | null;
  stepId?: string | null;
}

/** Per-session cap. The same limit the old in-memory stack had globally. */
export const MAX_ENTRIES_PER_SESSION = 50;

/** In-memory fallback (pre-DB / tests). Entry + its session bucket. */
const memory: { entry: UndoEntry; session: string }[] = [];
/** Persistent backend; null until configureUndoStore() is called. */
let store: SqlDb | null = null;

/** Point the registry at the app database (call after runMigrations()).
 *  Passing null reverts to the in-memory fallback (used by tests). */
export function configureUndoStore(db: SqlDb | null): void {
  store = db;
}

/** Fields of an entry that are serialised into payload_json. */
type UndoPayload = Omit<UndoEntry, 'id' | 'kind' | 'ts' | 'undone'>;

/** Map a DB row back to an UndoEntry. */
function fromRow(r: { id: string; op: string; payload_json: string; created_at: number; undone_at: number | null }): UndoEntry {
  let p: UndoPayload = { label: '' };
  try { p = JSON.parse(r.payload_json) as UndoPayload; } catch { /* corrupt payload → label-less entry */ }
  return { ...p, id: r.id, kind: r.op as UndoKind, ts: Number(r.created_at), undone: r.undone_at != null };
}

function push(entry: Omit<UndoEntry, 'id' | 'ts' | 'undone'>, origin?: UndoOrigin): void {
  const full: UndoEntry = { id: cryptoRandomId(), ts: Date.now(), undone: false, ...entry };
  const session = origin?.sessionId ?? '';
  if (store) {
    const { id, kind, ts, undone: _u, ...payload } = full;
    store.prepare(
      `INSERT INTO undo_entries (id, run_id, session_id, step_id, op, payload_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(id, origin?.runId ?? null, session, origin?.stepId ?? null, kind, JSON.stringify(payload), ts);
    // Prune this session to its newest MAX entries (rowid breaks same-ms ties).
    store.prepare(
      `DELETE FROM undo_entries WHERE session_id=? AND id NOT IN (
         SELECT id FROM undo_entries WHERE session_id=? ORDER BY created_at DESC, rowid DESC LIMIT ?)`
    ).run(session, session, MAX_ENTRIES_PER_SESSION);
    return;
  }
  memory.push({ entry: full, session });
  const mine = memory.filter((m) => m.session === session);
  for (const old of mine.slice(0, Math.max(0, mine.length - MAX_ENTRIES_PER_SESSION))) {
    memory.splice(memory.indexOf(old), 1);
  }
}

/** Look up one entry by id in whichever backend is active. */
function getEntry(id: string): UndoEntry | null {
  if (store) {
    const r = store.prepare(`SELECT id, op, payload_json, created_at, undone_at FROM undo_entries WHERE id=?`).get(id) as
      Parameters<typeof fromRow>[0] | undefined;
    return r ? fromRow(r) : null;
  }
  return memory.find((m) => m.entry.id === id)?.entry ?? null;
}

/** Not-yet-undone entries, newest first, optionally limited to one session. */
function activeEntries(limit: number, sessionId?: string): UndoEntry[] {
  if (store) {
    const rows = (sessionId !== undefined
      ? store.prepare(
          `SELECT id, op, payload_json, created_at, undone_at FROM undo_entries
            WHERE undone_at IS NULL AND session_id=? ORDER BY created_at DESC, rowid DESC LIMIT ?`
        ).all(sessionId, limit)
      : store.prepare(
          `SELECT id, op, payload_json, created_at, undone_at FROM undo_entries
            WHERE undone_at IS NULL ORDER BY created_at DESC, rowid DESC LIMIT ?`
        ).all(limit)) as Parameters<typeof fromRow>[0][];
    return rows.map(fromRow);
  }
  return memory
    .filter((m) => !m.entry.undone && (sessionId === undefined || m.session === sessionId))
    .map((m) => m.entry)
    .slice(-limit)
    .reverse();
}

/** Persist the "undone" flag. */
function markUndone(entry: UndoEntry): void {
  entry.undone = true;
  if (store) store.prepare(`UPDATE undo_entries SET undone_at=? WHERE id=?`).run(Date.now(), entry.id);
}

function cryptoRandomId(): string {
  // crypto.randomUUID is available in the Electron main (Node 18+).
  return (globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.round(Math.random() * 1e9)}`);
}

/**
 * Record a reversible action from a successful filesystem tool result. Parses
 * the impl's JSON return; silently ignores anything it can't invert so undo
 * bookkeeping can never break a tool call.
 */
export function recordFilesystemEffect(toolName: string, resultJson: string, origin?: UndoOrigin): void {
  let r: Record<string, unknown>;
  try { r = JSON.parse(resultJson) as Record<string, unknown>; } catch { return; }
  if (r.error || r.success === false) return;

  switch (toolName) {
    case 'fs_move_file': {
      const from = r.moved as string, to = r.to as string;
      if (from && to) push({ kind: 'move', label: `Moved ${path.basename(from)} → ${path.basename(path.dirname(to))}/`, pairs: [{ from, to }] }, origin);
      break;
    }
    case 'fs_move_batch': {
      const results = (r.results as Array<{ source: string; to?: string; ok: boolean }> | undefined) ?? [];
      const pairs = results.filter((x) => x.ok && x.to).map((x) => ({ from: x.source, to: x.to! }));
      if (pairs.length) push({ kind: 'move_batch', label: `Moved ${pairs.length} item${pairs.length > 1 ? 's' : ''}`, pairs }, origin);
      break;
    }
    case 'fs_copy_file': {
      const to = r.to as string;
      if (to) push({ kind: 'copy', label: `Copied → ${path.basename(to)}`, copied: to }, origin);
      break;
    }
    case 'fs_write_file': {
      // A NEW file can be undone by removing it. An overwrite is not listed
      // here: the previous version lives in the run's checkpoint (rewind).
      const written = r.written as string;
      if (written && r.created === true) push({ kind: 'copy', label: `Created ${path.basename(written)}`, copied: written }, origin);
      break;
    }
    case 'fs_create_directory': {
      const created = r.created as string;
      if (created) push({ kind: 'create_dir', label: `Created folder ${path.basename(created)}`, created }, origin);
      break;
    }
    case 'fs_delete_file': {
      // Only the trashed (recoverable) path is reversible; permanent deletes
      // have no backup and are deliberately not recorded.
      const from = r.trashed as string, to = r.location as string;
      if (from && to) push({ kind: 'trash', label: `Deleted ${path.basename(from)} (to Trash)`, trashFrom: from, trashTo: to }, origin);
      break;
    }
    default:
      break;
  }
}

/** Reversible actions not yet undone, newest first. `sessionId` scopes the
 *  list to one chat; omitted = all sessions (the original global behaviour). */
export function listUndoable(limit = 20, sessionId?: string): Pick<UndoEntry, 'id' | 'kind' | 'label' | 'ts'>[] {
  return activeEntries(limit, sessionId).map(({ id, kind, label, ts }) => ({ id, kind, label, ts }));
}

/** Reverse a recorded action. Marks it undone on success. */
export async function revert(id: string): Promise<{ ok: boolean; error?: string; label?: string }> {
  const entry = getEntry(id);
  if (!entry) return { ok: false, error: 'That action is no longer available to undo.' };
  if (entry.undone) return { ok: false, error: 'Already undone.' };
  try {
    switch (entry.kind) {
      case 'move':
      case 'move_batch': {
        // Reverse in reverse order so nested moves unwind cleanly. NEVER
        // clobber: fs.rename overwrites the destination silently, so undoing a
        // move after the user created a new file at the original path would
        // destroy that new file and still report success (audit H20). Refuse
        // any pair whose origin is now occupied, and report a partial undo
        // instead of a false clean one.
        const pairs = [...(entry.pairs ?? [])].reverse();
        const skipped: string[] = [];
        let reverted = 0;
        for (const p of pairs) {
          const originTaken = await fsp.access(p.from).then(() => true).catch(() => false);
          const sourceGone = await fsp.access(p.to).then(() => false).catch(() => true);
          if (originTaken || sourceGone) { skipped.push(p.from); continue; }
          await fsp.mkdir(path.dirname(p.from), { recursive: true });
          await fsp.rename(p.to, p.from);
          reverted++;
        }
        if (skipped.length) {
          // A partial revert is not a success. Leave the entry NOT undone so
          // the user can see it still needs attention.
          return {
            ok: false,
            error: reverted > 0
              ? `Reverted ${reverted} of ${pairs.length} change(s); ${skipped.length} could not be undone because their original location is now occupied or the moved file is missing.`
              : `Nothing was reverted: the original location(s) are occupied or the moved file(s) are missing.`,
          };
        }
        break;
      }
      case 'copy':
        if (entry.copied) {
          if (await fsp.access(entry.copied).then(() => true).catch(() => false)) {
            await fsp.unlink(entry.copied);
          } else {
            return { ok: false, error: 'The copied file is already gone; nothing to undo.' };
          }
        }
        break;
      case 'create_dir':
        // Only remove if still empty — never clobber files the user added since.
        if (entry.created) await fsp.rmdir(entry.created);
        break;
      case 'trash':
        if (entry.trashFrom && entry.trashTo) {
          await fsp.mkdir(path.dirname(entry.trashFrom), { recursive: true });
          await fsp.rename(entry.trashTo, entry.trashFrom);
        }
        break;
    }
    markUndone(entry);
    return { ok: true, label: entry.label };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // ENOTEMPTY on create_dir undo is expected when the user added files — report it kindly.
    return { ok: false, error: entry.kind === 'create_dir' && /ENOTEMPTY/.test(msg)
      ? 'Folder isn’t empty anymore, so it was left in place.'
      : msg };
  }
}

/** Most recent reversible action, or null. Used for the "Undo last" shortcut. */
export function mostRecentUndoable(sessionId?: string): Pick<UndoEntry, 'id' | 'label'> | null {
  const e = activeEntries(1, sessionId)[0];
  return e ? { id: e.id, label: e.label } : null;
}
