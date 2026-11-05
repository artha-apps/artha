/**
 * Mirrors unified interactions (agent/interactions.ts) into the run event log
 * (agent/runEvents.ts) as `interaction` events, so a run's timeline shows
 * where it paused for the user and how that pause ended.
 *
 * - `ask` (ask_user cards) and `plan` (plan review) are mirrored here.
 * - `confirm` is NOT mirrored: requestToolApproval already records its own
 *   request/response events (with the tool name), so mirroring would double it.
 * - `handoff` is left out: the browser hand-off has no run id of its own.
 *
 * The `request` phase also tells the run's stall watchdog that the run is
 * waiting on the user (startRunMonitor), and `response` re-arms it.
 * Notification-only: nothing here can change an interaction's outcome.
 */
import type { InteractionHub, InteractionKind, InteractionLifecycleEvent } from './interactions';
import type { RunEventKind } from './runEvents';

const MIRRORED: ReadonlySet<InteractionKind> = new Set<InteractionKind>(['ask', 'plan']);

/** Event payload for one lifecycle change, or null when it is not mirrored. */
export function interactionRunEventPayload(ev: InteractionLifecycleEvent): Record<string, unknown> | null {
  if (!MIRRORED.has(ev.kind) || !ev.runId) return null;
  return ev.phase === 'request'
    ? { phase: 'request', interactionId: ev.id, interactionKind: ev.kind }
    : { phase: 'response', interactionId: ev.id, interactionKind: ev.kind, status: ev.status ?? null };
}

/** Subscribe `record` (normally recordRunEvent) to the hub. Returns the
 *  unsubscribe fn. Idempotent per hub. */
const installed = new WeakMap<InteractionHub, () => void>();
export function installInteractionRunEvents(
  hub: InteractionHub,
  record: (runId: string, kind: RunEventKind, payload: unknown) => unknown,
): () => void {
  const existing = installed.get(hub);
  if (existing) return existing;
  const off = hub.observe(ev => {
    const payload = interactionRunEventPayload(ev);
    if (payload) record(ev.runId, 'interaction', payload);
  });
  const un = (): void => { off(); installed.delete(hub); };
  installed.set(hub, un);
  return un;
}
