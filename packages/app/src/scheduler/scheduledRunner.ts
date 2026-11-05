/**
 * The one runner every automation trigger (cron, catch-up, folder, webhook,
 * Run now) goes through.
 *
 * Purpose: scheduled runs used to build a fresh AgentOrchestrator per fire,
 * so their kill-switch registration, `cancelWorkflow` state and OutboxDriver
 * lived on an instance nothing else could reach. The runner now takes the
 * single app-wide orchestrator (the one the IPC layer uses) through
 * `getOrchestrator`, so the global stop shortcut, chat-side `cancelWorkflow`
 * and outbox holds cover scheduled runs exactly like chat runs.
 *
 * Unattended / fail-closed behaviour is unchanged: the run is still wrapped in
 * `runWithContext({actor: 'scheduler', unattended: true})`, so the permission
 * gate resolves `unattended` and confirm-tier tools, the `email_send` floor,
 * `ask_user` cards and unapproved desktop apps all fail closed. That context
 * is per-run (AsyncLocalStorage), so sharing the orchestrator cannot leak it
 * into a concurrent attended chat run.
 *
 * Kept free of Electron / better-sqlite3 imports so it can be unit-tested.
 */
import type { TaskRunner } from './scheduler';
import type { RunContext } from '../agent/runContext';

/** The slice of AgentOrchestrator the runner needs. */
export interface ScheduledRunOrchestrator {
  handleMessage(sessionId: string, prompt: string): Promise<unknown>;
}

export interface ScheduledRunnerDeps {
  /** Returns the shared app-wide orchestrator. Throws/returns null before
   *  registerIpcHandlers has run — the runner then refuses (never builds its own). */
  getOrchestrator(): ScheduledRunOrchestrator | null | undefined;
  /** Runs `fn` inside a per-run context (agent/runContext.runWithContext). */
  runWithContext<T>(ctx: RunContext, fn: () => Promise<T>): Promise<T>;
  /** Creates the isolated `origin='scheduled'` session (and the folder scope
   *  for folder triggers). Returns its id. */
  createSession(prompt: string, opts?: { scopeFolder?: string }): string;
}

/** The fixed context every scheduled run executes under. Exported for tests. */
export const SCHEDULED_RUN_CONTEXT: Readonly<RunContext> = Object.freeze({ actor: 'scheduler', lan: false, unattended: true });

/** Build the TaskRunner handed to SchedulerService.init(). */
export function createScheduledRunner(deps: ScheduledRunnerDeps): TaskRunner {
  return async (prompt, opts) => {
    const orch = deps.getOrchestrator();
    // Fail closed: without the shared orchestrator the run would be invisible
    // to the kill switch, so it does not start (the scheduler records the error).
    if (!orch) throw new Error('Scheduled run refused: the app orchestrator is not ready yet.');
    const sessionId = deps.createSession(prompt, opts);
    // A fresh object per run so nothing downstream can mutate the shared constant.
    await deps.runWithContext({ ...SCHEDULED_RUN_CONTEXT }, () => orch.handleMessage(sessionId, prompt));
    // Hand the session back so the scheduler reads the run's REAL outcome
    // instead of inferring success from "the promise resolved".
    return { sessionId };
  };
}
