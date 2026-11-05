/**
 * Desktop action queue — serialises every nut-js action (click/type/key/…) so
 * the global kill switch has ONE place to stop them all.
 *
 * Actions run strictly one at a time. `stopAll()` rejects the queued ones
 * before they start and marks the in-flight one stopped: its result is
 * discarded (the caller gets `StoppedByUserError`), and long actions such as
 * typing poll `isStopped()` between chunks so they halt mid-way rather than
 * finishing a paragraph after the user hit stop.
 */

/** Machine-readable reason carried by every action rejected by the kill switch. */
export const STOPPED_BY_USER = 'stopped_by_user';

/** Rejection raised for queued/in-flight desktop actions when the user stops. */
export class StoppedByUserError extends Error {
  readonly code = STOPPED_BY_USER;
  constructor() { super(STOPPED_BY_USER); this.name = 'StoppedByUserError'; }
}

/** Handed to each action so long-running work can bail out between steps. */
export interface ActionControl {
  /** True once stopAll() has fired for this action's generation. */
  isStopped(): boolean;
}

/** A waiting action: its body plus the promise callbacks of its caller. */
interface Pending {
  run: (ctl: ActionControl) => Promise<unknown>;
  resolve: (v: unknown) => void;
  reject: (e: unknown) => void;
  generation: number;
}

/** Serial queue of desktop actions with a "stop everything" escape hatch. */
export class DesktopActionQueue {
  private queue: Pending[] = [];
  private running = false;
  /** Bumped by stopAll(); actions from an older generation are dead. */
  private generation = 0;

  /** Enqueue an action. Resolves with its result, or rejects with
   *  `StoppedByUserError` if the kill switch fires first. */
  enqueue<T>(run: (ctl: ActionControl) => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.queue.push({ run, resolve: resolve as (v: unknown) => void, reject, generation: this.generation });
      void this.drain();
    });
  }

  /** Number of actions waiting (excludes the in-flight one). */
  get pendingCount(): number { return this.queue.length; }

  /** Reject every queued action and stop the in-flight one. Returns how many
   *  actions were affected (queued + in-flight). */
  stopAll(): number {
    const affected = this.queue.length + (this.running ? 1 : 0);
    this.generation++;
    const dead = this.queue;
    this.queue = [];
    for (const p of dead) p.reject(new StoppedByUserError());
    return affected;
  }

  /** Run queued actions one by one. A stop during an action discards its
   *  result and rejects its caller instead. */
  private async drain(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while (this.queue.length) {
        const p = this.queue.shift()!;
        if (p.generation !== this.generation) { p.reject(new StoppedByUserError()); continue; }
        const ctl: ActionControl = { isStopped: () => p.generation !== this.generation };
        try {
          const v = await p.run(ctl);
          if (ctl.isStopped()) p.reject(new StoppedByUserError());
          else p.resolve(v);
        } catch (err) {
          p.reject(ctl.isStopped() ? new StoppedByUserError() : err);
        }
      }
    } finally {
      this.running = false;
    }
  }
}

/** Process-wide queue used by tools/desktop.ts and the kill switch. */
export const desktopActionQueue = new DesktopActionQueue();
