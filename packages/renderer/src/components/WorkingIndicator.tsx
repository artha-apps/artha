/**
 * WorkingIndicator — the in-app "Artha has the wheel" cue.
 *
 * Whenever the agent is actively working we frame the window with a soft accent
 * glow and show a status pill. The pill is now phase-aware (Thinking / Running a
 * tool / Responding / Waiting for your approval), shows an elapsed timer with a
 * "taking longer than usual" hint on long runs, deep-links to Workflows ▸ Runs,
 * and carries an inline Stop so the run can be cancelled from any tab without
 * hunting for the composer.
 */
import { useEffect, useState } from 'react';
import { ArrowUpRight, Square } from 'lucide-react';
import { useChatStore } from '../stores/chat';

/** Map a raw tool name to a friendly present-tense phase. */
function toolPhase(name?: string): string | null {
  if (!name) return null;
  if (name.startsWith('fs_')) return 'Working with your files';
  if (name.startsWith('web_') || name.startsWith('brave') || name.startsWith('searx')) return 'Searching the web';
  if (name.startsWith('rag_')) return 'Searching your files';
  if (name.startsWith('docs_')) return 'Creating a document';
  if (name.startsWith('memory_')) return 'Updating memory';
  if (name.startsWith('crm_') || name.startsWith('kg_')) return 'Updating your CRM';
  if (name.startsWith('desktop_')) return 'Controlling the desktop';
  if (name.startsWith('browser_')) return 'Using the browser';
  return 'Running a tool';
}

export default function WorkingIndicator() {
  const isStreaming = useChatStore(s => s.isStreaming);
  const openWorkflows = useChatStore(s => s.openWorkflows);
  const activeWorkflowId = useChatStore(s => s.activeWorkflowId);
  const pendingToolApproval = useChatStore(s => s.pendingToolApproval);
  const streamingContent = useChatStore(s => s.streamingContent);
  const executionLog = useChatStore(s => s.executionLog);

  // Elapsed timer (hooks must run before the early return). Resets each run.
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (!isStreaming) { setElapsed(0); return; }
    const start = Date.now();
    const h = window.setInterval(() => setElapsed(Math.floor((Date.now() - start) / 1000)), 1000);
    return () => window.clearInterval(h);
  }, [isStreaming]);

  if (!isStreaming) return null;

  // Derive the current phase from store state, most-specific first.
  const lastTool = [...executionLog].reverse().find(e => e.name)?.name;
  const phase = pendingToolApproval
    ? 'Waiting for your approval'
    : streamingContent.trim()
      ? 'Responding…'
      : toolPhase(lastTool) ?? 'Thinking…';
  const slow = elapsed >= 45 && !pendingToolApproval;
  const mins = Math.floor(elapsed / 60), secs = elapsed % 60;
  const clock = mins ? `${mins}m ${secs}s` : `${secs}s`;

  const stop = () => { if (activeWorkflowId) window.artha.agent.cancelTask(activeWorkflowId); };

  return (
    <>
      {/* Window glow — non-interactive, sits under modals/banners. */}
      <div
        aria-hidden
        className="pointer-events-none fixed inset-0 z-[45] ring-2 ring-inset ring-artha-accent/55 animate-pulse"
        style={{ boxShadow: 'inset 0 0 30px 3px var(--artha-glow)' }}
      />
      {/* Status pill — bottom-center. The label + arrow open Workflows ▸ Runs;
          the Stop button cancels the in-flight run from any tab. */}
      <div className="pointer-events-auto fixed bottom-4 left-1/2 -translate-x-1/2 z-[90] flex items-center rounded-full bg-artha-surface-raised border border-artha-accent/40 shadow-glow animate-fade-up overflow-hidden">
        <button
          onClick={() => openWorkflows('runs')}
          title="View live & recent runs"
          className="group flex items-center gap-2 pl-3.5 pr-3 py-1.5 text-artha-text text-xs font-medium hover:bg-artha-accent/5 transition-colors"
        >
          <span className={`w-2 h-2 rounded-full shadow-glow-sm animate-pulse ${pendingToolApproval ? 'bg-artha-warn' : 'bg-artha-accent'}`} />
          <span>{phase}</span>
          <span className="text-artha-subtle tabular-nums">· {clock}</span>
          {slow && <span className="text-artha-subtle hidden sm:inline">· taking longer than usual</span>}
          <ArrowUpRight size={12} className="text-artha-subtle group-hover:text-artha-accent transition-colors" />
        </button>
        {activeWorkflowId && (
          <button
            onClick={stop}
            title="Stop this run"
            className="flex items-center justify-center w-7 h-7 mr-1 rounded-full text-artha-muted hover:text-artha-danger hover:bg-artha-danger/10 transition-colors"
            aria-label="Stop run"
          >
            <Square size={11} className="fill-current" />
          </button>
        )}
      </div>
    </>
  );
}
