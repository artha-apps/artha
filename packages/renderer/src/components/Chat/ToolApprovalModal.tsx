/**
 * ToolApprovalModal — per-tool-call approval gate (the policy `confirm` tier).
 *
 * Unlike PlanApproval (which approves a whole plan up front), this catches a
 * SINGLE function call the agent is about to make and pauses it until you
 * approve or deny. The orchestrator emits `agent:toolApprovalRequest` for any
 * call whose Tool Policy is set to "Ask first"; we answer via
 * `agent:respondToolApproval`. Denying tells the agent to skip that action and
 * carry on — it doesn't kill the whole run.
 *
 * The exact arguments are shown verbatim so you can see precisely what would
 * happen (which file, which URL) before it does.
 */
import { useEffect } from 'react';
import { ShieldQuestion, Check, X, Wrench } from 'lucide-react';
import { useChatStore } from '../../stores/chat';

export default function ToolApprovalModal() {
  const { pendingToolApproval, setPendingToolApproval } = useChatStore();

  // Keyboard: Enter approves, Escape denies. Registered only while open.
  useEffect(() => {
    if (!pendingToolApproval) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Enter') { e.preventDefault(); respond(true); }
      if (e.key === 'Escape') { e.preventDefault(); respond(false); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingToolApproval]);

  if (!pendingToolApproval) return null;

  const { approvalId, toolName, argsPreview, note } = pendingToolApproval;

  /** Dismiss first for instant feedback, then answer over IPC. */
  const respond = (approved: boolean) => {
    setPendingToolApproval(null);
    window.artha.agent.respondToolApproval(approvalId, approved);
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-artha-bg/60 backdrop-blur-md animate-fade-in">
      <div className="w-full max-w-md mx-4 rounded-2xl border border-artha-border bg-artha-surface-raised shadow-modal overflow-hidden animate-scale-in">

        {/* Header */}
        <div className="flex items-start gap-3 px-5 pt-5 pb-4 border-b border-artha-border">
          <div className="w-8 h-8 rounded-xl bg-artha-warn/10 border border-artha-warn/30 flex items-center justify-center shrink-0 mt-0.5">
            <ShieldQuestion size={15} className="text-artha-warn" />
          </div>
          <div>
            <p className="text-sm font-semibold text-artha-text">Approve this action?</p>
            <p className="text-xs text-artha-muted mt-0.5">
              Your tool policy asks for confirmation before this call runs.
            </p>
          </div>
        </div>

        {/* Body */}
        <div className="px-5 py-4 space-y-3">
          <div className="flex items-center gap-2">
            <Wrench size={13} className="text-artha-accent shrink-0" />
            <code className="text-xs font-mono text-artha-accent">{toolName}</code>
          </div>
          {note && (
            <p className="text-xs text-artha-muted italic">{note}</p>
          )}
          <div>
            <p className="text-[10px] uppercase tracking-wide text-artha-subtle mb-1">Arguments</p>
            <pre className="text-[11px] font-mono text-artha-text bg-artha-bg border border-artha-border rounded-lg p-3 max-h-48 overflow-auto whitespace-pre-wrap break-words">
              {argsPreview}
            </pre>
          </div>
        </div>

        {/* Actions */}
        <div className="flex gap-3 px-5 py-4 border-t border-artha-border">
          <button
            onClick={() => respond(false)}
            className="flex items-center gap-2 px-4 py-2 rounded-lg border border-artha-border hover:bg-artha-danger/8 hover:border-artha-danger/40 text-sm text-artha-text transition-colors"
          >
            <X size={15} className="text-artha-danger" /> Deny
          </button>
          <button
            onClick={() => respond(true)}
            className="flex-1 flex items-center justify-center gap-2 px-4 py-2 rounded-lg bg-artha-accent hover:bg-artha-accent-hover hover:shadow-glow-sm text-artha-on-accent text-sm font-medium transition-all duration-200 active:scale-95"
          >
            <Check size={15} /> Approve & Run
          </button>
        </div>
        <p className="px-5 pb-4 -mt-1 text-[10px] text-artha-subtle">
          Manage these rules in Settings → Tool Policies. Enter approves · Esc denies.
        </p>
      </div>
    </div>
  );
}
