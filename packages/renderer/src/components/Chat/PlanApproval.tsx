/**
 * PlanApproval — modal shown when the orchestrator pauses a workflow with
 * `requiresApproval=true` (typically because the plan includes destructive
 * filesystem mutations). Renders nothing when there's no pending plan.
 */
import { useEffect } from 'react';
import { CheckCircle, XCircle, ListChecks, Trash2, FolderInput, FilePlus2, Globe, Workflow, RotateCcw, AlertTriangle, Coins } from 'lucide-react';
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

  // Keyboard parity with the other gates: Enter approves, Esc cancels. Hook is
  // declared before the early return so the order is stable across renders.
  useEffect(() => {
    if (!pendingPlan) return;
    const plan = pendingPlan;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Enter') { e.preventDefault(); setPendingPlan(null); window.artha.agent.approvePlan(plan.workflowId, true); }
      if (e.key === 'Escape') { e.preventDefault(); setPendingPlan(null); window.artha.agent.approvePlan(plan.workflowId, false); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [pendingPlan, setPendingPlan]);

  if (!pendingPlan) return null;

  const br = pendingPlan.blastRadius;

  /** Dismiss the modal first, then fire IPC — gives the user instant feedback
   *  even on a slow IPC round-trip when starting a long-running workflow. */
  const approve = (approved: boolean) => {
    const plan = pendingPlan;
    setPendingPlan(null); // Dismiss modal immediately — don't wait for execution
    window.artha.agent.approvePlan(plan.workflowId, approved); // Fire and continue
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

          <p className="text-xs text-artha-subtle mb-3 font-medium uppercase tracking-wide">Steps ({pendingPlan.steps.length})</p>
          <ol className="space-y-2">
            {pendingPlan.steps.map((step) => (
              <li key={step.index} className="flex items-start gap-3 text-sm">
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
              </li>
            ))}
          </ol>
        </div>

        <div className="flex gap-3 px-6 py-4 border-t border-artha-border">
          <button onClick={() => approve(false)}
            className="flex items-center gap-2 px-4 py-2 rounded-lg border border-artha-border hover:bg-artha-danger/8 hover:border-artha-danger/40 text-sm text-artha-text transition-colors">
            <XCircle size={15} className="text-artha-danger" /> Cancel
          </button>
          <button onClick={() => approve(true)}
            className="flex-1 flex items-center justify-center gap-2 px-4 py-2 rounded-lg bg-artha-accent hover:bg-artha-accent-hover hover:shadow-glow-sm text-artha-on-accent text-sm font-medium transition-all duration-200 active:scale-95">
            <CheckCircle size={15} /> Approve & Execute
          </button>
        </div>
      </div>
    </div>
  );
}
