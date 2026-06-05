/**
 * WorkspaceSettings — modal hub that collapses every configuration panel into
 * a single keyboard-accessible surface (⌘,). Replaces the 18-item sidebar
 * dump with a left-nav-by-mental-model layout (CORE / KNOWLEDGE / INTEGRATIONS
 * / TEAM / RUNS & HISTORY / General).
 *
 * Deep-linking: any legacy `setActiveView('models')` call opens the modal
 * scrolled to Models, so existing call-sites work without refactor.
 *
 * Each section just renders its existing panel component verbatim — zero
 * internal-UI rework. Search filters the left nav by section/panel name.
 */
import { useEffect, useMemo, useState, type ComponentType } from 'react';
import { Search, X, Cpu, Sparkles, Wrench, Globe, Route, Brain, FolderSearch, Package, Archive, Contact2, Link, Wifi, Code2, Monitor, Store, Users, Clock, History, ShieldCheck, ShieldAlert, ReceiptText, Settings as SettingsIcon, KeyRound, BookOpen, Info, type LucideIcon } from 'lucide-react';
import { useChatStore, type ActiveView } from '../../stores/chat';
import ModelsPanel from '../Settings/ModelsPanel';
import SkillsPanel from '../Settings/SkillsPanel';
import MCPToolsPanel from '../Settings/MCPToolsPanel';
import WebPanel from '../Settings/WebPanel';
import RouterPanel from '../Settings/RouterPanel';
import MemoryPanel from '../Settings/MemoryPanel';
import CrmPanel from '../Settings/CrmPanel';
import RAGPanel from '../Settings/RAGPanel';
import BundlesPanel from '../Settings/BundlesPanel';
import ArtifactsPanel from '../Settings/ArtifactsPanel';
import CloudIntegrationsPanel from '../Settings/CloudIntegrationsPanel';
import LANServerPanel from '../Settings/LANServerPanel';
import IDEIntegrationPanel from '../Settings/IDEIntegrationPanel';
import DesktopControlPanel from '../Settings/DesktopControlPanel';
import MarketplacePanel from '../Settings/MarketplacePanel';
import TeamPanel from '../Settings/TeamPanel';
import LicensePanel from '../Settings/LicensePanel';
import SchedulerPanel from '../Settings/SchedulerPanel';
import TimeTravelPanel from '../Settings/TimeTravelPanel';
import ProvenancePanel from '../Settings/ProvenancePanel';
import PoliciesPanel from '../Settings/PoliciesPanel';
import ReceiptsPanel from '../Settings/ReceiptsPanel';
import SettingsPanel from '../Settings/SettingsPanel';
import GuidePanel from '../Settings/GuidePanel';
import AboutPanel from '../Settings/AboutPanel';

/** A single nav entry inside Workspace Settings. */
interface NavEntry {
  id: Exclude<ActiveView, 'chat'>;
  label: string;
  icon: LucideIcon;
  Panel: ComponentType;
}

/** A nav section — a labelled group of entries. */
interface NavSection {
  id: string;
  label: string;
  entries: NavEntry[];
}

/** Source of truth for the left nav. Order = display order. The grouping
 *  reflects what mental model each panel falls under, NOT the directory it
 *  lives in. */
const SECTIONS: NavSection[] = [
  {
    id: 'core',
    label: 'Core',
    entries: [
      { id: 'models',    label: 'Models',     icon: Cpu,         Panel: ModelsPanel },
      { id: 'skills',    label: 'Skills',     icon: Sparkles,    Panel: SkillsPanel },
      { id: 'mcp',       label: 'MCP Tools',  icon: Wrench,      Panel: MCPToolsPanel },
      { id: 'policies',  label: 'Tool Policies', icon: ShieldAlert, Panel: PoliciesPanel },
      { id: 'web',       label: 'Web',        icon: Globe,       Panel: WebPanel },
      { id: 'router',    label: 'Router',     icon: Route,       Panel: RouterPanel },
    ],
  },
  {
    id: 'knowledge',
    label: 'Knowledge',
    entries: [
      { id: 'memory',    label: 'Memory',     icon: Brain,       Panel: MemoryPanel },
      { id: 'crm',       label: 'CRM',        icon: Contact2,    Panel: CrmPanel },
      { id: 'rag',       label: 'RAG Index',  icon: FolderSearch, Panel: RAGPanel },
      { id: 'bundles',   label: 'Bundles',    icon: Package,     Panel: BundlesPanel },
      { id: 'artifacts', label: 'Artifacts',  icon: Archive,     Panel: ArtifactsPanel },
    ],
  },
  {
    id: 'integrations',
    label: 'Integrations',
    entries: [
      { id: 'cloud',       label: 'Cloud',         icon: Link,    Panel: CloudIntegrationsPanel },
      { id: 'lan',         label: 'LAN Server',    icon: Wifi,    Panel: LANServerPanel },
      { id: 'ide',         label: 'IDE',           icon: Code2,   Panel: IDEIntegrationPanel },
      { id: 'desktop',     label: 'Desktop',       icon: Monitor, Panel: DesktopControlPanel },
      { id: 'marketplace', label: 'Marketplace',   icon: Store,   Panel: MarketplacePanel },
    ],
  },
  {
    id: 'team',
    label: 'Team',
    entries: [
      { id: 'team',      label: 'Team',       icon: Users,       Panel: TeamPanel },
      { id: 'license',   label: 'License',    icon: KeyRound,    Panel: LicensePanel },
    ],
  },
  {
    id: 'runs',
    label: 'Runs & History',
    entries: [
      { id: 'scheduler',  label: 'Scheduled',  icon: Clock,       Panel: SchedulerPanel },
      { id: 'timetravel', label: 'Time travel', icon: History,    Panel: TimeTravelPanel },
      { id: 'receipts',   label: 'Receipts',   icon: ReceiptText, Panel: ReceiptsPanel },
      { id: 'provenance', label: 'Provenance', icon: ShieldCheck, Panel: ProvenancePanel },
    ],
  },
  {
    id: 'general',
    label: 'General',
    entries: [
      { id: 'settings',  label: 'General',    icon: SettingsIcon, Panel: SettingsPanel },
    ],
  },
  {
    id: 'help',
    label: 'Help',
    entries: [
      { id: 'guide', label: 'User Guide', icon: BookOpen, Panel: GuidePanel },
      { id: 'about', label: 'About',      icon: Info,     Panel: AboutPanel },
    ],
  },
];

