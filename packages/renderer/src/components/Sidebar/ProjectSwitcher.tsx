/**
 * ProjectSwitcher — chip at the top of the sidebar that shows the active
 * project and opens a dropdown to switch (or create) one. Lives in the
 * sidebar header above "+ New Chat" so projects feel like the primary
 * organising unit of the app (Linear / Notion convention).
 *
 * Project list is loaded from the chat store; refreshing it is the parent's
 * responsibility (App.tsx hydrates on mount, this component refreshes after
 * `projects.create()` returns).
 */
import { useEffect, useRef, useState } from 'react';
import { ChevronDown, Plus, Folder, Check, Star, Trash2 } from 'lucide-react';
import { useChatStore } from '../../stores/chat';

/** Compact project chip + dropdown. Closes on outside click and Esc. */
export default function ProjectSwitcher() {
  const {
    projects, activeProjectId, selectProject, setProjects, setMessages, setSessions,
  } = useChatStore();
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  const active = projects.find(p => p.project_id === activeProjectId) ?? null;

  // Outside-click + Escape both close the dropdown.
  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  // Switching project also lands the user on that project's most recent
  // chat (or its empty state), so the canvas changes instead of stranding
  // them on a session that no longer belongs to the visible scope.
  const pick = async (projectId: string | null) => {
    const nextSessionId = selectProject(projectId);
    setOpen(false);
    if (nextSessionId) {
      const msgs = await window.artha.sessions.getMessages(nextSessionId);
      setMessages(msgs);
    }
  };

  // Delete a project from the dropdown. Chats aren't destroyed — the backend
  // moves them to "General" — so this just removes the grouping. Refresh both
  // lists (chats may have changed bucket) and, if the active project was the
  // one removed, fall back to General so the canvas isn't left orphaned.
  const removeProject = async (e: React.MouseEvent, id: string) => {
    e.stopPropagation(); // don't let the row's `pick` fire, and don't close yet
    if (!confirm('Delete this project? Its chats are kept and moved to "General" — only the project grouping is removed. This cannot be undone.')) return;
    await window.artha.projects.delete(id);
    const [freshProjects, freshSessions] = await Promise.all([
      window.artha.projects.list(),
      window.artha.sessions.list(),
    ]);
    setProjects(freshProjects);
    setSessions(freshSessions);
    if (id === activeProjectId) {
      const nextSessionId = selectProject(null);
      if (nextSessionId) setMessages(await window.artha.sessions.getMessages(nextSessionId));
    }
    setOpen(false);
  };

  // "+ New project" → main shows a folder picker; we refresh the list and
  // auto-activate the new project on success (via selectProject so it lands
  // on the project's most recent chat or its empty state).
  const newProject = async () => {
    setCreating(true);
    try {
      const created = await window.artha.projects.create();
      const refreshed = await window.artha.projects.list();
      setProjects(refreshed);
      if (created) {
        const nextSessionId = selectProject(created.project_id);
        if (nextSessionId) {
          const msgs = await window.artha.sessions.getMessages(nextSessionId);
          setMessages(msgs);
        }
      }
      setOpen(false);
    } finally {
      setCreating(false);
    }
  };

  return (
    <div ref={wrapRef} className="relative">
      <button
        onClick={() => setOpen(o => !o)}
        className="no-drag w-full flex items-center gap-2 px-3 py-2 rounded-lg border border-artha-border bg-artha-surface hover:border-artha-border-strong text-sm text-artha-text transition-colors"
      >
        <Folder size={13} className="text-artha-accent shrink-0" />
        <span className="truncate flex-1 text-left">
          {active ? active.name : 'No project'}
        </span>
        <ChevronDown size={12} className="text-artha-subtle shrink-0" />
      </button>

      {/* ── Dropdown ─────────────────────────────────────────────────── */}
      {open && (
        <div className="absolute left-0 right-0 top-full mt-1 z-30 rounded-lg border border-artha-border bg-artha-surface-raised shadow-modal overflow-hidden origin-top animate-scale-in">
          <div className="px-3 py-1.5 text-[10px] uppercase tracking-wider text-artha-subtle font-semibold">
            Switch project
          </div>

          <div className="max-h-64 overflow-y-auto">
            {/* "No project" — the always-available general bucket */}
            <button
              onClick={() => pick(null)}
              className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-left hover:bg-artha-surface2 text-artha-muted hover:text-artha-text transition-colors"
            >
              <span className="w-3 inline-block">
                {activeProjectId === null && <Check size={12} className="text-artha-accent" />}
              </span>
              <Star size={11} className="text-artha-subtle" />
              <span className="flex-1">No project (general)</span>
            </button>

            {projects.map(p => (
              // Flex row (not a button) so the delete control nests beside the
              // switch-project button rather than inside it.
              <div
                key={p.project_id}
                className="group w-full flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-artha-surface2 transition-colors"
                title={p.root_path}
              >
                <button
                  onClick={() => pick(p.project_id)}
                  className="flex items-center gap-2 flex-1 min-w-0 text-left text-artha-muted hover:text-artha-text"
                >
                  <span className="w-3 inline-block">
                    {activeProjectId === p.project_id && <Check size={12} className="text-artha-accent" />}
                  </span>
                  <Folder size={11} className="text-artha-subtle shrink-0" />
                  <span className="truncate flex-1">{p.name}</span>
                </button>
                <button
                  onClick={(e) => removeProject(e, p.project_id)}
                  aria-label="Delete project"
                  title="Delete project (chats are kept, moved to General)"
                  className="shrink-0 p-1 rounded opacity-0 group-hover:opacity-100 focus:opacity-100 text-artha-subtle hover:text-red-400 hover:bg-red-500/20 transition-all"
                >
                  <Trash2 size={11} />
                </button>
              </div>
            ))}
            {projects.length === 0 && (
              <p className="px-3 py-3 text-[11px] text-artha-subtle">
                No projects yet. Create one to scope chats to a folder.
              </p>
            )}
          </div>

          <div className="border-t border-artha-border">
            <button
              onClick={newProject}
              disabled={creating}
              className="w-full flex items-center gap-2 px-3 py-2 text-xs text-artha-accent hover:bg-artha-accent/10 transition-colors disabled:opacity-50"
            >
              <Plus size={12} />
              {creating ? 'Opening picker…' : 'New project'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
