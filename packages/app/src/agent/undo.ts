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
 *   delete (permanent) → NOT recorded (no backup exists; gated by explicit intent)
 *
 * State is in-memory (process lifetime) on purpose: "undo what the agent just
 * did" is a recent-actions affordance, and keeping it out of SQLite avoids a
 * schema migration. The cap bounds memory; oldest entries fall off.
 */
import { promises as fsp } from 'fs';
import path from 'path';

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

const MAX_ENTRIES = 50;
const stack: UndoEntry[] = [];

function push(entry: Omit<UndoEntry, 'id' | 'ts' | 'undone'>): void {
  stack.push({ id: cryptoRandomId(), ts: Date.now(), undone: false, ...entry });
  if (stack.length > MAX_ENTRIES) stack.splice(0, stack.length - MAX_ENTRIES);
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
export function recordFilesystemEffect(toolName: string, resultJson: string): void {
  let r: Record<string, unknown>;
  try { r = JSON.parse(resultJson) as Record<string, unknown>; } catch { return; }
  if (r.error || r.success === false) return;

  switch (toolName) {
    case 'fs_move_file': {
      const from = r.moved as string, to = r.to as string;
      if (from && to) push({ kind: 'move', label: `Moved ${path.basename(from)} → ${path.basename(path.dirname(to))}/`, pairs: [{ from, to }] });
      break;
    }
    case 'fs_move_batch': {
      const results = (r.results as Array<{ source: string; to?: string; ok: boolean }> | undefined) ?? [];
      const pairs = results.filter((x) => x.ok && x.to).map((x) => ({ from: x.source, to: x.to! }));
      if (pairs.length) push({ kind: 'move_batch', label: `Moved ${pairs.length} item${pairs.length > 1 ? 's' : ''}`, pairs });
      break;
    }
    case 'fs_copy_file': {
      const to = r.to as string;
      if (to) push({ kind: 'copy', label: `Copied → ${path.basename(to)}`, copied: to });
      break;
    }
    case 'fs_create_directory': {
      const created = r.created as string;
      if (created) push({ kind: 'create_dir', label: `Created folder ${path.basename(created)}`, created });
      break;
    }
    case 'fs_delete_file': {
      // Only the trashed (recoverable) path is reversible; permanent deletes
      // have no backup and are deliberately not recorded.
      const from = r.trashed as string, to = r.location as string;
      if (from && to) push({ kind: 'trash', label: `Deleted ${path.basename(from)} (to Trash)`, trashFrom: from, trashTo: to });
      break;
    }
    default:
      break;
  }
}

/** Reversible actions not yet undone, newest first. */
export function listUndoable(limit = 20): Pick<UndoEntry, 'id' | 'kind' | 'label' | 'ts'>[] {
  return stack
    .filter((e) => !e.undone)
    .slice(-limit)
    .reverse()
    .map(({ id, kind, label, ts }) => ({ id, kind, label, ts }));
}

/** Reverse a recorded action. Marks it undone on success. */
export async function revert(id: string): Promise<{ ok: boolean; error?: string; label?: string }> {
  const entry = stack.find((e) => e.id === id);
  if (!entry) return { ok: false, error: 'That action is no longer available to undo.' };
  if (entry.undone) return { ok: false, error: 'Already undone.' };
  try {
    switch (entry.kind) {
      case 'move':
      case 'move_batch': {
        // Reverse in reverse order so nested moves unwind cleanly.
        for (const p of [...(entry.pairs ?? [])].reverse()) {
          await fsp.mkdir(path.dirname(p.from), { recursive: true });
          await fsp.rename(p.to, p.from);
        }
        break;
      }
      case 'copy':
        if (entry.copied) await fsp.unlink(entry.copied);
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
    entry.undone = true;
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
export function mostRecentUndoable(): Pick<UndoEntry, 'id' | 'label'> | null {
  for (let i = stack.length - 1; i >= 0; i--) {
    if (!stack[i].undone) return { id: stack[i].id, label: stack[i].label };
  }
  return null;
}
