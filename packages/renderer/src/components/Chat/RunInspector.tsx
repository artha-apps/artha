/**
 * RunInspector — a right-side drawer that shows exactly what one agent run did,
 * connecting a conversation/run to the governance + audit features:
 *   • Receipts  — every tool call (incl. policy-blocked / dry-run) with its
 *                 plain-English effect, content hash, and governing tier.
 *   • Steps     — the raw ReAct trace, with "Fork from here" on any step that
 *                 captured a replayable snapshot (time travel).
 *
 * Opened by `setInspectorRunId(runId)` from the chat header (latest run) or an
 * Activity row (a specific run). All data is local; nothing leaves the device.
 */
import { useEffect, useState } from 'react';
import {
  X, ReceiptText, CheckCircle2, XCircle, ShieldX, Eye, FileEdit, Hash,
  GitBranch, ChevronDown, ChevronRight, Undo2,
} from 'lucide-react';
import { useChatStore } from '../../stores/chat';
import { toast } from '../../stores/toast';

interface Receipt {
  receipt_id: string; tool_name: string; effect: string; result_hash: string;
  status: 'ok' | 'error' | 'blocked' | 'skipped';
  tier: 'auto' | 'confirm' | 'dry_run' | 'forbid'; is_mutation: number;
  duration_ms: number; ts: number;
}
interface Step {
  step_id: string; idx: number; kind: string; payload: string; ts: number; has_snapshot: number;
}

const STATUS_META: Record<Receipt['status'], { icon: typeof CheckCircle2; color: string; label: string }> = {
  ok:      { icon: CheckCircle2, color: 'text-artha-success', label: 'ran' },
  error:   { icon: XCircle,      color: 'text-artha-danger',  label: 'failed' },
  blocked: { icon: ShieldX,      color: 'text-artha-warn',    label: 'blocked' },
  skipped: { icon: Eye,          color: 'text-artha-accent',  label: 'dry run' },
};

