/**
 * ResumeInterruptedRuns — startup offer for runs the app interrupted.
 *
 * When Artha quits or crashes mid-run, the run is reconciled as 'interrupted'
 * (never completed). This banner lists those runs once on launch with
 * Resume / Dismiss. Nothing resumes on its own — scheduled (unattended) runs
 * are offered the same way and labelled. Resume continues in the same chat;
 * the main process passes the interrupted run's confirmed external actions
 * into the new run so they are never repeated.
 */
import { useEffect, useState } from 'react';
import { RotateCcw, X } from 'lucide-react';
import { useChatStore } from '../stores/chat';
import { toast } from '../stores/toast';

/** Shape returned by `runs:listInterrupted` (see agent/resume.ts). */
type InterruptedRun = Awaited<ReturnType<typeof window.artha.runs.listInterrupted>>[number];

export default function ResumeInterruptedRuns() {
  const [runs, setRuns] = useState<InterruptedRun[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const setActiveSession = useChatStore(s => s.setActiveSession);

  // Fetch once per launch — the list only changes at startup reconciliation.
  useEffect(() => {
    window.artha.runs.listInterrupted().then(setRuns).catch(() => setRuns([]));
  }, []);

  if (runs.length === 0) return null;

  /** Drop a handled run from the banner. */
  const remove = (runId: string) => setRuns(rs => rs.filter(r => r.runId !== runId));

  /** Continue the run in its own chat (explicit user action only). */
  const resume = async (r: InterruptedRun) => {
    setBusy(r.runId);
    try {
      const res = await window.artha.runs.resumeInterrupted(r.runId);
      if (res.ok) {
        remove(r.runId);
        setActiveSession(r.sessionId);
        toast.info('Resuming task', 'Artha will not repeat actions it already completed.');
      } else {
        remove(r.runId);
        toast.warning("Couldn't resume", res.error ?? 'Unknown error');
      }
    } finally {
      setBusy(null);
    }
  };

  /** Stop offering this run. */
  const dismiss = async (r: InterruptedRun) => {
    remove(r.runId);
    await window.artha.runs.dismissInterrupted(r.runId).catch(() => false);
  };

  return (
    <div className="fixed bottom-4 left-4 z-50 w-[380px] max-w-[calc(100vw-2rem)] space-y-2" role="region" aria-label="Interrupted tasks">
      {runs.slice(0, 3).map(r => (
        <div key={r.runId} className="p-3 rounded-xl bg-artha-s2 border border-artha-border shadow-lg text-sm">
          <div className="flex items-start gap-2">
            <RotateCcw size={15} className="text-artha-accent shrink-0 mt-0.5" />
            <div className="flex-1 min-w-0">
              <p className="font-semibold text-artha-text">
                Task interrupted{r.unattended ? ' (scheduled)' : ''}
              </p>
              <p className="text-xs text-artha-muted truncate" title={r.goal}>{r.goal || 'Untitled task'}</p>
              <p className="text-xs text-artha-muted mt-0.5">
                Stopped at step {Math.max(0, r.lastStepIdx)}
                {r.confirmedActions.length > 0 && ` · ${r.confirmedActions.length} external action(s) already done — won't be repeated`}
              </p>
            </div>
            <button onClick={() => dismiss(r)} aria-label="Dismiss" className="text-artha-muted hover:text-artha-text">
              <X size={14} />
            </button>
          </div>
          <div className="flex justify-end gap-2 mt-2">
            <button onClick={() => dismiss(r)} className="px-3 py-1 rounded-lg text-xs text-artha-muted hover:bg-artha-text/5">Dismiss</button>
            <button
              onClick={() => resume(r)}
              disabled={busy === r.runId}
              className="px-3 py-1 rounded-lg text-xs bg-artha-accent hover:bg-artha-accent-hover text-artha-on-accent disabled:opacity-40"
            >
              Resume
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
