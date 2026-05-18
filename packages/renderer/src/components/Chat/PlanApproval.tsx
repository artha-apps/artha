import { CheckCircle, XCircle, ListChecks } from 'lucide-react';
import { useChatStore } from '../../stores/chat';

export default function PlanApproval() {
  const { pendingPlan, setPendingPlan } = useChatStore();
  if (!pendingPlan) return null;

  const approve = (approved: boolean) => {
    const plan = pendingPlan;
    setPendingPlan(null); // Dismiss modal immediately — don't wait for execution
    window.artha.agent.approvePlan(plan.workflowId, approved); // Fire and continue
  };

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50 p-4">
      <div className="bg-artha-s2 border border-artha-border rounded-2xl w-full max-w-lg shadow-2xl">
        <div className="flex items-center gap-3 px-6 py-4 border-b border-artha-border">
          <ListChecks size={18} className="text-artha-accent" />
          <div>
            <h2 className="font-semibold text-sm">Review Agent Plan</h2>
            <p className="text-xs text-artha-muted mt-0.5">This task requires your approval before executing</p>
          </div>
        </div>

        <div className="px-6 py-4">
          <p className="text-xs text-artha-muted mb-3 font-medium uppercase tracking-wide">Goal</p>
          <p className="text-sm mb-4 text-artha-text">{pendingPlan.goal}</p>

          <p className="text-xs text-artha-muted mb-3 font-medium uppercase tracking-wide">Steps ({pendingPlan.steps.length})</p>
          <ol className="space-y-2">
            {pendingPlan.steps.map((step) => (
              <li key={step.index} className="flex items-start gap-3 text-sm">
                <span className="shrink-0 w-5 h-5 rounded-full bg-artha-accent/20 text-artha-accent text-xs flex items-center justify-center font-medium">
                  {step.index + 1}
                </span>
                <span className="text-artha-text leading-5">{step.description}</span>
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
            className="flex items-center gap-2 px-4 py-2 rounded-lg border border-artha-border hover:bg-red-500/10 hover:border-red-500/30 text-sm transition-colors">
            <XCircle size={15} className="text-red-400" /> Cancel
          </button>
          <button onClick={() => approve(true)}
            className="flex-1 flex items-center justify-center gap-2 px-4 py-2 rounded-lg bg-artha-accent hover:bg-artha-accent/80 text-sm font-medium transition-colors">
            <CheckCircle size={15} /> Approve & Execute
          </button>
        </div>
      </div>
    </div>
  );
}
