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
import { ChevronDown, Plus, Folder, Check, Star } from 'lucide-react';
import { useChatStore } from '../../stores/chat';

/** Compact project chip + dropdown. Closes on outside click and Esc. */
export default function ProjectSwitcher() {
  const { projects, activeProjectId, setActiveProjectId, setProjects } = useChatStore();
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

  const pick = (projectId: string | null) => {
    setActiveProjectId(projectId);
    setOpen(false);
  };

  // "+ New project" → main shows a folder picker; we refresh the list and
  // auto-activate the new project on success.
  const newProject = async () => {
    setCreating(true);
    try {
      const created = await window.artha.projects.create();
      const refreshed = await window.artha.projects.list();
      setProjects(refreshed);
      if (created) setActiveProjectId(created.project_id);
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
        <div className="absolute left-0 right-0 top-full mt-1 z-30 rounded-lg border border-artha-border bg-artha-surface shadow-modal overflow-hidden">
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
              <button
                key={p.project_id}
                onClick={() => pick(p.project_id)}
                className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-left hover:bg-artha-surface2 text-artha-muted hover:text-artha-text transition-colors"
                title={p.root_path}
              >
                <span className="w-3 inline-block">
                  {activeProjectId === p.project_id && <Check size={12} className="text-artha-accent" />}
                </span>
                <Folder size={11} className="text-artha-subtle shrink-0" />
                <span className="truncate flex-1">{p.name}</span>
              </button>
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
