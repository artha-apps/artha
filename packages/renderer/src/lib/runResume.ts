/**
 * Run resume cursor for the chat run view.
 *
 * The main process persists every run's lifecycle to an event log with a
 * per-run `seq` (app/src/agent/runEvents.ts). This module keeps the renderer's
 * cursor — which run it is watching and the last seq it has seen — in
 * localStorage, so that after a reload the run view can call
 * `run.subscribe(runId, lastSeq)` and receive exactly the events it missed.
 *
 * Pure (storage is injected) so it is unit-testable without a DOM.
 */

/** Minimal storage surface (localStorage satisfies it). */
export interface CursorStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** The persisted cursor. */
export interface RunCursor {
  runId: string;
  lastSeq: number;
}

/** Subset of a run event this module reads. */
export interface RunEventLike {
  runId: string;
  seq: number;
  kind: string;
  payload: unknown;
}

/** What the run view should do with one delivered event. */
export type RunViewAction =
  | { type: 'status'; text: string }
  | { type: 'tool'; ev: { type: 'tool_invoke' | 'tool_result'; name?: string; args?: string; result?: string; status?: string } }
  | { type: 'ended' }
  | { type: 'none' };

/** localStorage key for the cursor. */
export const RUN_CURSOR_KEY = 'artha_run_cursor';

/** Read the saved cursor; null when absent, malformed, or storage is blocked. */
export function loadRunCursor(storage: CursorStorage): RunCursor | null {
  try {
    const raw = storage.getItem(RUN_CURSOR_KEY);
    if (!raw) return null;
    const c = JSON.parse(raw) as Partial<RunCursor>;
    if (typeof c.runId !== 'string' || !c.runId) return null;
    return { runId: c.runId, lastSeq: Number.isFinite(c.lastSeq) ? Math.max(0, Number(c.lastSeq)) : 0 };
  } catch { return null; }
}

/** Persist a cursor (best-effort; storage may throw in locked-down contexts). */
export function saveRunCursor(storage: CursorStorage, c: RunCursor): void {
  try { storage.setItem(RUN_CURSOR_KEY, JSON.stringify(c)); } catch { /* best-effort */ }
}

/** Forget the cursor (run ended). */
export function clearRunCursor(storage: CursorStorage): void {
  try { storage.removeItem(RUN_CURSOR_KEY); } catch { /* best-effort */ }
}

/**
 * Advance the cursor for a delivered event and decide what the view should do.
 *
 * - Events for another run, or at/below lastSeq, are ignored (no double apply).
 * - Live events only move the cursor: the existing agent:* IPC stream already
 *   rendered them. Replayed events (missed during a reload) are turned into
 *   status/tool actions so the view catches up.
 * - A terminal event clears the cursor and tells the view the run ended. It
 *   does NOT say the task succeeded — that is verified elsewhere.
 */
export function applyRunEvent(
  storage: CursorStorage,
  ev: RunEventLike,
  replayed: boolean,
): RunViewAction {
  const cur = loadRunCursor(storage);
  if (!cur || cur.runId !== ev.runId || ev.seq <= cur.lastSeq) return { type: 'none' };
  if (ev.kind === 'done' || ev.kind === 'error') {
    clearRunCursor(storage);
    return { type: 'ended' };
  }
  saveRunCursor(storage, { runId: ev.runId, lastSeq: ev.seq });
  if (!replayed) return { type: 'none' };
  const p = (ev.payload ?? {}) as Record<string, unknown>;
  switch (ev.kind) {
    case 'status':
      return typeof p.text === 'string' ? { type: 'status', text: p.text } : { type: 'none' };
    case 'tool_call':
      return { type: 'tool', ev: { type: 'tool_invoke', name: String(p.name ?? ''), args: typeof p.args === 'string' ? p.args : undefined } };
    case 'tool_result':
      return {
        type: 'tool',
        ev: {
          type: 'tool_result', name: String(p.name ?? ''),
          result: typeof p.result === 'string' ? p.result : undefined,
          status: typeof p.status === 'string' ? p.status : undefined,
        },
      };
    default:
      return { type: 'none' };
  }
}
