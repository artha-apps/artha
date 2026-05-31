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

const base = (p?: string) => (p ? String(p).replace(/\/+$/, '').split('/').pop() || p : '');

/** Turn a raw tool call into a plain-English line — what the agent is actually
 *  doing, no code. Falls back to a de-snaked tool name for anything unmapped. */
export function describeTool(name: string, rawArgs?: string): string {
  let a: Record<string, unknown> = {};
  try { a = JSON.parse(rawArgs ?? '{}'); } catch { /* ignore */ }
  const s = (k: string) => (typeof a[k] === 'string' ? (a[k] as string) : '');
  switch (name) {
    case 'fs_list_directory': return `Looking through ${base(s('path')) || 'a folder'}`;
    case 'fs_search_files': return `Searching for ${s('pattern') || 'files'} in ${base(s('directory')) || 'a folder'}`;
    case 'fs_create_directory': return `Creating folder “${base(s('path'))}”`;
    case 'fs_move_file': return `Moving ${base(s('source') || s('src'))} → ${base((s('destination') || s('dst') || s('dest')).replace(/\/[^/]+$/, '')) || 'a folder'}/`;
    case 'fs_move_batch': {
      const n = Array.isArray(a.moves) ? a.moves.length : 0;
      return `Organising ${n} file${n === 1 ? '' : 's'}`;
    }
    case 'fs_copy_file': return `Copying ${base(s('source') || s('src'))}`;
    case 'fs_read_file': return `Reading ${base(s('path'))}`;
    case 'fs_get_file_info': return `Checking ${base(s('path'))}`;
    case 'fs_delete_file': return `${a.permanent ? 'Deleting' : 'Moving to Trash'} ${base(s('path'))}`;
    case 'web_search': case 'brave_search': case 'duckduckgo_search':
      return `Searching the web for “${s('query') || s('q')}”`;
    case 'web_fetch': return `Reading ${s('url')}`;
    case 'docs_generate': return `Creating a ${s('format') || 'document'}`;
    case 'memory_save': return 'Saving to memory';
    case 'memory_search': return 'Recalling from memory';
    default: return name.replace(/^[a-z]+_/, '').replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
  }
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
        {/* Natural-language summary of what the agent did — no code in the
            collapsed view. The first action, plus "+N more" when there are more. */}
        <span className="text-artha-muted truncate">
          {pairs.length > 0 ? describeTool(pairs[0].invoke.name, pairs[0].invoke.args) : 'Working…'}
          {pairs.length > 1 && ` · +${pairs.length - 1} more step${pairs.length - 1 !== 1 ? 's' : ''}`}
        </span>
        {errorCount > 0 && <span className="text-artha-danger ml-1 shrink-0">· {errorCount} error{errorCount !== 1 ? 's' : ''}</span>}
      </button>

      {expanded && (
        <div className="divide-y divide-artha-border">
          {pairs.map((pair, i) => {
            const isError = String(pair.result?.result ?? '').startsWith('Error');
            const outcome = summariseResult(pair.result?.result);
            return (
              <div key={i} className="flex items-start gap-2 px-3 py-2 bg-artha-bg/40">
                {isError
                  ? <XCircle size={11} className="text-artha-danger shrink-0 mt-0.5" />
                  : <CheckCircle2 size={11} className="text-artha-success shrink-0 mt-0.5" />}
                <div className="min-w-0">
                  {/* Plain-English action — no tool names, no JSON. */}
                  <div className="text-artha-text">{describeTool(pair.invoke.name, pair.invoke.args)}</div>
                  {outcome && (
                    <div className={`text-[11px] ${isError ? 'text-artha-danger/90' : 'text-artha-muted'}`}>{outcome}</div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** Turn a tool's JSON result into a one-line plain-English outcome. Never shows
 *  raw JSON — just what happened, so the step list reads like prose. */
function summariseResult(raw?: string): string {
  if (!raw) return '';
  const s = String(raw);
  if (s.startsWith('Error')) return s.replace(/^Error:?\s*/, '').slice(0, 160);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let r: any;
  try { r = JSON.parse(s); } catch { return s.slice(0, 120); }
  if (r?.error) return String(r.error).slice(0, 160);
  if (typeof r?.moved === 'number') return `Moved ${r.moved} file${r.moved === 1 ? '' : 's'}${r.failed ? `, ${r.failed} couldn’t be moved` : ''}`;
  if (r?.moved || r?.to) return 'Moved';
  if (r?.created) return 'Created the folder';
  if (r?.trashed) return 'Moved to Trash';
  if (r?.deleted) return 'Deleted';
  if (r?.copied) return 'Copied';
  if (Array.isArray(r?.files) || Array.isArray(r?.entries)) {
    const n = (r.files ?? r.entries).length;
    return `Found ${n} item${n === 1 ? '' : 's'}`;
  }
  if (r?.content !== undefined) return 'Read the file';
  return 'Done';
}
