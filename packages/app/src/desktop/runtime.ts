/**
 * Process-wide wiring for the desktop kill switch.
 *
 * Chat, scheduled and LAN runs share one AgentOrchestrator, but loops nest and
 * run concurrently, so the kill switch can't hold "the" current run. Instead
 * every ReAct loop registers itself here with a cancel callback on start and
 * unregisters on exit; a stop press cancels every registered loop.
 *
 * `installKillSwitch()` is called once from main.ts with the real Electron
 * side effects. Until then (and in tests) `trackRun` is a cheap no-op apart
 * from bookkeeping, so the orchestrator never depends on Electron being up.
 */
import { KillSwitch, type KillSwitchDeps, type StopReport } from './killSwitch';

/** What a running loop leaves behind so the stop press can cancel and receipt it. */
export interface TrackedRun {
  workflowId: string;
  runId: string;
  sessionId: string;
  /** Cancels this run through the orchestrator's normal cancel path. */
  cancel: () => void;
}

/** Live loops keyed by a per-registration token (a workflowId may nest). */
const runs = new Map<symbol, TrackedRun>();
/** Workflows the kill switch has stopped — consulted where a run would
 *  otherwise be marked completed, so a stop can never be reported as done. */
const stoppedByUser = new Set<string>();
let killSwitch: KillSwitch | null = null;

/** Electron-side effects main.ts supplies; run bookkeeping is handled here. */
export type InstallDeps = Omit<KillSwitchDeps, 'cancelRuns' | 'recordStopReceipt'> & {
  /** Persist the stopped_by_user receipt for one run. */
  recordStopReceipt(run: Omit<TrackedRun, 'cancel'>, info: { actionsRejected: number; ts: number }): void;
};

/** Create the process-wide kill switch. Idempotent: returns the existing one. */
export function installKillSwitch(deps: InstallDeps, accelerator?: string): KillSwitch {
  if (killSwitch) return killSwitch;
  killSwitch = new KillSwitch({
    register: deps.register,
    unregister: deps.unregister,
    rejectDesktopActions: deps.rejectDesktopActions,
    hideOverlay: deps.hideOverlay,
    setBrowserDrivingToUser: deps.setBrowserDrivingToUser,
    cancelRuns: (workflowIds) => {
      const ids = new Set(workflowIds);
      for (const r of runs.values()) {
        if (!ids.has(r.workflowId)) continue;
        stoppedByUser.add(r.workflowId);
        try { r.cancel(); } catch { /* keep stopping the rest */ }
      }
    },
    recordStopReceipt: ({ workflowId, actionsRejected, ts }) => {
      // One receipt per workflow — the outermost (first-registered) run.
      const r = [...runs.values()].find(x => x.workflowId === workflowId);
      if (r) deps.recordStopReceipt({ workflowId, runId: r.runId, sessionId: r.sessionId }, { actionsRejected, ts });
    },
  }, accelerator);
  // Runs that started before install still need the shortcut held.
  for (const r of runs.values()) killSwitch.runStarted(r.workflowId);
  return killSwitch;
}

/** The installed kill switch, if any (null in tests / before app ready). */
export function getKillSwitch(): KillSwitch | null { return killSwitch; }

/** Register a running loop. Returns the function to call when it exits. */
export function trackRun(run: TrackedRun): () => void {
  const token = Symbol(run.workflowId);
  runs.set(token, run);
  killSwitch?.runStarted(run.workflowId);
  let done = false;
  return () => {
    if (done) return;
    done = true;
    runs.delete(token);
    killSwitch?.runEnded(run.workflowId);
    // Forget the stop mark once nothing with this id is running any more.
    if (![...runs.values()].some(r => r.workflowId === run.workflowId)) stoppedByUser.delete(run.workflowId);
  };
}

/** True when the kill switch stopped this workflow (while it's still unwinding). */
export function wasStoppedByUser(workflowId: string): boolean {
  return stoppedByUser.has(workflowId);
}

/** Press the stop button programmatically (IPC / tests). */
export function triggerStop(): StopReport | null {
  return killSwitch?.trigger() ?? null;
}

/** Test-only: drop all state so each test starts clean. */
export function __resetDesktopRuntimeForTests(): void {
  runs.clear();
  stoppedByUser.clear();
  killSwitch = null;
}
