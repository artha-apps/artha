/**
 * ExecutionLog — right-rail collapsible panel showing every tool invocation
 * + result for the active session. Sourced from `chat.executionLog`, which
 * the App-level IPC listener appends to on every `agent:toolCall` event.
 *
 * Hidden entirely when there's nothing to show and no in-flight stream, so
 * idle sessions get a wider chat area.
 */
import { useState } from 'react';
import { ChevronRight, ChevronDown, Zap, CheckCircle, Loader } from 'lucide-react';
import { useChatStore } from '../../stores/chat';

export default function ExecutionLog() {
  const { executionLog, isStreaming } = useChatStore();
  const [open, setOpen] = useState(true);

  if (executionLog.length === 0 && !isStreaming) return null;

  return (
    <aside className={`${open ? 'w-72' : 'w-10'} bg-artha-surface2 border-l border-artha-border transition-all duration-200 flex flex-col`}>
      {/* ChevronRight when open = points toward the collapse direction (left edge).
          ChevronDown when collapsed = points downward as an "expand" affordance. */}
      <button onClick={() => setOpen(o => !o)}
        className="flex items-center gap-2 px-3 py-3 border-b border-artha-border text-xs font-medium text-artha-muted hover:text-artha-text transition-colors">
        {open ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
        {open && <><Zap size={12} className="text-artha-accent" /> Execution Log</>}
      </button>

      {open && (
        <div className="flex-1 overflow-y-auto p-3 space-y-2">
          {isStreaming && executionLog.length === 0 && (
            <div className="flex items-center gap-2 text-xs text-artha-muted">
              <Loader size={12} className="animate-spin" /> Thinking…
            </div>
          )}
          {executionLog.map((ev, i) => (
            <div key={i} className="text-xs rounded-lg border border-artha-border bg-artha-surface p-2 space-y-1 shadow-soft">
              <div className="flex items-center gap-1.5 font-medium">
                {ev.type === 'tool_result'
                  ? <CheckCircle size={11} className="text-artha-success" />
                  : ev.type === 'step_start'
                  ? <Loader size={11} className="animate-spin text-artha-accent" />
                  : <Zap size={11} className="text-artha-warn" />}
                <span className="text-artha-text capitalize">{ev.type.replace('_', ' ')}</span>
                {ev.name && <code className="text-artha-accent ml-auto font-mono">{ev.name}</code>}
              </div>
              {ev.args && (
                <pre className="text-artha-muted font-mono overflow-x-auto whitespace-pre-wrap break-all">
                  {typeof ev.args === 'string' ? ev.args.slice(0, 200) : JSON.stringify(ev.args, null, 2).slice(0, 200)}
                </pre>
              )}
              {ev.result && (
                <pre className="text-artha-success/90 font-mono overflow-x-auto whitespace-pre-wrap break-all">
                  {String(ev.result).slice(0, 300)}
                </pre>
              )}
            </div>
          ))}
        </div>
      )}
    </aside>
  );
}
