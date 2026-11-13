/**
 * Pure helpers for the composer's outbox ("type while Artha works") UI —
 * kept DOM-free so they are unit-testable under the node vitest environment.
 */

/** Minimal snapshot shape these helpers read (structural subset of the
 *  preload's OutboxSnapshot). */
export interface OutboxSnapshotLike {
  items: { id: string; status: string }[];
  paused: boolean;
  pausedReason: 'user' | 'cancel' | 'stop' | null;
  steering: string[];
  active: boolean;
}

/** Whether the composer's primary action sends now or queues. A run counts as
 *  active if either the renderer (streaming) or main (outbox driver) says so. */
export function composerMode(isStreaming: boolean, snapshot: Pick<OutboxSnapshotLike, 'active'> | null): 'send' | 'queue' {
  return isStreaming || !!snapshot?.active ? 'queue' : 'send';
}

/** The queue panel's status line, or null when there is nothing to say. A
 *  cancel-triggered pause is called out explicitly so the user knows why
 *  their queued messages did not go out. */
export function queueStatusLine(snapshot: OutboxSnapshotLike | null): string | null {
  if (!snapshot || snapshot.items.length === 0) return null;
  if (snapshot.paused) {
    if (snapshot.pausedReason === 'cancel') return 'Queue paused after cancel';
    // The global stop shortcut (kill switch) stopped the run.
    if (snapshot.pausedReason === 'stop') return 'Queue paused after stop';
    return 'Queue paused';
  }
  const n = snapshot.items.length;
  return snapshot.active
    ? `${n} queued — sends when Artha finishes`
    : `${n} queued`;
}

/** Drag-and-drop reorder: move the id at `from` to index `to`, returning a
 *  new array (input untouched). Out-of-range indexes return a copy. */
export function moveId(ids: string[], from: number, to: number): string[] {
  const out = [...ids];
  if (from < 0 || from >= out.length || to < 0 || to >= out.length || from === to) return out;
  const [moved] = out.splice(from, 1);
  out.splice(to, 0, moved);
  return out;
}
