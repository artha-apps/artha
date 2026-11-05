/**
 * OutboxDriver — decides WHEN queued outbox items are sent.
 *
 * The orchestrator reports run lifecycle per chat session (`runStarted` /
 * `runEnded`) and asks for steer messages at every ReAct tool-call boundary
 * (`takeSteerAtBoundary`). The driver never sends while:
 *   - a run is active in the session (items wait for it to end),
 *   - a confirm-tier tool approval, plan approval or clarification is pending
 *     (`hasPendingApproval`), or
 *   - the session's queue is paused — including the automatic pause after the
 *     user cancels a run ("Queue paused after cancel").
 *
 * Exactly-once comes from outbox.claim()/drainNext(): an item is only handed
 * off after a guarded ready→sending UPDATE changed exactly one row, and it is
 * marked `sent` as soon as its user message row is persisted.
 *
 * Dependencies are injected so the policy is unit-testable without Electron.
 */
import * as outbox from './outbox';
import type { OutboxAttachment, OutboxDb, OutboxItem } from './outbox';

/** What the driver needs from its host (the orchestrator in production). */
export interface OutboxDriverDeps {
  /** DB handle override (tests); production uses the app connection. */
  db?: OutboxDb;
  /** Persist the item as a user message in the session (synchronous). A throw
   *  returns the item to `ready` so it is not lost. */
  persistUserMessage(sessionId: string, content: string): void;
  /** Start a new user turn in the session. Must call runStarted() before its
   *  first await and runEnded() when it finishes (the orchestrator's
   *  handleMessage does both). */
  startTurn(sessionId: string, content: string, attachments: OutboxAttachment[]): Promise<void>;
  /** True while a confirm-tier approval / plan approval / clarification is
   *  waiting on the user in this session. */
  hasPendingApproval(sessionId: string): boolean;
  /** Push a renderer event (outbox:updated, outbox:sent, outbox:turnFailed). */
  emit(channel: string, payload: unknown): void;
}

/** How an item left the queue: as a fresh turn, or injected into a live run. */
export type OutboxSendMode = 'drain' | 'steer';

export class OutboxDriver {
  /** Sessions with a run in flight (refcounted: a turn can nest a re-entry). */
  private active = new Map<string, number>();
  /** Items the user asked to "steer now", per session, in request order. */
  private steerRequests = new Map<string, string[]>();

  constructor(private deps: OutboxDriverDeps) {}

  /** Whether a run is currently in flight in the session. */
  isActive(sessionId: string): boolean {
    return (this.active.get(sessionId) ?? 0) > 0;
  }

  /** A run started in the session: queued items now wait for it. */
  runStarted(sessionId: string): void {
    this.active.set(sessionId, (this.active.get(sessionId) ?? 0) + 1);
  }

  /** A run in the session reached a terminal state. A user-cancelled run pauses
   *  the queue instead of draining; any other outcome drains the next item.
   *  Un-injected steer requests fall back to the normal drain (they were
   *  already moved to the front of the queue). */
  runEnded(sessionId: string, opts: { cancelled?: boolean } = {}): void {
    const n = (this.active.get(sessionId) ?? 0) - 1;
    if (n > 0) { this.active.set(sessionId, n); return; }
    this.active.delete(sessionId);
    this.steerRequests.delete(sessionId);
    if (opts.cancelled) {
      // Only worth pausing (and telling the user) if something is waiting.
      if (outbox.list(sessionId, this.deps.db).length > 0) {
        outbox.pause(sessionId, 'cancel', this.deps.db);
      }
      this.notify(sessionId);
      return;
    }
    // Nothing drained ⇒ still tell the renderer the run is over, so the
    // composer flips Queue back to Send.
    void this.tryDrain(sessionId).then(item => { if (!item) this.notify(sessionId); });
  }

  /** Send the next ready item as a new turn if nothing blocks it. Returns the
   *  item that was handed off, or null. Safe to call at any time and from any
   *  number of callers: the claim is atomic. */
  async tryDrain(sessionId: string): Promise<OutboxItem | null> {
    if (this.isActive(sessionId) || this.deps.hasPendingApproval(sessionId)) return null;
    const item = outbox.drainNext(sessionId, this.deps.db);
    if (!item) return null;
    return this.handOff(item);
  }

  /** User pressed "steer now" on an item. During an active run it is injected
   *  at the next tool-call boundary (and moved to the front so the end-of-run
   *  drain sends it first if no boundary comes). With no run active it is sent
   *  right away as a new turn. Returns false if the item is not steerable. */
  async requestSteer(itemId: string): Promise<boolean> {
    const item = outbox.getItem(itemId, this.deps.db);
    if (!item || item.status !== 'ready') return false;
    outbox.moveToFront(itemId, this.deps.db);
    if (this.isActive(item.sessionId)) {
      const reqs = this.steerRequests.get(item.sessionId) ?? [];
      if (!reqs.includes(itemId)) reqs.push(itemId);
      this.steerRequests.set(item.sessionId, reqs);
      this.notify(item.sessionId);
      return true;
    }
    // Not running: an explicit steer is a direct "send this now" — but still
    // never past a pending approval.
    if (this.deps.hasPendingApproval(item.sessionId)) return false;
    const claimed = outbox.claim(itemId, this.deps.db);
    if (!claimed) return false;
    this.handOff(claimed);
    return true;
  }

