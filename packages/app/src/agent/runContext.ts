/**
 * Per-run execution context.
 *
 * A single AgentOrchestrator instance is shared by the desktop UI AND the LAN
 * collaboration server, and their `handleMessage` runs can interleave (the LAN
 * `/chat` handler awaits a full agent turn while the desktop user keeps typing).
 * We therefore cannot stash "who is running this turn" on the orchestrator
 * instance — it would bleed across concurrent runs. AsyncLocalStorage gives each
 * run its own context that propagates correctly across every `await` in the loop.
 *
 * Two consumers read it:
 *   - the tool-audit insert (orchestrator) — records the *actor* so a B2B admin
 *     can answer "which teammate ran what tool" (compliance requirement).
 *   - context-gathering (contextGather) — when a run originates from the LAN
 *     server, only memories explicitly marked `is_shared=1` may be injected, so
 *     a teammate's agent turn never sees the host's private memories.
 */
import { AsyncLocalStorage } from 'async_hooks';

export interface RunContext {
  /** Stable identity of who initiated the run. 'local' for the desktop user;
   *  a team member name/id (or 'lan:<key>') for a LAN request. */
  actor: string;
  /** True when the run came in over the LAN server. Gates memory visibility to
   *  shared-only so private memories never leak to remote teammates. */
  lan: boolean;
  /** True when no interactive desktop user is watching this run (scheduled
   *  tasks; LAN runs are also treated as unattended). A `confirm`-tier tool
   *  policy fails closed for these — there is nobody to approve, so the call is
   *  blocked rather than hanging on a desktop modal that no one will answer. */
  unattended?: boolean;
}

const storage = new AsyncLocalStorage<RunContext>();

/** Run `fn` with the given context bound for its entire async lifetime. */
export function runWithContext<T>(ctx: RunContext, fn: () => T): T {
  return storage.run(ctx, fn);
}

/** The current run's context, or undefined when running outside one (e.g. the
 *  desktop path that never sets it — treated as a trusted local actor). */
export function getRunContext(): RunContext | undefined {
  return storage.getStore();
}
