/**
 * CodeTab — folder-anchored mode. Two-pane: a depth-2 file tree on the left
 * (sourced from the active project's root via `fs:tree`), and the existing
 * ChatWindow on the right so users get code-aware chat in the same surface.
 *
 * No-project state: a friendly nudge to either attach a folder to the
 * current chat or create a project. The Code tab is meaningless without a
 * root path to anchor.
 *
 * Phase 1 scope: read-only tree. File-clicking → opening in the IDE is a
 * follow-up. The agent already has fs_read_file when needed.
 */
import { useEffect, useState } from 'react';
import { Keyboard, Folder, FolderPlus, RefreshCw } from 'lucide-react';
import { useChatStore } from '../../stores/chat';
import ChatWindow from '../Chat/ChatWindow';

/** The Code tab canvas. */
export default function CodeTab() {
  const { projects, activeProjectId, openWorkspaceSettings } = useChatStore();
  const active = projects.find(p => p.project_id === activeProjectId) ?? null;

  const [tree, setTree] = useState<string>('');
  const [loading, setLoading] = useState(false);

  const refresh = async () => {
    if (!active) { setTree(''); return; }
    setLoading(true);
    try {
      setTree(await window.artha.fs.tree(active.root_path, 120));
    } catch {
      setTree('');
    } finally {
      setLoading(false);
    }
  };

  // Re-fetch tree whenever the active project changes. `refresh` closes over
  // `active` but the dep we actually care about is the project id — adding
  // `refresh` here would loop on every render.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { void refresh(); }, [activeProjectId]);

  // ── No-project state ─────────────────────────────────────────────────
  if (!active) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="max-w-md text-center px-8 py-12">
          <div className="inline-flex items-center justify-center w-12 h-12 rounded-2xl bg-artha-accent/10 border border-artha-accent/30 mb-4">
            <Keyboard size={20} className="text-artha-accent" />
          </div>
          <h1 className="text-lg font-semibold text-artha-text mb-2">
            Pick a project to use Code mode
          </h1>
          <p className="text-sm text-artha-muted mb-6 leading-relaxed">
            Code mode pairs a file tree with a chat scoped to a folder, so the agent can
            read source files directly and you can ask grounded questions.
          </p>
          <button
            onClick={() => openWorkspaceSettings('rag')}
            className="inline-flex items-center gap-2 px-3 py-2 rounded-lg bg-artha-accent hover:bg-artha-accent-hover text-artha-on-accent text-sm font-medium transition-colors shadow-soft"
          >
            <FolderPlus size={14} /> Set up a project
          </button>
        </div>
      </div>
    );
  }

  // ── Active project: split pane ──────────────────────────────────────
  return (
    <div className="flex-1 flex overflow-hidden">

      {/* Left: file tree */}
      <aside className="w-72 border-r border-artha-border bg-artha-surface2/40 flex flex-col">
        {/* Sub-nav (dot-separated, no nested tabs) */}
        <div className="px-4 py-2.5 border-b border-artha-border text-[11px] text-artha-subtle flex items-center gap-2">
          <span className="text-artha-text font-medium">Files</span>
          <span>·</span>
          <span>Browser</span>
          <span className="ml-auto opacity-70">opens on demand</span>
        </div>

        {/* Project + root path */}
        <div className="px-4 pt-3 pb-2 border-b border-artha-border">
          <div className="flex items-center gap-2 text-xs text-artha-text mb-1">
            <Folder size={11} className="text-artha-accent" />
            <span className="font-medium truncate">{active.name}</span>
          </div>
          <p className="text-[10px] text-artha-subtle font-mono truncate" title={active.root_path}>
            {active.root_path}
          </p>
        </div>

        {/* Tree */}
        <div className="flex-1 overflow-y-auto px-4 py-3">
          {loading ? (
            <p className="text-[11px] text-artha-subtle">Reading folder…</p>
          ) : tree ? (
            <pre className="text-[11px] font-mono leading-snug text-artha-muted whitespace-pre">
              {tree}
            </pre>
          ) : (
            <p className="text-[11px] text-artha-subtle">Folder is empty or unreadable.</p>
          )}
        </div>

        {/* Tree footer: RAG + reload */}
        <div className="px-4 py-2.5 border-t border-artha-border text-[11px] flex items-center gap-2">
          {active.rag_index_id ? (
            <span className="inline-flex items-center gap-1 text-artha-muted">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
              Indexed
            </span>
          ) : (
            <span className="inline-flex items-center gap-1 text-artha-subtle">
              <span className="w-1.5 h-1.5 rounded-full bg-artha-subtle" />
              No index
            </span>
          )}
          <button
            onClick={refresh}
            className="ml-auto inline-flex items-center gap-1 text-artha-subtle hover:text-artha-text transition-colors"
            title="Reload tree"
          >
            <RefreshCw size={10} /> Reload
          </button>
        </div>
      </aside>

      {/* Right: code chat (reuses the existing chat window — scope is
          handled by the orchestrator's per-chat folder sandbox). */}
      <ChatWindow />
    </div>
  );
}
