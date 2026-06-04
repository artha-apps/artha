/**
 * TabBar — the four top-level rooms inside the canvas: Chat (conversational),
 * Workflows, Code, and Delegate. Each is colour-coded with its own accent
 * (indigo / violet / emerald / amber, see lib/tabTheme) so the rooms read as
 * distinct. "Artha" is the application name; "Chat" is this conversational room.
 * Sits at
 * the top of the main canvas, not full-width across the sidebar; the sidebar is
 * mode-agnostic so the active project / chat list stays in view across tabs.
 *
 * Also renders the persistent scope-lock badge on the right (the local-first
 * story is a feature — it should always be visible).
 */
import { Sparkles, Workflow, Code2, Send, Lock, HelpCircle } from 'lucide-react';
import { useChatStore, type ActiveTab, type Project } from '../../stores/chat';
import { Tooltip } from '../ui/Tooltip';
import { TAB_THEME } from '../../lib/tabTheme';
import ModelPicker from './ModelPicker';

interface TabDef {
  id: ActiveTab;
  label: string;
  icon: typeof Sparkles;
  /** Tooltip + screen-reader description. */
  tip: string;
}

// `id` stays 'chat' (persisted in localStorage + the store union) so the rename
// to "Artha" is label-only and doesn't churn state. Labels/colours come paired
// with TAB_THEME by id.
const TABS: TabDef[] = [
  { id: 'chat',      label: 'Chat',      icon: Sparkles, tip: 'Think with Artha — conversational mode' },
  { id: 'workflows', label: 'Workflows', icon: Workflow, tip: 'Automate with Artha — things it runs on a plan or schedule' },
  { id: 'code',      label: 'Code',      icon: Code2,    tip: 'Build with Artha — folder-anchored, file-aware mode' },
  { id: 'delegate',  label: 'Delegate',  icon: Send,     tip: 'Hand work over to Artha — give it a goal and it plans, coordinates, and gets it done' },
];

/** Single row of tabs + the always-visible scope badge. */
export default function TabBar() {
  const { activeTab, setActiveTab, projects, activeProjectId, workspaceSettingsOpen, openGuide } = useChatStore();
  const activeProject = projects.find((p: Project) => p.project_id === activeProjectId) ?? null;

  return (
    <div className="flex items-center justify-between px-3 py-1.5 border-b border-artha-border bg-artha-surface2/40">
      {/* ── Tabs ───────────────────────────────────────────────────────── */}
      <div className="flex items-center gap-0.5">
        {TABS.map(({ id, label, icon: Icon, tip }) => {
          const isActive = id === activeTab;
          const theme = TAB_THEME[id];
          // Active tab is tinted with its own accent (coloured icon, text, soft
          // fill, accent border); inactive tabs stay neutral grey. Colours are
          // applied inline because they're per-tab and chosen at runtime.
          return (
            <Tooltip key={id} content={tip} side="bottom" sideOffset={6}>
              <button
                onClick={() => setActiveTab(id)}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-all duration-200 active:scale-95
                  ${isActive
                    ? 'bg-artha-surface text-artha-text border border-artha-accent/40 shadow-glow-sm'
                    : 'text-artha-muted hover:bg-artha-surface hover:text-artha-text border border-transparent'}`}
              >
                <Icon size={13} style={isActive ? { color: theme.accent } : undefined} />
                {label}
              </button>
            </Tooltip>
          );
        })}
      </div>

      {/* ── Right rail: help + active model + scope badge ──────────────── */}
      <div className="flex items-center gap-2">
        {/* Help — opens the "How to use Artha" feature guide. */}
        <Tooltip content="How to use Artha" side="bottom" sideOffset={6}>
          <button
            onClick={openGuide}
            className="flex items-center justify-center w-7 h-7 rounded-md border border-artha-border text-artha-muted hover:text-artha-text hover:border-artha-accent hover:shadow-glow-sm transition-all duration-200 active:scale-95"
            aria-label="How to use Artha"
          >
            <HelpCircle size={13} />
          </button>
        </Tooltip>

        {/* Active model — inline searchable picker (switch without leaving the
            chat). Refreshes when the Settings modal closes. */}
        <ModelPicker refreshKey={workspaceSettingsOpen} />

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
