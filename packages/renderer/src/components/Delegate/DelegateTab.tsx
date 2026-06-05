/**
 * DelegateTab — the canvas for the Delegate room: a goal-driven execution
 * workspace where the user hands Artha a goal and Artha plans, coordinates,
 * and runs it.
 *
 * Two modes, switched on the task lifecycle status:
 *   idle              → DelegateTaskInput (the hero/empty state)
 *   everything else   → the working view: a goal banner, the progress timeline,
 *                       the plan (with the approval gate when paused), and the
 *                       result once complete.
 *
 * All lifecycle state + the engine live in stores/delegate.ts; this component
 * is presentational wiring only.
 */
import { Send, RotateCcw, AlertTriangle } from 'lucide-react';
import { useDelegateStore } from '../../stores/delegate';
import { tabTheme } from '../../lib/tabTheme';
import DelegateTaskInput from './DelegateTaskInput';
import DelegateProgressTimeline from './DelegateProgressTimeline';
import DelegatePlanView from './DelegatePlanView';
import DelegateResultView from './DelegateResultView';

export default function DelegateTab() {
  const { status, goal, plan, result, error, submit, confirm, cancel, reset } = useDelegateStore();
  const theme = tabTheme('delegate');

  // Idle → the goal entry hero.
  if (status === 'idle') {
    return (
      <div className="flex-1 overflow-y-auto">
        <DelegateTaskInput onSubmit={submit} />
      </div>
    );
  }

  // Working view — timeline + plan + result.
  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-2xl mx-auto px-8 py-10 space-y-4">
        {/* Goal banner + New task */}
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2 mb-1">
              <Send size={13} style={{ color: theme.accent }} />
              <span className="text-[10px] uppercase tracking-wider text-artha-subtle font-semibold">
                Delegated goal
              </span>
            </div>
            <p className="text-sm text-artha-text leading-relaxed">{goal}</p>
          </div>
          <button
            onClick={reset}
            className="inline-flex items-center gap-1.5 shrink-0 px-3 py-1.5 rounded-lg text-xs font-medium text-artha-muted border border-artha-border hover:text-artha-text hover:border-artha-muted transition-colors"
          >
            <RotateCcw size={12} /> New task
          </button>
        </div>

        {/* Failure state */}
        {status === 'failed' && (
          <div className="flex items-start gap-2 p-3 rounded-xl border border-artha-danger/30 bg-artha-danger/5">
            <AlertTriangle size={15} className="text-artha-danger mt-0.5 shrink-0" />
            <div className="text-sm text-artha-text">
              Something went wrong while running this task.
              {error && <span className="block text-xs text-artha-muted mt-0.5">{error}</span>}
            </div>
          </div>
        )}

        {/* Progress timeline */}
        <DelegateProgressTimeline status={status} />

        {/* Plan (with the approval gate when paused) */}
        {plan && (
          <DelegatePlanView plan={plan} status={status} onConfirm={confirm} onCancel={cancel} />
        )}

        {/* Result */}
        {status === 'completed' && result && <DelegateResultView result={result} />}
      </div>
    </div>
  );
}