/** Flat lookup so deep-link routing (`setActiveView('models')`) finds its
 *  entry in O(1). */
const ENTRIES_BY_ID: Record<string, NavEntry> = SECTIONS
  .flatMap(s => s.entries)
  .reduce((acc, e) => { acc[e.id] = e; return acc; }, {} as Record<string, NavEntry>);

/**
 * WorkspaceSettings — modal hub. Renders only when `workspaceSettingsOpen`.
 * Closes on Esc and on backdrop click. Defaults to Models when the caller
 * doesn't specify a section.
 */
export default function WorkspaceSettings() {
  const {
    workspaceSettingsOpen,
    workspaceSettingsSection,
    closeWorkspaceSettings,
    openWorkspaceSettings,
  } = useChatStore();
  const [query, setQuery] = useState('');

  // Esc → close. Cleaned up on unmount + on close.
  useEffect(() => {
    if (!workspaceSettingsOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeWorkspaceSettings();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [workspaceSettingsOpen, closeWorkspaceSettings]);

  // Clear the search query when the modal closes — opening fresh should not
  // remember a stale filter.
  useEffect(() => { if (!workspaceSettingsOpen) setQuery(''); }, [workspaceSettingsOpen]);

  // Filter sections by the current query (matches section label + entry label).
  const filteredSections = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return SECTIONS;
    return SECTIONS
      .map(s => ({
        ...s,
        entries: s.entries.filter(e =>
          e.label.toLowerCase().includes(q) || s.label.toLowerCase().includes(q)
        ),
      }))
      .filter(s => s.entries.length > 0);
  }, [query]);

  if (!workspaceSettingsOpen) return null;

  const activeId: NavEntry['id'] = workspaceSettingsSection ?? 'models';
  const ActivePanel = ENTRIES_BY_ID[activeId]?.Panel ?? ModelsPanel;

  return (
    // Backdrop starts BELOW the TabBar (top: 88px) so the user still sees
    // which tab they came from — closing the modal lands them back in the
    // same room. Standard ⌘, modal pattern from Cursor/Linear.
    <div
      className="fixed left-0 right-0 bottom-0 z-50 flex items-center justify-center bg-artha-bg/60 backdrop-blur-md p-6 animate-fade-in"
      style={{ top: 88 }}
      onClick={(e) => { if (e.target === e.currentTarget) closeWorkspaceSettings(); }}
    >
      <div className="w-full max-w-6xl h-[calc(88vh-88px)] rounded-2xl border border-artha-border bg-artha-surface-raised shadow-modal overflow-hidden flex animate-scale-in">

        {/* ── Left nav ─────────────────────────────────────────────────── */}
        <aside className="w-60 border-r border-artha-border bg-artha-surface2/60 flex flex-col">
          <div className="px-4 pt-5 pb-3 border-b border-artha-border">
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-sm font-semibold text-artha-text">Workspace Settings</h2>
              <button
                onClick={closeWorkspaceSettings}
                aria-label="Close (Esc)"
                className="text-artha-subtle hover:text-artha-text transition-colors p-1 -m-1"
              >
                <X size={14} />
              </button>
            </div>
            <div className="relative">
              <Search size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-artha-subtle" />
              <input
                value={query}
                onChange={e => setQuery(e.target.value)}
                placeholder="Search…"
                className="w-full pl-7 pr-2 py-1.5 text-xs rounded-md border border-artha-border bg-artha-surface text-artha-text placeholder:text-artha-subtle focus:outline-none focus:border-artha-accent"
              />
            </div>
          </div>

          <nav className="flex-1 overflow-y-auto px-2 py-3 space-y-4">
            {filteredSections.map(section => (
              <div key={section.id}>
                <div className="px-2 pb-1 text-[10px] uppercase tracking-wider text-artha-subtle font-semibold">
                  {section.label}
                </div>
                <div className="space-y-0.5">
                  {section.entries.map(entry => {
                    const Icon = entry.icon;
                    const isActive = entry.id === activeId;
                    return (
                      <button
                        key={entry.id}
                        onClick={() => openWorkspaceSettings(entry.id)}
                        className={`w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-xs text-left transition-colors
                          ${isActive
                            ? 'bg-artha-accent/10 text-artha-accent border border-artha-accent/30'
                            : 'text-artha-muted hover:bg-artha-surface hover:text-artha-text border border-transparent'}`}
                      >
                        <Icon size={13} className="shrink-0" />
                        <span className="truncate">{entry.label}</span>
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
            {filteredSections.length === 0 && (
              <p className="px-2 py-4 text-xs text-artha-subtle">No matches.</p>
            )}
          </nav>
        </aside>

        {/* ── Right canvas — the existing panel, rendered as-is ────────── */}
        <div className="flex-1 overflow-y-auto">
          <ActivePanel />
        </div>
      </div>
    </div>
  );
}