export default function RunInspector() {
  const { inspectorRunId, setInspectorRunId, setActiveTab, setActiveSession, setMessages } = useChatStore();
  const [receipts, setReceipts] = useState<Receipt[]>([]);
  const [steps, setSteps] = useState<Step[]>([]);
  const [showSteps, setShowSteps] = useState(false);
  const [forking, setForking] = useState(false);
  // Reversible file actions Artha can still undo. Global (recent), not strictly
  // scoped to this run — there's no run-id on the undo registry — so it's shown
  // only when this run actually changed files, where "recent reversible" and
  // "this run's changes" coincide in the common single-run case.
  const [undoables, setUndoables] = useState<{ id: string; label: string }[]>([]);

  useEffect(() => {
    if (!inspectorRunId) return;
    setShowSteps(false);
    Promise.all([
      window.artha.receipts.listByRun(inspectorRunId),
      window.artha.timetravel.getSteps(inspectorRunId),
    ]).then(([r, s]) => { setReceipts(r as Receipt[]); setSteps(s as Step[]); });
    window.artha.undo.list().then((u) => setUndoables(u.map(x => ({ id: x.id, label: x.label })))).catch(() => setUndoables([]));
  }, [inspectorRunId]);

  const undoOne = async (id: string) => {
    const r = await window.artha.undo.revert(id);
    if (r.ok) { setUndoables(prev => prev.filter(u => u.id !== id)); toast.success('Undone', r.label); }
    else toast.error('Couldn’t undo', r.error);
  };

  // Esc closes the drawer.
  useEffect(() => {
    if (!inspectorRunId) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setInspectorRunId(null); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [inspectorRunId, setInspectorRunId]);

  if (!inspectorRunId) return null;

  const mutations = receipts.filter(r => r.is_mutation === 1).length;

  const fork = async (stepId: string) => {
    setForking(true);
    try {
      const newRunId = await window.artha.timetravel.fork(stepId) as string | null;
      // Null = the run's original session no longer exists (e.g. an ephemeral
      // sub-task run). Report it instead of silently switching to an empty chat.
      if (!newRunId) {
        toast.error('Can’t fork this run', 'Its original chat session no longer exists.');
        return;
      }
      setInspectorRunId(null);
      // Land the user on the forked run's session so they can watch it stream —
      // the inspector may have been opened from a DIFFERENT session (an Activity
      // row), where merely switching to the Chat tab wouldn't show the new run.
      try {
        const all = await window.artha.timetravel.listRuns() as { run_id: string; session_id: string }[];
        const run = all.find(r => r.run_id === newRunId);
        if (run?.session_id) {
          setActiveSession(run.session_id);
          setMessages(await window.artha.sessions.getMessages(run.session_id));
        }
      } catch { /* best-effort — fall back to just switching tabs */ }
      toast.success('Forked run started', 'Replaying from this step…');
      setActiveTab('chat');
    } finally {
      setForking(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[60] flex justify-end bg-artha-bg/40 backdrop-blur-sm animate-fade-in" onClick={() => setInspectorRunId(null)}>
      <div
        className="w-full max-w-md h-full bg-artha-surface-raised border-l border-artha-border shadow-modal flex flex-col animate-scale-in"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center gap-2 px-5 py-4 border-b border-artha-border">
          <ReceiptText size={16} className="text-artha-accent" />
          <div className="min-w-0">
            <h2 className="text-sm font-semibold text-artha-text">Run details</h2>
            <p className="text-[11px] text-artha-muted truncate">
              {receipts.length} action{receipts.length === 1 ? '' : 's'}
              {mutations > 0 && ` · ${mutations} changed files`}
            </p>
          </div>
          <button onClick={() => setInspectorRunId(null)} aria-label="Close" className="ml-auto p-1 text-artha-subtle hover:text-artha-text">
            <X size={15} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
          {/* Undo — surfaces the Trust feed's "what changed" as "put it back".
              Only shown when this run changed files and there are reversible
              actions still available. */}
          {mutations > 0 && undoables.length > 0 && (
            <div className="rounded-lg border border-artha-warn/30 bg-artha-warn/5 p-3">
              <h3 className="flex items-center gap-1.5 text-[10px] uppercase tracking-wide text-artha-warn font-semibold mb-2">
                <Undo2 size={12} /> Reversible file changes
              </h3>
              <div className="space-y-1.5">
                {undoables.map(u => (
                  <div key={u.id} className="flex items-center gap-2">
                    <span className="text-xs text-artha-text flex-1 truncate">{u.label}</span>
                    <button
                      onClick={() => undoOne(u.id)}
                      className="shrink-0 inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-artha-warn/10 hover:bg-artha-warn/20 text-artha-warn text-[11px] font-medium transition-colors active:scale-95"
                    >
                      <Undo2 size={10} /> Undo
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Receipts */}
          <div>
            <h3 className="text-[10px] uppercase tracking-wide text-artha-subtle font-semibold mb-2">Actions taken</h3>
            {receipts.length === 0 ? (
              <p className="text-xs text-artha-muted/70">This run made no tool calls.</p>
            ) : (
              <div className="space-y-2">
                {receipts.map(rc => {
                  const meta = STATUS_META[rc.status];
                  const Icon = meta.icon;
                  return (
                    <div key={rc.receipt_id} className="rounded-lg border border-artha-border bg-artha-s2 p-2.5">
                      <div className="flex items-center gap-2 mb-1">
                        <Icon size={13} className={`${meta.color} shrink-0`} />
                        <code className="text-[11px] font-mono text-artha-accent">{rc.tool_name}</code>
                        {rc.is_mutation === 1 && (
                          <span className="flex items-center gap-1 text-[9px] text-artha-warn bg-artha-warn/10 border border-artha-warn/30 px-1 py-0.5 rounded">
                            <FileEdit size={8} /> changed
                          </span>
                        )}
                        <span className={`ml-auto text-[9px] uppercase tracking-wide ${meta.color}`}>{meta.label}</span>
                        {rc.tier !== 'auto' && <span className="text-[9px] text-artha-muted">· {rc.tier}</span>}
                      </div>
                      <p className="text-xs text-artha-text leading-snug">{rc.effect}</p>
                      {rc.result_hash && (
                        <div className="flex items-center gap-1 mt-1 text-[9px] text-artha-muted font-mono">
                          <Hash size={8} />{rc.result_hash}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Steps + fork */}
          <div>
            <button
              onClick={() => setShowSteps(o => !o)}
              className="flex items-center gap-1.5 text-[10px] uppercase tracking-wide text-artha-subtle font-semibold hover:text-artha-muted transition-colors"
            >
              {showSteps ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
              Full step trace ({steps.length}) · time travel
            </button>
            {showSteps && (
              <div className="mt-2 space-y-1">
                {steps.map(s => (
                  <div key={s.step_id} className="flex items-center gap-2 rounded-md border border-artha-border bg-artha-s2 px-2.5 py-1.5">
                    <span className="text-[9px] font-mono text-artha-subtle w-5 shrink-0">{s.idx}</span>
                    <span className="text-[11px] text-artha-text flex-1 truncate">{s.kind}</span>
                    {s.has_snapshot === 1 && (
                      <button
                        onClick={() => fork(s.step_id)}
                        disabled={forking}
                        title="Fork the run from this step"
                        className="flex items-center gap-1 text-[10px] text-artha-accent hover:text-artha-accent-hover disabled:opacity-40"
                      >
                        <GitBranch size={11} /> Fork
                      </button>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        <p className="px-5 py-3 border-t border-artha-border text-[10px] text-artha-subtle">
          Receipts are recorded locally and never leave your device. Esc to close.
        </p>
      </div>
    </div>
  );
}
