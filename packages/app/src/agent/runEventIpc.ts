/**
 * Per-client bookkeeping for `run:subscribe` / `run:unsubscribe`.
 *
 * Kept separate from ipc/handlers.ts so the subscription lifecycle is unit
 * testable without Electron. A "client" is anything with a stable id that
 * receives messages — the renderer's webContents today, a LAN client later.
 */
import { subscribeRunEvents, type RunEvent } from './runEvents';

/** Message pushed to a subscribed client on the `run:event` channel. */
export interface RunEventMessage {
  event: RunEvent;
  /** true = delivered from history (the client missed it); false = live. */
  replayed: boolean;
}

/** Registry of live subscriptions keyed by client + run. */
export interface RunSubscriptions {
  /** Replay events after `fromSeq`, then stream live ones to `send`. A repeat
   *  subscribe for the same client + run replaces the previous one, so a
   *  reconnecting client never receives the same stream twice. */
  subscribe(clientId: number | string, runId: string, fromSeq: number, send: (msg: RunEventMessage) => void): void;
  /** Stop one client's stream for one run. Returns whether one existed. */
  unsubscribe(clientId: number | string, runId: string): boolean;
  /** Drop every subscription a client holds (window destroyed / reloaded). */
  unsubscribeClient(clientId: number | string): void;
  /** Number of live subscriptions (diagnostics + tests). */
  size(): number;
}

/** Create an empty registry. One per process is expected. */
export function createRunSubscriptions(): RunSubscriptions {
  const subs = new Map<string, () => void>();
  const key = (clientId: number | string, runId: string): string => `${clientId}\u0000${runId}`;

  return {
    subscribe(clientId, runId, fromSeq, send) {
      const k = key(clientId, runId);
      subs.get(k)?.();
      subs.delete(k);
      // A send to a torn-down client must not throw into the agent loop that
      // appended the event — mark the subscription dead and drop it instead.
      // `dead` also covers a failure DURING replay, before `off` exists.
      let dead = false;
      let off: (() => void) | null = null;
      off = subscribeRunEvents(runId, fromSeq, (event, replayed) => {
        if (dead) return;
        try { send({ event, replayed }); } catch {
          dead = true;
          if (off) { off(); subs.delete(k); }
        }
      });
      if (dead) off();
      else subs.set(k, off);
    },
    unsubscribe(clientId, runId) {
      const k = key(clientId, runId);
      const off = subs.get(k);
      if (!off) return false;
      off();
      subs.delete(k);
      return true;
    },
    unsubscribeClient(clientId) {
      const prefix = `${clientId}\u0000`;
      for (const [k, off] of [...subs]) {
        if (k.startsWith(prefix)) { off(); subs.delete(k); }
      }
    },
    size: () => subs.size,
  };
}
