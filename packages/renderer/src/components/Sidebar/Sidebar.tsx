/**
 * Sidebar — the narrow left column present in every app state. Three regions:
 *   1. "New Chat" button — creates a session in main and activates it.
 *   2. Session list — flat list of all chat_sessions, most recent at top.
 *      Selecting one loads its messages and sets activeView to 'chat'.
 *   3. Bottom nav — icon+label rows that switch activeView to the matching
 *      settings/tool panel. Rendered from `navItems` so adding a new panel
 *      only requires one array entry.
 *
 * Per-chat folder/file scopes are no longer attached globally here — they live
 * in the composer (ChatWindow) and are stored per session_id.
 */
import { MessageSquare, Plus, Settings, Cpu, FolderSearch, Wrench, Globe, Route, History, ShieldCheck, Package, Sparkles, Archive, Store, Brain, Code2, Link, Wifi, Monitor, Users } from 'lucide-react';
import { useChatStore, ActiveView } from '../../stores/chat';
import { Tooltip } from '../ui/Tooltip';

/** Sidebar — left-rail navigation and session list. */
export default function Sidebar() {
  const {
    sessions, activeSessionId, setActiveSession, setMessages, setSessions,
    activeView, setActiveView,
  } = useChatStore();

  // Folders/files are now attached per chat from the composer, so the sidebar
  // is a flat list of every session — no global project switcher.
  const visibleSessions = sessions;

  /** Create a new session in main, refresh the list, and activate it. */
  const newChat = async () => {
    const session = await window.artha.sessions.create();
    // Refetch the full list so the sidebar order matches main's DB ordering.
    const updated = await window.artha.sessions.list();
    setSessions(updated);
    setActiveSession(session.session_id);
    setMessages([]);
    setActiveView('chat');
  };

  /** Switch to an existing session: load its messages and activate chat view. */
  const openSession = async (id: string) => {
    setActiveView('chat');
    // setActiveSession clears streaming / pending state first (see chat.ts).
    setActiveSession(id);
    const msgs = await window.artha.sessions.getMessages(id);
    setMessages(msgs);
  };

  // Each entry maps a lucide icon + human label to an ActiveView string.
  // `tip` shows on hover — same one-line copy is reused by FeatureGuide cards
  // inside each panel so the teaching is consistent across surfaces.
  const navItems: { icon: React.ElementType; label: string; view: ActiveView; tip: string }[] = [
    { icon: Cpu,          label: 'Models',     view: 'models',     tip: 'Install and switch between local LLMs (via Ollama)' },
    { icon: Sparkles,     label: 'Skills',     view: 'skills',     tip: 'Named playbooks the agent picks automatically' },
    { icon: Wrench,       label: 'MCP Tools',  view: 'mcp',        tip: 'External tools the agent can use (MCP servers)' },
    { icon: Globe,        label: 'Web',        view: 'web',        tip: 'Web search and fetch settings + cache stats' },
    { icon: FolderSearch, label: 'RAG Index',  view: 'rag',        tip: 'Search inside your folders without uploading them' },
    { icon: Route,        label: 'Router',     view: 'router',     tip: 'Decide which model handles which kind of task' },
    { icon: Archive,      label: 'Artifacts',  view: 'artifacts',  tip: 'Documents and files the agent has generated' },
    { icon: Brain,        label: 'Memory',     view: 'memory',     tip: 'Facts the agent remembers across sessions' },
    { icon: Code2,        label: 'IDE',        view: 'ide',        tip: 'Make VS Code aware of Artha' },
    { icon: Link,         label: 'Cloud',      view: 'cloud',      tip: 'Connect Google, Notion, and other accounts' },
    { icon: Wifi,         label: 'LAN Server', view: 'lan',        tip: 'Expose Artha to other devices on your LAN' },
    { icon: Monitor,      label: 'Desktop',    view: 'desktop',    tip: 'Let the agent control mouse and keyboard' },
    { icon: Users,        label: 'Team',       view: 'team',       tip: 'Roster of team members + shared memories' },
    { icon: Store,        label: 'Marketplace', view: 'marketplace', tip: 'Browse skill packs and bundles from the community' },
    { icon: History,      label: 'Time Travel', view: 'timetravel', tip: 'Fork past runs from any step to retry differently' },
    { icon: ShieldCheck,  label: 'Provenance', view: 'provenance', tip: 'Audit log of every tool call and file change' },
    { icon: Package,      label: 'Bundles',    view: 'bundles',    tip: 'Export full runs as portable, replayable archives' },
    { icon: Settings,     label: 'Settings',   view: 'settings',   tip: 'General preferences' },
  ];

  return (
    <aside className="flex flex-col w-56 bg-artha-surface2 border-r border-artha-border pt-10 shrink-0">
      {/* New chat — primary accent button */}
      <div className="px-3 mb-3">
        <button onClick={newChat}
          className="no-drag flex items-center gap-2 w-full px-3 py-2 rounded-lg bg-artha-accent hover:bg-artha-accent-hover text-white text-sm font-medium transition-colors shadow-soft">
          <Plus size={15} /> New Chat
        </button>
      </div>

      {/* Sessions list */}
      <div className="flex-1 overflow-y-auto px-3 space-y-1">
        {visibleSessions.length === 0 && (
          <p className="px-3 py-2 text-xs text-artha-subtle">
            No chats yet.
          </p>
        )}
        {visibleSessions.map(s => (
          // Active highlight only applies when the chat view is showing — so
          // a session row stays unhighlighted while a settings panel is open.
          <button key={s.session_id} onClick={() => openSession(s.session_id)}
            className={`no-drag flex items-center gap-2 w-full px-3 py-2 rounded-lg text-sm text-left transition-colors truncate
              ${s.session_id === activeSessionId && activeView === 'chat'
                ? 'bg-artha-surface text-artha-text border border-artha-border-strong shadow-soft'
                : 'text-artha-muted hover:bg-artha-surface hover:text-artha-text'}`}>
            <MessageSquare size={13} className="shrink-0" />
            <span className="truncate">{s.title}</span>
          </button>
        ))}
      </div>

      {/* Bottom nav */}
      <nav className="border-t border-artha-border p-3 space-y-1">
        {navItems.map(({ icon: Icon, label, view, tip }) => (
          <Tooltip key={label} content={tip} side="right" sideOffset={10}>
            <button
              onClick={() => setActiveView(view)}
              className={`no-drag flex items-center gap-2 w-full px-3 py-2 rounded-lg text-sm transition-colors
                ${activeView === view
                  ? 'bg-artha-surface text-artha-accent border border-artha-border shadow-soft'
                  : 'text-artha-muted hover:bg-artha-surface hover:text-artha-text'}`}>
              <Icon size={14} /> {label}
            </button>
          </Tooltip>
        ))}
      </nav>
    </aside>
  );
}
