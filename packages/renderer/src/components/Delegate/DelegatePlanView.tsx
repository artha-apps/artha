/**
 * DelegatePlanView — renders the structured plan Artha generated for a goal:
 * a plain-language summary, the ordered steps (each with the tools/agent it
 * uses and its live status), and the expected output.
 *
 * When the plan needs approval (an external/irreversible step) and the task is
 * paused at `awaiting_confirmation`, this view shows the confirmation controls.
 * Safe plans (research/summarize/draft/analyze/plan) skip the gate and run
 * straight through, so the controls simply don't render.
 *
 * Step comments (S5 parity with Chat's PlanApproval): while awaiting approval
 * the user can comment on any step, then Approve, Approve with comments
 * (carried into the run as notes, see lib/delegateParity.ts) or Cancel.
 */
import { useEffect, useState } from 'react';
import { Loader2, Check, Circle, AlertTriangle, ShieldAlert, Wrench, Bot, MessageSquare } from 'lucide-react';
import type { DelegatePlan, DelegateStatus } from '../../services/delegateService';
import type { PlanReview } from '../../../../app/src/agent/planReview';
import { tabTheme } from '../../lib/tabTheme';
import { draftsToComments } from '../../lib/delegateParity';

interface Props {
  plan: DelegatePlan;
  status: DelegateStatus;
  /** Submit the S5-style review (accept / accept_with_comments / reject). */
  onReview: (review: PlanReview) => void;
}

export default function DelegatePlanView({ plan, status, onReview }: Props) {
  const theme = tabTheme('delegate');
  const awaiting = status === 'awaiting_confirmation';
  /** Per-step comment drafts, keyed by step index. */
  const [drafts, setDrafts] = useState<Record<number, string>>({});
  /** Which step's comment box is open. */
  const [openComment, setOpenComment] = useState<number | null>(null);
  // A new plan starts with a clean review.
  useEffect(() => { setDrafts({}); setOpenComment(null); }, [plan.goal]);
  const comments = draftsToComments(plan, drafts);

  return (
    <div className="rounded-xl border border-artha-border bg-artha-surface p-4">
      <h2 className="text-[10px] uppercase tracking-wider text-artha-subtle font-semibold mb-3">
        Plan
      </h2>

      {/* What Artha understood + will do */}
      <p className="text-sm text-artha-text leading-relaxed mb-4">{plan.summary}</p>

      {/* Steps */}
      <ol className="space-y-2 mb-4">
        {plan.steps.map((step) => (
          <li
            key={step.index}
            className="flex gap-3 p-2.5 rounded-lg border border-artha-border bg-artha-surface2/40"
          >
            <div className="mt-0.5 shrink-0">
              {step.status === 'done' ? (
                <Check size={15} style={{ color: theme.accent }} />
              ) : step.status === 'running' ? (
                <Loader2 size={15} className="animate-spin" style={{ color: theme.accent }} />
              ) : step.status === 'failed' ? (
                <AlertTriangle size={15} className="text-artha-danger" />
              ) : (
                <Circle size={15} className="text-artha-subtle" />
              )}
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-start gap-2">
                <span className="text-sm text-artha-text leading-snug">{step.description}</span>
                {awaiting && (
                  <button
                    onClick={() => setOpenComment(o => (o === step.index ? null : step.index))}
                    title="Comment on this step"
                    className={`ml-auto shrink-0 p-0.5 rounded hover:text-artha-text ${(drafts[step.index] ?? '').trim() ? 'text-artha-accent' : 'text-artha-subtle'}`}
                  >
                    <MessageSquare size={12} />
                  </button>
                )}
                {step.external && (
                  <span className="inline-flex items-center gap-1 shrink-0 px-1.5 py-0.5 rounded text-[10px] font-medium text-amber-500 bg-amber-500/10 border border-amber-500/30">
                    <ShieldAlert size={10} /> needs approval
                  </span>
                )}
              </div>
              {/* Required agent + tools */}
              {(step.agent || step.tools.length > 0) && (
                <div className="flex flex-wrap items-center gap-1.5 mt-1.5">
                  {step.agent && (
                    <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] text-artha-muted bg-artha-surface border border-artha-border">
                      <Bot size={10} /> {step.agent}
                    </span>
                  )}
                  {step.tools.map((t) => (
                    <span
                      key={t}
                      className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-mono text-artha-subtle bg-artha-surface border border-artha-border"
                    >
                      <Wrench size={9} /> {t}
                    </span>
                  ))}
                </div>
              )}
              {awaiting && openComment === step.index && (
                <textarea
                  autoFocus
                  value={drafts[step.index] ?? ''}
                  onChange={(e) => setDrafts(d => ({ ...d, [step.index]: e.target.value }))}
                  rows={2}
                  placeholder="What should change about this step?"
                  className="mt-2 w-full resize-none rounded-lg bg-artha-surface border border-artha-border px-2 py-1.5 text-xs text-artha-text placeholder-artha-muted focus:border-artha-accent/50 focus:outline-none"
                />
              )}
            </div>
          </li>
        ))}
      </ol>

      {/* Expected output */}
      <div className="text-xs text-artha-muted mb-1">
        <span className="text-artha-subtle uppercase tracking-wider text-[10px] font-semibold">Expected output</span>
      </div>
      <p className="text-sm text-artha-text leading-relaxed">{plan.expectedOutput}</p>

      {/* Confirmation gate — only when paused awaiting approval. */}
      {awaiting && (
        <div className="mt-4 pt-4 border-t border-artha-border">
          <div className="flex items-start gap-2 mb-3">
            <ShieldAlert size={15} className="text-amber-500 mt-0.5 shrink-0" />
            <p className="text-xs text-artha-muted leading-relaxed">
              This plan includes an external or irreversible action. Artha won&rsquo;t proceed until you approve.
            </p>
          </div>
          <div className="flex items-center gap-2">
            {comments.length > 0 ? (
              <button
                onClick={() => onReview({ decision: 'accept_with_comments', comments })}
                className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-semibold text-white transition-opacity hover:opacity-90"
                style={{ backgroundColor: theme.accent }}
              >
                <MessageSquare size={13} /> Approve with {comments.length} comment{comments.length === 1 ? '' : 's'}
              </button>
            ) : (
              <button
                onClick={() => onReview({ decision: 'accept' })}
                className="px-4 py-2 rounded-lg text-sm font-semibold text-white transition-opacity hover:opacity-90"
                style={{ backgroundColor: theme.accent }}
              >
                Approve &amp; run
              </button>
            )}
            <button
              onClick={() => onReview({ decision: 'reject' })}
              className="px-4 py-2 rounded-lg text-sm font-medium text-artha-muted border border-artha-border hover:text-artha-text hover:border-artha-muted transition-colors"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
