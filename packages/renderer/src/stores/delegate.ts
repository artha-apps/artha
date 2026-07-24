/**
 * Delegate store — Zustand. Owns the lifecycle of a single delegated task:
 * the goal, the generated plan, live step/stage status, and the final result.
 *
 * It talks only to `delegateEngine` (see services/delegateService.ts), so the
 * mock execution used in the MVP can be swapped for the real orchestrator
 * without touching this store or the components.
 *
 * "Save useful task context locally": the current task (goal + plan + result)
 * is persisted to localStorage so a reload restores what Artha was working on.
 * Transient states (understanding/executing/…) are coerced back to a safe
 * resting state on load so a task can never get stuck mid-run after a refresh.
 */
import { create } from 'zustand';
import {
  delegateEngine,
  type DelegateStatus,
  type DelegatePlan,
  type DelegatePlanStep,
  type DelegateResult,
} from '../services/delegateService';

interface DelegateState {
  status: DelegateStatus;
  /** The goal the user handed over (kept across the plan/execute lifecycle). */
  goal: string;
  plan: DelegatePlan | null;
  result: DelegateResult | null;
  /** Set when the lifecycle ends in `failed`. */
  error: string | null;
  /** Task identity — previously discarded, which is why the UI could not stop
   *  a run, continue the task, or link to its evidence. */
  runId: string | null;
  sessionId: string | null;
  /** The task's conversation (user + agent), so the task view is a thread
   *  rather than a one-shot result panel. */
  thread: { sender_type: string; content: string; created_at: number }[];
  /** True while a stop request is in flight. */
  stopping: boolean;

  // ── Actions ────────────────────────────────────────────────────────────────
  /** Hand a goal to Artha: understand → retrieve context → plan. Auto-executes
   *  when the plan is safe; pauses on `awaiting_confirmation` when it isn't. */
  submit: (goal: string) => Promise<void>;
  /** Approve a paused plan and run it. */
  confirm: () => Promise<void>;
  /** Reject a paused plan and return to the input. */
  cancel: () => void;
  /** Stop the RUNNING backend task (not just the local view). */
  stop: () => Promise<void>;
  /** Send a follow-up into the SAME task, keeping its context and history. */
  continueTask: (message: string) => Promise<void>;
  /** Reload the task's conversation thread. */
  loadThread: () => Promise<void>;
  /** Open an existing task by session id (multi-task support). */
  openTask: (sessionId: string, runId: string | null) => Promise<void>;
  /** Clear everything and start a fresh delegation. */
  reset: () => void;
}

const STORAGE_KEY = 'artha.delegate.current.v1';

/** The shape we persist — just enough to restore the canvas after a reload. */
interface PersistedTask {
  status: DelegateStatus;
  goal: string;
  plan: DelegatePlan | null;
  result: DelegateResult | null;
  /** Identity so a task can be reopened, continued or stopped after a
   *  restart — previously dropped, stranding any in-flight backend run. */
  runId?: string | null;
  sessionId?: string | null;
}

/** Stages that can be safely restored verbatim. Anything else (a task that was
 *  mid-flight when the window closed) resets to `idle` so it never hangs. */
// 'executing' is restorable now that identity survives: a task interrupted by
// a restart can be reopened and stopped instead of vanishing into an idle
// screen while its backend run keeps going with full tool access.
const RESTORABLE: DelegateStatus[] = ['completed', 'needs_review', 'awaiting_confirmation', 'failed', 'executing'];

/** On a FRESH app launch, only reopen a task that is still IN-FLIGHT (so it can
 *  be resumed or stopped). A terminal task (completed/failed) must NOT auto-open
 *  — otherwise every launch dumps the user back into the last run's result, or a
 *  scary "Something went wrong" error, instead of a clean New task screen. */
const RESTORABLE_ON_LOAD: DelegateStatus[] = ['awaiting_confirmation', 'executing'];

function loadPersisted(): PersistedTask | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PersistedTask;
    // Terminal tasks are still SAVED (persist() keeps them) but never auto-opened
    // on launch — the user starts fresh and can revisit history deliberately.
    if (!RESTORABLE_ON_LOAD.includes(parsed.status)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function persist(task: PersistedTask): void {
  if (typeof window === 'undefined') return;
  try {
    // Only persist resting states — transient ones aren't worth restoring.
    if (RESTORABLE.includes(task.status) || task.status === 'idle') {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(task));
    }
  } catch {
    /* quota / storage blocked — non-fatal */
  }
}

const restored = loadPersisted();

