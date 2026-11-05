/**
 * PlanApproval — modal shown when the orchestrator pauses a workflow with
 * `requiresApproval=true` (typically because the plan includes destructive
 * filesystem mutations). Renders nothing when there's no pending plan.
 *
 * Structured review: the user can comment on any step and choose Accept,
 * Accept with comments (the planner revises the plan once and asks again),
 * or Reject with an optional reason (the run ends cancelled-by-user).
 */
import { useEffect, useState } from 'react';
import { CheckCircle, XCircle, ListChecks, Trash2, FolderInput, FilePlus2, Globe, Workflow, RotateCcw, AlertTriangle, Coins, MessageSquare } from 'lucide-react';
import { useChatStore } from '../../stores/chat';

/** A single blast-radius chip (icon + label), colour-coded by severity. */
function ImpactChip({ icon, label, tone }: { icon: React.ReactNode; label: string; tone: 'danger' | 'warn' | 'accent' | 'muted' }) {
  const cls = {
    danger: 'text-artha-danger bg-artha-danger/10 border-artha-danger/30',
    warn: 'text-artha-warn bg-artha-warn/10 border-artha-warn/30',
    accent: 'text-artha-accent bg-artha-accent/10 border-artha-accent/30',
    muted: 'text-artha-muted bg-artha-text/5 border-artha-border',
  }[tone];
  return (
    <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md border text-[11px] font-medium ${cls}`}>
      {icon}{label}
    </span>
  );
}

export default function PlanApproval() {
  const { pendingPlan, setPendingPlan } = useChatStore();
  /** Per-step comment drafts, keyed by step index. */
  const [comments, setComments] = useState<Record<number, string>>({});
  /** Which step's comment box is open. */
  const [openComment, setOpenComment] = useState<number | null>(null);
  /** Reject flow: null = not rejecting; string = reason draft. */
  const [rejectReason, setRejectReason] = useState<string | null>(null);

  // A new (or revised) plan starts with a clean review.
  useEffect(() => {
    setComments({}); setOpenComment(null); setRejectReason(null);
  }, [pendingPlan]);

  // Keyboard parity with the other gates: Enter approves, Esc cancels. Hook is
  // declared before the early return so the order is stable across renders.
  // Ignored while typing a comment/reason so Enter doesn't approve mid-sentence.
  useEffect(() => {
    if (!pendingPlan) return;
    const plan = pendingPlan;
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === 'TEXTAREA' || tag === 'INPUT') return;
      if (e.key === 'Enter') { e.preventDefault(); setPendingPlan(null); window.artha.agent.approvePlan(plan.workflowId, true); }
      if (e.key === 'Escape') { e.preventDefault(); setPendingPlan(null); window.artha.agent.approvePlan(plan.workflowId, false); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [pendingPlan, setPendingPlan]);

  if (!pendingPlan) return null;

  const br = pendingPlan.blastRadius;
  const stepComments = pendingPlan.steps
    .filter(s => (comments[s.index] ?? '').trim())
    .map(s => ({ step_index: s.index, original_text: s.description, comment: comments[s.index].trim() }));
  const revised = (pendingPlan.revisions ?? 0) > 0;

  /** Dismiss the modal first, then fire IPC — gives the user instant feedback
   *  even on a slow IPC round-trip when starting a long-running workflow. */
  const submit = (review: Parameters<typeof window.artha.agent.reviewPlan>[1]) => {
    const plan = pendingPlan;
    setPendingPlan(null); // Dismiss modal immediately — don't wait for execution
    void window.artha.agent.reviewPlan(plan.workflowId, review); // Fire and continue
  };

  return (
    <div className="fixed inset-0 bg-artha-bg/60 backdrop-blur-md flex items-center justify-center z-50 p-4 animate-fade-in">
      <div className="bg-artha-surface-raised border border-artha-border rounded-2xl w-full max-w-lg shadow-modal animate-scale-in">
        <div className="flex items-center gap-3 px-6 py-4 border-b border-artha-border">
          <ListChecks size={18} className="text-artha-accent" />
          <div>
            <h2 className="font-semibold text-sm text-artha-text">Review Agent Plan</h2>
            <p className="text-xs text-artha-muted mt-0.5">This task requires your approval before executing</p>
          </div>
        </div>

        <div className="px-6 py-4">
          <p className="text-xs text-artha-subtle mb-3 font-medium uppercase tracking-wide">Goal</p>
          <p className="text-sm mb-4 text-artha-text">{pendingPlan.goal}</p>

          {/* ── Pre-flight blast radius ───────────────────────────────────
              An estimate of what running this plan will touch, so you approve
              with the consequences in view rather than on faith. */}
          {br && (
            <div className={`mb-4 rounded-xl border p-3 ${br.reversible ? 'border-artha-border bg-artha-s2' : 'border-artha-danger/40 bg-artha-danger/8'}`}>
              <div className="flex items-center gap-2 mb-2">
                {br.reversible
                  ? <CheckCircle size={13} className="text-artha-success" />
                  : <AlertTriangle size={13} className="text-artha-danger" />}
                <span className="text-[11px] font-semibold uppercase tracking-wide text-artha-subtle">
                  Estimated impact
                </span>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {br.deletions > 0 && <ImpactChip tone="danger" icon={<Trash2 size={11} />} label={`${br.deletions} deletion${br.deletions === 1 ? '' : 's'}`} />}
                {br.moves > 0 && <ImpactChip tone="warn" icon={<FolderInput size={11} />} label={`${br.moves} move${br.moves === 1 ? '' : 's'}`} />}
                {br.writes > 0 && <ImpactChip tone="accent" icon={<FilePlus2 size={11} />} label={`${br.writes} write${br.writes === 1 ? '' : 's'}`} />}
                {br.touchesWeb && <ImpactChip tone="accent" icon={<Globe size={11} />} label="reaches the web" />}
                {br.delegates && <ImpactChip tone="accent" icon={<Workflow size={11} />} label="delegates" />}
                <ImpactChip
                  tone={br.reversible ? 'muted' : 'danger'}
                  icon={br.reversible ? <RotateCcw size={11} /> : <AlertTriangle size={11} />}
                  label={br.reversible ? 'reversible' : 'not reversible'}
                />
                <ImpactChip tone="muted" icon={<Coins size={11} />} label={`≈ ${(br.estTokens / 1000).toFixed(1)}k tokens`} />
              </div>
              <p className="text-[11px] text-artha-muted mt-2">
                Estimated before running — actual results may differ. Deletions are{' '}
                {br.reversible ? 'none here' : 'not automatically reversible'}.
              </p>
            </div>
          )}

          <p className="text-xs text-artha-subtle mb-3 font-medium uppercase tracking-wide">
            Steps ({pendingPlan.steps.length}){revised ? ' · revised with your comments' : ''}
          </p>
          <ol className="space-y-2 max-h-[40vh] overflow-y-auto">
            {pendingPlan.steps.map((step) => (
              <li key={step.index} className="text-sm">
              <div className="flex items-start gap-3">
                <span className="shrink-0 w-5 h-5 rounded-full bg-artha-accent/12 text-artha-accent text-xs flex items-center justify-center font-medium">
                  {step.index + 1}
                </span>
                <span className="text-artha-text leading-5">{step.description}</span>
                {/* Optional tool badge — the orchestrator populates this when it
                    already knows which tool will execute the step. */}
                {step.toolName && (
                  <code className="ml-auto shrink-0 text-xs text-artha-accent bg-artha-accent/10 px-2 py-0.5 rounded font-mono">
                    {step.toolName}
                  </code>
                )}
                {/* Comment on this specific step. */}
                <button
                  type="button"
                  title="Comment on this step"
                  aria-label={`Comment on step ${step.index + 1}`}
                  onClick={() => setOpenComment(openComment === step.index ? null : step.index)}
                  className={`${step.toolName ? '' : 'ml-auto '}shrink-0 p-1 rounded hover:bg-artha-text/5 ${(comments[step.index] ?? '').trim() ? 'text-artha-accent' : 'text-artha-muted'}`}
                >
                  <MessageSquare size={13} />
                </button>
              </div>
              {openComment === step.index && (
                <textarea
                  autoFocus
                  value={comments[step.index] ?? ''}
                  onChange={e => setComments(prev => ({ ...prev, [step.index]: e.target.value }))}
                  placeholder="What should change about this step?"
                  rows={2}
                  className="mt-2 ml-8 w-[calc(100%-2rem)] px-3 py-2 rounded-lg border border-artha-border bg-artha-bg text-xs text-artha-text focus:outline-none focus:border-artha-accent"
                />
              )}
              </li>
            ))}
          </ol>
        </div>

        {rejectReason !== null ? (
          // Reject flow: optional reason, then confirm. Ends the run as
          // cancelled-by-user (never completed).
          <div className="px-6 py-4 border-t border-artha-border space-y-3">
            <input
              autoFocus
              value={rejectReason}
              onChange={e => setRejectReason(e.target.value)}
              placeholder="Why are you rejecting this plan? (optional)"
              className="w-full px-3 py-2 rounded-lg border border-artha-border bg-artha-bg text-sm text-artha-text focus:outline-none focus:border-artha-danger"
            />
            <div className="flex gap-3">
              <button onClick={() => setRejectReason(null)}
                className="px-4 py-2 rounded-lg border border-artha-border text-sm text-artha-muted hover:text-artha-text">
                Back
              </button>
              <button onClick={() => submit({ decision: 'reject', reason: rejectReason.trim() || undefined })}
                className="flex-1 flex items-center justify-center gap-2 px-4 py-2 rounded-lg border border-artha-danger/40 bg-artha-danger/10 text-sm text-artha-danger font-medium">
                <XCircle size={15} /> Reject plan
              </button>
            </div>
          </div>
        ) : (
        <div className="flex gap-3 px-6 py-4 border-t border-artha-border">
          <button onClick={() => setRejectReason('')}
            className="flex items-center gap-2 px-4 py-2 rounded-lg border border-artha-border hover:bg-artha-danger/8 hover:border-artha-danger/40 text-sm text-artha-text transition-colors">
            <XCircle size={15} className="text-artha-danger" /> Reject
          </button>
          {stepComments.length > 0 ? (
            <button onClick={() => submit({ decision: 'accept_with_comments', comments: stepComments })}
              title={revised ? 'Run with these comments as guidance' : 'Artha revises the plan with your comments and asks again'}
              className="flex-1 flex items-center justify-center gap-2 px-4 py-2 rounded-lg bg-artha-accent hover:bg-artha-accent-hover text-artha-on-accent text-sm font-medium transition-all duration-200 active:scale-95">
              <MessageSquare size={15} /> Accept with {stepComments.length} comment{stepComments.length === 1 ? '' : 's'}
            </button>
          ) : (
            <button onClick={() => submit({ decision: 'accept' })}
              className="flex-1 flex items-center justify-center gap-2 px-4 py-2 rounded-lg bg-artha-accent hover:bg-artha-accent-hover hover:shadow-glow-sm text-artha-on-accent text-sm font-medium transition-all duration-200 active:scale-95">
              <CheckCircle size={15} /> Accept & Execute
            </button>
          )}
        </div>
        )}
      </div>
    </div>
  );
}
