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

  // ── Actions ────────────────────────────────────────────────────────────────
  /** Hand a goal to Artha: understand → retrieve context → plan. Auto-executes
   *  when the plan is safe; pauses on `awaiting_confirmation` when it isn't. */
  submit: (goal: string) => Promise<void>;
  /** Approve a paused plan and run it. */
  confirm: () => Promise<void>;
  /** Reject a paused plan and return to the input. */
  cancel: () => void;
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
}

/** Stages that can be safely restored verbatim. Anything else (a task that was
 *  mid-flight when the window closed) resets to `idle` so it never hangs. */
const RESTORABLE: DelegateStatus[] = ['completed', 'awaiting_confirmation', 'failed'];

function loadPersisted(): PersistedTask | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PersistedTask;
    if (!RESTORABLE.includes(parsed.status)) return null;
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
      persist({ status: 'awaiting_confirmation', goal: trimmed, plan, result: null });
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
    persist({ status: 'idle', goal: '', plan: null, result: null });
  },

  reset: () => {
    set({ status: 'idle', goal: '', plan: null, result: null, error: null });
    persist({ status: 'idle', goal: '', plan: null, result: null });
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
    });
    set({ result, status: 'completed' });
    persist({ status: 'completed', goal: get().goal, plan: get().plan, result });
  } catch (err) {
    set({ status: 'failed', error: err instanceof Error ? err.message : String(err) });
    persist({ status: 'failed', goal: get().goal, plan: get().plan, result: null });
  }
}
