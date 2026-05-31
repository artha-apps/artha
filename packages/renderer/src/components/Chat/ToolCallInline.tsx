/**
 * ToolCallInline — collapsible "N tool calls" footer rendered beneath the
 * assistant bubble that produced them. Tap to expand each pair (invoke +
 * result) with args + truncated output.
 */
import { useState } from 'react';
import { ChevronDown, ChevronRight, Zap, CheckCircle2, XCircle } from 'lucide-react';
import { ToolCallEvent } from '../../stores/chat';

interface Props {
  events: ToolCallEvent[];
}

/** Reduce a flat stream of `tool_invoke` / `tool_result` events to logical
 *  pairs. Walks linearly because the orchestrator always emits invoke→result
 *  in order, so the matching result is always the next event. */
function pairEvents(events: ToolCallEvent[]) {
  const pairs: { invoke: ToolCallEvent; result?: ToolCallEvent }[] = [];
  for (let i = 0; i < events.length; i++) {
    if (events[i].type === 'tool_invoke') {
      const next = events[i + 1];
      pairs.push({ invoke: events[i], result: next?.type === 'tool_result' ? next : undefined });
      if (next?.type === 'tool_result') i++;
    }
  }
  return pairs;
}

export default function ToolCallInline({ events }: Props) {
  const [expanded, setExpanded] = useState(false);
  const pairs = pairEvents(events);
  const errorCount = pairs.filter(p => String(p.result?.result ?? '').startsWith('Error')).length;

  return (
    <div className="mt-2 rounded-lg border border-artha-border overflow-hidden text-xs bg-artha-surface">
      <button
        onClick={() => setExpanded(e => !e)}
        className="w-full flex items-center gap-2 px-3 py-1.5 bg-artha-surface2 hover:bg-artha-border/40 transition-colors text-left"
      >
        {expanded ? <ChevronDown size={11} className="text-artha-muted shrink-0" /> : <ChevronRight size={11} className="text-artha-muted shrink-0" />}
        <Zap size={11} className="text-artha-accent shrink-0" />
        <span className="text-artha-muted">{pairs.length} tool call{pairs.length !== 1 ? 's' : ''}</span>
        {errorCount > 0 && <span className="text-artha-danger ml-1">· {errorCount} error{errorCount !== 1 ? 's' : ''}</span>}
      </button>

      {expanded && (
        <div className="divide-y divide-artha-border">
          {pairs.map((pair, i) => {
            const isError = String(pair.result?.result ?? '').startsWith('Error');
            let args: Record<string, unknown> = {};
            try { args = JSON.parse(pair.invoke.args ?? '{}'); } catch { /**/ }

            return (
              <div key={i} className="px-3 py-2 space-y-1 bg-artha-bg/40">
                <div className="flex items-center gap-2">
                  {isError
                    ? <XCircle size={10} className="text-artha-danger shrink-0" />
                    : <CheckCircle2 size={10} className="text-artha-success shrink-0" />}
                  <code className="font-mono text-artha-accent font-medium">{pair.invoke.name}</code>
                </div>
                {Object.keys(args).length > 0 && (
                  // Truncate args at 300 chars to avoid enormous filesystem paths /
                  // base64 blobs making the bubble unreadable.
                  <pre className="font-mono text-artha-muted whitespace-pre-wrap break-all pl-4 leading-relaxed">
                    {JSON.stringify(args, null, 2).slice(0, 300)}
                  </pre>
                )}
                {pair.result?.result && (
                  // Results are often verbose (file listings, shell output) — clamp
                  // to 250 chars to keep the bubble compact.
                  <pre className={`font-mono whitespace-pre-wrap break-all pl-4 leading-relaxed ${isError ? 'text-artha-danger/90' : 'text-artha-success/90'}`}>
                    {String(pair.result.result).slice(0, 250)}
                  </pre>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