  /** Steer items currently requested for the session (ids, in order). */
  pendingSteers(sessionId: string): string[] {
    return [...(this.steerRequests.get(sessionId) ?? [])];
  }

  /** Called by the ReAct loop between iterations (a tool-call boundary).
   *  Atomically claims each requested steer item, persists it as a user
   *  message, marks it sent, and returns them for injection into the live
   *  conversation. Returns [] while an approval is pending. */
  takeSteerAtBoundary(sessionId: string): OutboxItem[] {
    const reqs = this.steerRequests.get(sessionId);
    if (!reqs || reqs.length === 0) return [];
    if (this.deps.hasPendingApproval(sessionId)) return [];
    this.steerRequests.delete(sessionId);
    const out: OutboxItem[] = [];
    for (const id of reqs) {
      const claimed = outbox.claim(id, this.deps.db);
      if (!claimed) continue; // edited, cancelled or already sent — skip
      try {
        this.deps.persistUserMessage(sessionId, claimed.content);
      } catch (err) {
        outbox.release(id, this.deps.db);
        console.warn('[Artha] outbox steer persist failed; item returned to queue:', err);
        continue;
      }
      outbox.markSent(id, this.deps.db);
      out.push(claimed);
      this.deps.emit('outbox:sent', { sessionId, item: claimed, mode: 'steer' satisfies OutboxSendMode });
    }
    this.notify(sessionId);
    return out;
  }

  /** Re-broadcast the session's queue + pause state to the renderer. */
  notify(sessionId: string): void {
    try {
      this.deps.emit('outbox:updated', this.snapshot(sessionId));
    } catch { /* renderer push is best-effort */ }
  }

  /** The renderer-facing state of one session's queue. */
  snapshot(sessionId: string): {
    sessionId: string; items: OutboxItem[]; paused: boolean; pausedReason: 'user' | 'cancel' | null;
    steering: string[]; active: boolean;
  } {
    const pause = outbox.getPauseState(sessionId, this.deps.db);
    return {
      sessionId,
      items: outbox.list(sessionId, this.deps.db),
      paused: pause.paused,
      pausedReason: pause.reason,
      steering: this.pendingSteers(sessionId),
      active: this.isActive(sessionId),
    };
  }

  /** Persist → mark sent → start the turn, for an item already claimed
   *  (status `sending`). Persist failure releases it back to `ready`. */
  private handOff(item: OutboxItem): OutboxItem | null {
    try {
      this.deps.persistUserMessage(item.sessionId, item.content);
    } catch (err) {
      outbox.release(item.id, this.deps.db);
      console.warn('[Artha] outbox persist failed; item returned to queue:', err);
      this.notify(item.sessionId);
      return null;
    }
    outbox.markSent(item.id, this.deps.db);
    this.deps.emit('outbox:sent', { sessionId: item.sessionId, item, mode: 'drain' satisfies OutboxSendMode });
    this.notify(item.sessionId);
    // startTurn marks the session active synchronously, so no second drain can
    // start until this turn ends (and its runEnded drains the next item). The
    // turn runs in the background: callers get the handed-off item right away.
    let started: Promise<void>;
    try {
      started = this.deps.startTurn(item.sessionId, item.content, item.attachments);
    } catch (err) {
      started = Promise.reject(err);
    }
    started.catch((err: unknown) => {
      const detail = err instanceof Error ? err.message : String(err);
      this.deps.emit('outbox:turnFailed', { sessionId: item.sessionId, itemId: item.id, error: detail });
    });
    return item;
  }
}

/** A chat message the ReAct loop can append (structural subset of OpenAI's type). */
export interface SteerMessage { role: 'user'; content: string }

/**
 * Tool-call boundary hook for the ReAct loop: take any "steer now" items for
 * the session and append them to the live conversation as user turns, so the
 * model sees them on its very next call. Returns the injected items (empty
 * when nothing was requested or an approval is pending).
 */
export function injectSteerAtBoundary(
  driver: Pick<OutboxDriver, 'takeSteerAtBoundary'>,
  sessionId: string,
  messages: Array<{ role: string; content?: unknown }>,
): OutboxItem[] {
  const items = driver.takeSteerAtBoundary(sessionId);
  for (const it of items) {
    const msg: SteerMessage = {
      role: 'user',
      content: `${it.content}\n\n(Sent by the user while you were working — take it into account from here on.)`,
    };
    messages.push(msg);
  }
  return items;
}
