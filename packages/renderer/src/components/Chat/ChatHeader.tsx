/**
 * ChatHeader — the contextual bar above the conversation. Answers "where am I"
 * and puts per-chat actions in one consistent place instead of scattered around
 * the composer and sidebar:
 *   • Breadcrumb — Project ▸ Chat title (the title is inline-editable).
 *   • Scope chip — how many folders/files this chat is sandboxed to.
 *   • Run details — opens the Run Inspector for this chat's most recent run.
 */
import { useEffect, useRef, useState } from 'react';
import { Folder, Pencil, Check, X, FileText, ReceiptText, Lock } from 'lucide-react';
import { useChatStore } from '../../stores/chat';
import { Tooltip } from '../ui/Tooltip';

export default function ChatHeader() {
  const {
    activeSessionId, sessions, setSessions, projects, activeProjectId,
    scopes, setInspectorRunId,
  } = useChatStore();

  const session = sessions.find(s => s.session_id === activeSessionId) ?? null;
  const project = projects.find(p => p.project_id === activeProjectId) ?? null;

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [noRun, setNoRun] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { setEditing(false); setNoRun(false); }, [activeSessionId]);
  useEffect(() => { if (editing) setTimeout(() => inputRef.current?.select(), 30); }, [editing]);

  if (!activeSessionId || !session) return null;

  const folders = scopes.filter(s => s.kind === 'folder').length;
  const files = scopes.filter(s => s.kind === 'file').length;

  const startEdit = () => { setDraft(session.title); setEditing(true); };

  const save = async () => {
    const saved = await window.artha.sessions.rename(session.session_id, draft);
    setSessions(sessions.map(s => s.session_id === session.session_id ? { ...s, title: saved } : s));
    setEditing(false);
  };

  const openRunDetails = async () => {
    const runs = await window.artha.timetravel.listRuns(session.session_id) as { run_id: string }[];
    if (runs?.length) setInspectorRunId(runs[0].run_id);
    else { setNoRun(true); setTimeout(() => setNoRun(false), 2200); }
  };

  const scopeLabel = folders || files
    ? [folders && `${folders} folder${folders === 1 ? '' : 's'}`, files && `${files} file${files === 1 ? '' : 's'}`].filter(Boolean).join(' · ')
    : 'No scope';

  return (
    <div className="flex items-center gap-2 px-4 py-2 border-b border-artha-border bg-artha-surface2/30 shrink-0">
      {/* Breadcrumb */}
      <div className="flex items-center gap-1.5 min-w-0">
        {project && (
          <>
            <Folder size={12} className="text-artha-accent shrink-0" />
            <span className="text-xs text-artha-muted truncate max-w-[140px]">{project.name}</span>
            <span className="text-artha-subtle text-xs">▸</span>
          </>
        )}
        {editing ? (
          <div className="flex items-center gap-1">
            <input
              ref={inputRef}
              value={draft}
              onChange={e => setDraft(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') save(); if (e.key === 'Escape') setEditing(false); }}
              className="text-sm font-medium text-artha-text bg-artha-bg border border-artha-accent/50 rounded px-2 py-0.5 focus:outline-none min-w-[160px]"
            />
            <button onClick={save} aria-label="Save title" className="p-1 text-artha-success hover:opacity-80"><Check size={13} /></button>
            <button onClick={() => setEditing(false)} aria-label="Cancel" className="p-1 text-artha-subtle hover:text-artha-text"><X size={13} /></button>
          </div>
        ) : (
          <button onClick={startEdit} className="group flex items-center gap-1.5 min-w-0" title="Rename chat">
            <span className="text-sm font-medium text-artha-text truncate max-w-[280px]">{session.title}</span>
            <Pencil size={11} className="text-artha-subtle opacity-0 group-hover:opacity-100 transition-opacity shrink-0" />
          </button>
        )}
      </div>

      {/* Right actions */}
      <div className="ml-auto flex items-center gap-2 shrink-0">
        <Tooltip
          content={scopes.length ? scopes.map(s => s.path).join('\n') : 'This chat has no folder scope — the agent works without a sandbox.'}
          side="bottom"
          sideOffset={6}
        >
          <span className="flex items-center gap-1.5 px-2 py-1 rounded-md border border-artha-border text-[11px] text-artha-muted">
            <Lock size={10} className="text-artha-accent" />
            {scopeLabel}
          </span>
        </Tooltip>

        <Tooltip content={noRun ? 'No runs in this chat yet' : 'See exactly what the agent did (receipts + steps)'} side="bottom" sideOffset={6}>
          <button
            onClick={openRunDetails}
            className="flex items-center gap-1.5 px-2.5 py-1 rounded-md border border-artha-border text-[11px] text-artha-muted hover:text-artha-text hover:border-artha-accent transition-colors"
          >
            {noRun ? <FileText size={11} /> : <ReceiptText size={11} className="text-artha-accent" />}
            Run details
          </button>
        </Tooltip>
      </div>
    </div>
  );
}
