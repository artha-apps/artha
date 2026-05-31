/**
 * TabBar — the three top-level rooms inside the Chat view: Chat, Workflows,
 * Code. Sits at the top of the main canvas, not full-width across the
 * sidebar; the sidebar is mode-agnostic so the active project / chat list
 * stays in view across tabs.
 *
 * Also renders the persistent scope-lock badge on the right (the local-first
 * story is a feature — it should always be visible).
 */
import { useEffect, useState } from 'react';
import { MessageSquare, Workflow, Code2, Lock, Cpu } from 'lucide-react';
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
  const { activeTab, setActiveTab, projects, activeProjectId, openWorkspaceSettings, workspaceSettingsOpen } = useChatStore();
  const activeProject = projects.find((p: Project) => p.project_id === activeProjectId) ?? null;

  // Active model chip — so the user can always see which model is selected,
  // not just buried in Settings. Re-fetch when the settings modal closes
  // (where the model gets switched).
  const [activeModel, setActiveModel] = useState<string | null>(null);
  useEffect(() => {
    if (workspaceSettingsOpen) return; // refresh on close, not while open
    window.artha.llm.getActiveModel().then(setActiveModel).catch(() => setActiveModel(null));
  }, [workspaceSettingsOpen]);

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

      {/* ── Right rail: active model + scope badge ─────────────────────── */}
      <div className="flex items-center gap-2">
        {/* Active model chip — click to change in Settings → Models. Lets the
            user confirm which model is actually selected without digging. */}
        <Tooltip
          content={activeModel ? `Active model: ${activeModel} · click to change` : 'No model selected — click to choose'}
          side="bottom"
          sideOffset={6}
        >
          <button
            onClick={() => openWorkspaceSettings('models')}
            className="flex items-center gap-1.5 px-2 py-1 rounded-md border border-artha-border text-[11px] text-artha-muted hover:text-artha-text hover:border-artha-accent transition-colors"
          >
            <Cpu size={10} className="text-artha-accent shrink-0" />
            <span className="truncate max-w-[160px]">{activeModel ?? 'No model'}</span>
          </button>
        </Tooltip>

        {/* Scope badge — always visible; Artha's privacy promise made tangible. */}
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
    </div>
  );
}