export const useDelegateStore = create<DelegateState>((set, get) => ({
  status: restored?.status ?? 'idle',
  goal: restored?.goal ?? '',
  plan: restored?.plan ?? null,
  result: restored?.result ?? null,
  error: null,
  runId: restored?.runId ?? null,
  sessionId: restored?.sessionId ?? null,
  thread: [],
  stopping: false,

  submit: async (goal) => {
    const trimmed = goal.trim();
    if (!trimmed) return;
    set({ goal: trimmed, plan: null, result: null, error: null, status: 'understanding' });

    let plan: DelegatePlan;
    try {
      plan = await delegateEngine.plan(trimmed, (s) => set({ status: s }));
    } catch (err) {
      set({ status: 'failed', error: err instanceof Error ? err.message : String(err) });
      return;
    }

    if (plan.requiresApproval) {
      // Pause for the confirmation step before any external/irreversible action.
      set({ plan, status: 'awaiting_confirmation' });
      persist({ status: 'awaiting_confirmation', goal: trimmed, plan, result: null, runId: get().runId, sessionId: get().sessionId });
      return;
    }

    // Safe goal (research / summarize / draft / analyze / plan) — run straight through.
    set({ plan });
    await runExecution(plan, set, get);
  },

  confirm: async () => {
    const { plan, status } = get();
    if (!plan || status !== 'awaiting_confirmation') return;
    await runExecution(plan, set, get);
  },

  cancel: () => {
    set({ status: 'idle', plan: null, result: null, error: null });
    persist({ status: 'idle', goal: '', plan: null, result: null, runId: null, sessionId: null });
  },

  reset: () => {
    set({
      status: 'idle', goal: '', plan: null, result: null, error: null,
      runId: null, sessionId: null, thread: [], stopping: false,
    });
    persist({ status: 'idle', goal: '', plan: null, result: null, runId: null, sessionId: null });
  },

  stop: async () => {
    const { runId } = get();
    if (!runId) return;
    set({ stopping: true });
    try {
      const res = await window.artha.delegate.cancel(runId);
      if (!res.ok) set({ error: res.error ?? 'Could not stop the task.' });
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
    } finally {
      set({ stopping: false });
    }
  },

  continueTask: async (message) => {
    const trimmed = message.trim();
    const { sessionId } = get();
    if (!trimmed || !sessionId) return;
    set({ error: null, status: 'executing' });
    try {
      const res = await window.artha.delegate.continue(sessionId, trimmed);
      if (!res.ok) { set({ status: 'failed', error: res.error ?? 'Could not continue the task.' }); return; }
      if (res.runId) set({ runId: res.runId });
      await get().loadThread();
      // Poll the new run to completion, reusing the existing engine path.
      await runExecution(
        get().plan ?? {
          goal: trimmed, summary: trimmed, steps: [],
          requiresApproval: false, expectedOutput: '',
        },
        set, get,
      );
    } catch (err) {
      set({ status: 'failed', error: err instanceof Error ? err.message : String(err) });
    }
  },

  loadThread: async () => {
    const { sessionId } = get();
    if (!sessionId) return;
    try {
      set({ thread: await window.artha.delegate.thread(sessionId) });
    } catch { /* non-fatal */ }
  },

  openTask: async (sessionId, runId) => {
    set({ sessionId, runId, status: 'completed', error: null, plan: null, result: null });
    await get().loadThread();
  },
}));

/** Run the engine's execute phase, wiring its hooks to live store updates so
 *  the timeline animates and each plan step flips pending → running → done.
 *  Shared by the auto-run (safe) and confirm (approved) paths. */
async function runExecution(
  plan: DelegatePlan,
  set: (partial: Partial<DelegateState>) => void,
  get: () => DelegateState,
): Promise<void> {
  /** Mutate one step's status without losing the rest of the plan. */
  const setStep = (index: number, status: DelegatePlanStep['status']): void => {
    const current = get().plan;
    if (!current) return;
    const steps = current.steps.map((s) => (s.index === index ? { ...s, status } : s));
    set({ plan: { ...current, steps } });
  };

  try {
    const result = await delegateEngine.execute(plan, {
      onStage: (s) => set({ status: s }),
      onStep: setStep,
      onIds: ({ runId, sessionId }) => set({ runId, sessionId }),
    });
    // Honest terminal state: 'completed' ONLY when system-verified, else
    // 'needs_review'. Never force a green completed over an unverified run.
    const terminal: DelegateStatus = result.verified ? 'completed' : 'needs_review';
    set({ result, status: terminal });
    void get().loadThread();
    persist({
      status: terminal, goal: get().goal, plan: get().plan, result,
      runId: get().runId, sessionId: get().sessionId,
    });
  } catch (err) {
    set({ status: 'failed', error: err instanceof Error ? err.message : String(err) });
    persist({
      status: 'failed', goal: get().goal, plan: get().plan, result: null,
      runId: get().runId, sessionId: get().sessionId,
    });
  }
}
