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
import { useState, useEffect } from 'react';
import { Send, RotateCcw, AlertTriangle, Square, CornerDownLeft, Loader2 } from 'lucide-react';
import { useDelegateStore } from '../../stores/delegate';
import { tabTheme } from '../../lib/tabTheme';
import DelegateTaskInput from './DelegateTaskInput';
import DelegateProgressTimeline from './DelegateProgressTimeline';
import DelegatePlanView from './DelegatePlanView';
import DelegateResultView from './DelegateResultView';

export default function DelegateTab() {
  const {
    status, goal, plan, result, error, thread, stopping, runId, tasks,
    submit, confirm, cancel, reset, stop, continueTask, openTask, loadTasks,
  } = useDelegateStore();

  // Refresh the reachable task history whenever we return to the idle screen.
  useEffect(() => { if (status === 'idle') void loadTasks(); }, [status, loadTasks]);
  const theme = tabTheme('delegate');
  const [followUp, setFollowUp] = useState('');
  const isRunning = !['idle', 'completed', 'needs_review', 'failed', 'awaiting_confirmation'].includes(status);

  const sendFollowUp = async () => {
    const text = followUp.trim();
    if (!text) return;
    setFollowUp('');
    await continueTask(text);
  };

  // Idle → the goal entry hero + reachable task history. Terminal tasks no
  // longer auto-restore on launch (they used to greet you with a stale error),
  // so this list is how a finished task stays reachable.
  if (status === 'idle') {
    return (
      <div className="flex-1 overflow-y-auto">
        <DelegateTaskInput onSubmit={submit} />
        {tasks.length > 0 && (
          <div className="max-w-2xl mx-auto px-8 pb-10">
            <h3 className="text-[10px] uppercase tracking-wider text-artha-subtle font-semibold mb-2">
              Recent tasks
            </h3>
            <ul className="space-y-1">
              {tasks.slice(0, 8).map((t) => (
                <li key={t.session_id}>
                  <button
                    onClick={() => void openTask(t.session_id, t.last_run_id)}
                    className="w-full text-left flex items-center gap-3 px-3 py-2 rounded-lg border border-artha-border hover:border-artha-muted transition-colors"
                  >
                    <span className="text-sm text-artha-text truncate flex-1">{t.title}</span>
                    {/* Evidence-derived label — never a raw "completed". */}
                    <span
                      className={`shrink-0 text-[10px] px-1.5 py-0.5 rounded font-medium ${
                        t.isComplete ? 'bg-artha-accent/15 text-artha-accent'
                          : t.status === 'failed' ? 'bg-artha-danger/15 text-artha-danger'
                          : 'bg-artha-warn/15 text-artha-warn'
                      }`}
                    >
                      {t.label}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
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
          <div className="flex items-center gap-2 shrink-0">
            {/* Stop: Delegate had no way to cancel a run at all — a long or
                hung task kept executing with full tool access and the only
                exit was to abandon the view. */}
            {isRunning && runId && (
              <button
                onClick={() => void stop()}
                disabled={stopping}
                title="Stop this task"
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-artha-danger border border-artha-danger/40 hover:bg-artha-danger/10 transition-colors disabled:opacity-50"
              >
                {stopping ? <Loader2 size={12} className="animate-spin" /> : <Square size={11} />}
                {stopping ? 'Stopping…' : 'Stop'}
              </button>
            )}
            <button
              onClick={reset}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-artha-muted border border-artha-border hover:text-artha-text hover:border-artha-muted transition-colors"
            >
              <RotateCcw size={12} /> New task
            </button>
          </div>
        </div>

        {/* Failure state — lead with the agent's own honest explanation (the
            backend already wrote the truthful reason, e.g. "the email was NOT
            sent…") rather than a generic "something went wrong". */}
        {status === 'failed' && (
          <div className="flex items-start gap-2 p-3 rounded-xl border border-artha-danger/30 bg-artha-danger/5">
            <AlertTriangle size={15} className="text-artha-danger mt-0.5 shrink-0" />
            <div className="text-sm text-artha-text">
              {error?.trim() || 'The task did not complete.'}
            </div>
          </div>
        )}

        {/* Progress timeline */}
        <DelegateProgressTimeline status={status} />

        {/* Plan (with the approval gate when paused) */}
        {plan && (
          <DelegatePlanView plan={plan} status={status} onConfirm={confirm} onCancel={cancel} />
        )}

        {/* Result — shown for a verified completion AND for a finished-but-
            unverified run (needs_review); the view itself renders the honest
            label/message. */}
        {(status === 'completed' || status === 'needs_review') && result && (
          <DelegateResultView result={result} />
        )}

        {/* Conversation — the task stays OPEN. Previously the final response
            closed the loop: no message box, and "New task" destroyed the task
            entirely, so there was no way to say "that's not right, continue". */}
        {thread.length > 1 && (
          <div className="space-y-2 pt-2">
            <h3 className="text-[10px] uppercase tracking-wider text-artha-subtle font-semibold">
              Conversation
            </h3>
            {thread.map((m, i) => (
              <div
                key={i}
                className={`text-sm leading-relaxed rounded-lg px-3 py-2 ${
                  m.sender_type === 'user'
                    ? 'bg-artha-accent/10 border border-artha-accent/20 text-artha-text'
                    : 'bg-artha-s2 border border-artha-border text-artha-text'
                }`}
              >
                <span className="block text-[10px] uppercase tracking-wide text-artha-subtle mb-0.5">
                  {m.sender_type === 'user' ? 'You' : 'Artha'}
                </span>
                {m.content}
              </div>
            ))}
          </div>
        )}

        {/* Follow-up box — available whenever the task exists, including after
            it stops, fails, or finishes. Continues in the SAME task context
            instead of silently starting an unrelated run. */}
        {/* Reached only in the working view — idle returns earlier. */}
        <div className="pt-2">
            <div className="flex items-end gap-2">
              <textarea
                value={followUp}
                onChange={(e) => setFollowUp(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void sendFollowUp(); }
                }}
                rows={2}
                disabled={isRunning}
                placeholder={
                  isRunning
                    ? 'Artha is working — stop the task to send a follow-up.'
                    : 'Continue this task: "that\'s not complete", "you missed X", "retry the failed step"…'
                }
                className="flex-1 resize-none rounded-xl bg-artha-surface border border-artha-border px-3 py-2 text-sm text-artha-text placeholder-artha-muted focus:border-artha-accent/50 focus:outline-none disabled:opacity-50"
              />
              <button
                onClick={() => void sendFollowUp()}
                disabled={isRunning || !followUp.trim()}
                title="Continue this task"
                className="inline-flex items-center gap-1.5 px-3 py-2.5 rounded-xl text-xs font-medium bg-artha-accent hover:bg-artha-accent/80 disabled:opacity-40 text-artha-on-accent transition-colors"
              >
                <CornerDownLeft size={12} /> Continue
              </button>
            </div>
        </div>
      </div>
    </div>
  );
}
