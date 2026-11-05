/**
 * GoalChip — the Delegate header's view of the task's persistent goal
 * (bodhi/goals.ts): objective, status, elapsed active time, and the user's
 * Pause / Resume / Stop controls. A BLOCKED goal shows its reason ("Needs you").
 *
 * There is intentionally no "mark done" control: a goal is completed only by
 * the independent evaluator, from evidence. Polls while mounted because goal
 * state changes inside a run (gate verdicts, goal_update) without a UI event.
 */
import { useEffect, useState, useCallback } from 'react';
import { Target, Pause, Play, Square } from 'lucide-react';
import { goalStatusLabel, goalControls, formatElapsed } from '../../lib/goalChip';

type GoalView = NonNullable<Awaited<ReturnType<typeof window.artha.delegate.goal>>>;

/** How often the chip refreshes goal state + elapsed time. */
const POLL_MS = 2000;

export default function GoalChip({ sessionId }: { sessionId: string | null }) {
  const [goal, setGoal] = useState<GoalView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Fetch the session's latest goal; best-effort (the chip simply hides).
  const load = useCallback(async () => {
    if (!sessionId || !window.artha?.delegate?.goal) { setGoal(null); return; }
    try { setGoal(await window.artha.delegate.goal(sessionId)); } catch { /* best-effort */ }
  }, [sessionId]);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(t);
  }, [load]);

  if (!goal) return null;

  // Apply a user transition and show the backend's verdict on it.
  const set = async (status: 'active' | 'paused' | 'terminated') => {
    setBusy(true); setError(null);
    try {
      const r = await window.artha.delegate.goalSetStatus(goal.goalId, status);
      if (r.ok && r.goal) setGoal(r.goal); else setError(r.error ?? 'Could not update the goal.');
    } finally { setBusy(false); }
  };

  const controls = goalControls(goal.status);
  const tone =
    goal.status === 'completed' ? 'border-artha-accent/40 bg-artha-accent/5'
      : goal.status === 'blocked' ? 'border-artha-warn/40 bg-artha-warn/5'
      : 'border-artha-border bg-artha-s2';
  const btn = 'inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] font-medium border border-artha-border text-artha-muted hover:text-artha-text hover:border-artha-muted transition-colors disabled:opacity-50';

  return (
    <div className={`rounded-xl border px-3 py-2 ${tone}`} data-testid="goal-chip">
      <div className="flex items-center gap-2">
        <Target size={13} className="text-artha-accent shrink-0" />
        <span className="text-xs text-artha-text truncate flex-1" title={goal.condition}>{goal.objective}</span>
        <span className="text-[10px] px-1.5 py-0.5 rounded font-medium bg-artha-surface text-artha-muted shrink-0">
          {goalStatusLabel(goal.status)}
        </span>
        <span className="text-[10px] text-artha-subtle tabular-nums shrink-0">{formatElapsed(goal.elapsedMs)}</span>
        {controls.pause && (
          <button className={btn} disabled={busy} onClick={() => void set('paused')} title="Pause this goal">
            <Pause size={10} /> Pause
          </button>
        )}
        {controls.resume && (
          <button className={btn} disabled={busy} onClick={() => void set('active')} title="Resume this goal">
            <Play size={10} /> Resume
          </button>
        )}
        {controls.stop && (
          <button className={btn} disabled={busy} onClick={() => void set('terminated')} title="Stop this goal">
            <Square size={9} /> Stop
          </button>
        )}
      </div>
      {goal.status === 'blocked' && goal.blockedReason && (
        <p className="mt-1 text-[11px] text-artha-warn leading-snug">{goal.blockedReason}</p>
      )}
      {error && <p className="mt-1 text-[11px] text-artha-danger">{error}</p>}
    </div>
  );
}
