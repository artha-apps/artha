/**
 * TabBar — the three top-level rooms inside the Chat view: Chat, Workflows,
 * Code. Sits at the top of the main canvas, not full-width across the
 * sidebar; the sidebar is mode-agnostic so the active project / chat list
 * stays in view across tabs.
 *
 * Also renders the persistent scope-lock badge on the right (the local-first
 * story is a feature — it should always be visible).
 */
import { MessageSquare, Workflow, Code2, Lock } from 'lucide-react';
import { useChatStore, type ActiveTab, type Project } from '../../stores/chat';
import { Tooltip } from '../ui/Tooltip';

interface TabDef {
  id: ActiveTab;
  label: string;
  icon: typeof MessageSquare;
  /** Tooltip + screen-reader description. */
  tip: string;
}

const TABS: TabDef[] = [
  { id: 'chat',      label: 'Chat',      icon: MessageSquare, tip: 'Conversational mode' },
  { id: 'workflows', label: 'Workflows', icon: Workflow,      tip: 'Things Artha runs on a plan or schedule' },
  { id: 'code',      label: 'Code',      icon: Code2,         tip: 'Folder-anchored, file-aware mode' },
];

/** Single row of tabs + the always-visible scope badge. */
export default function TabBar() {
  const { activeTab, setActiveTab, projects, activeProjectId } = useChatStore();
  const activeProject = projects.find((p: Project) => p.project_id === activeProjectId) ?? null;

  return (
    <div className="flex items-center justify-between px-3 py-1.5 border-b border-artha-border bg-artha-surface2/40">
      {/* ── Tabs ───────────────────────────────────────────────────────── */}
      <div className="flex items-center gap-0.5">
        {TABS.map(({ id, label, icon: Icon, tip }) => {
          const isActive = id === activeTab;
          return (
            <Tooltip key={id} content={tip} side="bottom" sideOffset={6}>
              <button
                onClick={() => setActiveTab(id)}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-colors
                  ${isActive
                    ? 'bg-artha-surface text-artha-text border border-artha-border shadow-soft'
                    : 'text-artha-muted hover:bg-artha-surface hover:text-artha-text border border-transparent'}`}
              >
                <Icon size={13} />
                {label}
              </button>
            </Tooltip>
          );
        })}
      </div>

      {/* ── Scope badge ────────────────────────────────────────────────── */}
      {/* Always visible — it's Artha's privacy promise made tangible. */}
      <Tooltip
        content={activeProject
          ? `Sandboxed to ${activeProject.root_path}`
          : 'No project — agent has no folder scope'}
        side="bottom"
        sideOffset={6}
      >
        <div className="flex items-center gap-1.5 px-2 py-1 rounded-md border border-artha-border text-[11px] text-artha-muted">
          <Lock size={10} className="text-artha-accent" />
          <span className="truncate max-w-[160px]">
            {activeProject ? activeProject.name : 'No project'}
          </span>
        </div>
      </Tooltip>
    </div>
  );
}
