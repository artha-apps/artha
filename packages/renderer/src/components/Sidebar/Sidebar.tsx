/**
 * Sidebar — the narrow left column. Restructured around projects-first IA:
 *
 *   1. ProjectSwitcher (active project chip + dropdown)
 *   2. "+ New Chat" button (creates a session in the active project)
 *   3. PROJECTS section — collapsible flat list, click to switch
 *   4. CHATS section — filtered to the active project, collapsible
 *   5. ⚙ Workspace Settings — opens the modal (⌘,)
 *
 * The mode tabs (Chat / Workflows / Code) live above the canvas in TabBar.tsx,
 * not here — the sidebar is mode-agnostic so projects/chats stay in view as
 * you switch tabs.
 */
import { useEffect, useState } from 'react';
import { MessageSquare, Plus, Settings as SettingsIcon, ChevronDown, ChevronRight, Folder, Trash2, Search, Pin, X } from 'lucide-react';
import { useChatStore, type Session } from '../../stores/chat';
import { createChat } from '../../lib/newChat';
import { Tooltip } from '../ui/Tooltip';
import { BrandWordmark } from '../ui/BrandWordmark';
import ThemeToggle from '../ui/ThemeToggle';
import ProjectSwitcher from './ProjectSwitcher';

const PINS_KEY = 'artha.pinnedChats';

/** Load the pinned-chat id set from localStorage (best-effort). */
function loadPins(): Set<string> {
  try {
    const raw = localStorage.getItem(PINS_KEY);
    const arr = raw ? (JSON.parse(raw) as unknown) : [];
    return new Set(Array.isArray(arr) ? arr.filter((x): x is string => typeof x === 'string') : []);
  } catch { return new Set(); }
}

/** Bucket a session by recency for time-grouped display. last_activity is a
 *  unix epoch in seconds (DB unixepoch()); tolerate ms too. */
function bucketOf(lastActivity: number | undefined): 'Today' | 'Yesterday' | 'Previous 7 days' | 'Earlier' {
  if (!lastActivity) return 'Earlier';
  const ms = lastActivity > 1e12 ? lastActivity : lastActivity * 1000;
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const dayMs = 86_400_000;
  if (ms >= startOfToday) return 'Today';
  if (ms >= startOfToday - dayMs) return 'Yesterday';
  if (ms >= startOfToday - 7 * dayMs) return 'Previous 7 days';
  return 'Earlier';
}

const BUCKET_ORDER = ['Today', 'Yesterday', 'Previous 7 days', 'Earlier'] as const;

/** Sidebar — left-rail navigation. */
export default function Sidebar() {
  const {
    sessions, activeSessionId, setActiveSession, setMessages, setSessions,
    activeView, projects, activeProjectId, selectProject, setProjects,
    openWorkspaceSettings, setActiveTab,
  } = useChatStore();

  // Section collapse state — long projects/chats lists shouldn't bury each
  // other. Defaults: both expanded. Persistence not warranted for v1.
  const [projectsOpen, setProjectsOpen] = useState(true);
  const [chatsOpen, setChatsOpen] = useState(true);
  // Chat finder: free-text filter + pinned-chat set (persisted to localStorage).
  const [query, setQuery] = useState('');
  const [pinned, setPinned] = useState<Set<string>>(loadPins);

  /** Toggle a chat's pinned state and persist. Pinned chats float to a section
   *  at the top of the list, surviving reloads. */
  const togglePin = (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    setPinned(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      try { localStorage.setItem(PINS_KEY, JSON.stringify([...next])); } catch { /* ignore */ }
      return next;
    });
  };

  /** Drop a pin without toggling it on — used when a chat is deleted so its id
   *  doesn't linger in localStorage forever. */
  const dropPin = (id: string) => {
    setPinned(prev => {
      if (!prev.has(id)) return prev;
      const next = new Set(prev);
      next.delete(id);
      try { localStorage.setItem(PINS_KEY, JSON.stringify([...next])); } catch { /* ignore */ }
      return next;
    });
  };

  // Hydrate the project list on mount. Sessions are hydrated by App.tsx.
  useEffect(() => {
    window.artha.projects.list().then(setProjects).catch(() => { /* fresh DB */ });
  }, [setProjects]);

  // Chats list = sessions filtered to the active project. `null` project
  // means "general" → sessions with no project_id.
  const visibleSessions = activeProjectId === null
    ? sessions.filter(s => !s.project_id)
    : sessions.filter(s => s.project_id === activeProjectId);

  // Apply the search filter. When searching we show a single flat, relevance-
  // agnostic list (title substring match); when not, we group by recency below.
  const q = query.trim().toLowerCase();
  const matched = q ? visibleSessions.filter(s => s.title.toLowerCase().includes(q)) : visibleSessions;

  // Pinned chats float to their own section; the rest are bucketed by recency.
  const pinnedSessions = matched.filter(s => pinned.has(s.session_id));
  const unpinned = matched.filter(s => !pinned.has(s.session_id));
  const buckets: Record<string, Session[]> = {};
  if (!q) {
    for (const s of unpinned) {
      const b = bucketOf(s.last_activity);
      (buckets[b] ??= []).push(s);
    }
  }

  /** Create a new session inside the active project and activate it. Shared
   *  helper — attaches the project root scope, consistent with every other
   *  new-chat entry point (see lib/newChat.ts). */
  const newChat = () => createChat(activeProjectId);

  /** Switch to an existing session: load its messages and ensure Chat tab. */
  const openSession = async (id: string) => {
    setActiveTab('chat');
    setActiveSession(id);
    const msgs = await window.artha.sessions.getMessages(id);
    setMessages(msgs);
  };

  /** Permanently delete a chat after a confirm. The IPC cascades to the
   *  session's messages, scopes, and agent state. When the deleted chat is the
   *  active one, fall back to the most recent remaining chat in this project,
   *  or a fresh empty chat if none are left — never leave the UI pointed at a
   *  session that no longer exists. */
  const deleteChat = async (e: React.MouseEvent, id: string) => {
    e.stopPropagation(); // don't also open the chat we're deleting
    if (!confirm('Delete this chat? This permanently removes the conversation and all of its messages. This cannot be undone.')) return;
    await window.artha.sessions.delete(id);
    dropPin(id); // don't leave an orphan pin in localStorage
    const updated: Session[] = await window.artha.sessions.list();
    setSessions(updated);
    if (id !== activeSessionId) return; // deleted a background chat — nothing else to do
    const siblings = activeProjectId === null
      ? updated.filter(s => !s.project_id)
      : updated.filter(s => s.project_id === activeProjectId);
    if (siblings.length > 0) await openSession(siblings[0].session_id);
    else await newChat();
  };

  /** Delete a project after a confirm. Its chats are NOT destroyed — the
   *  backend reassigns them to "General" (no project) — so this only removes
   *  the grouping. Refresh both lists (chats may have moved buckets), and if
   *  the deleted project was the active one, drop the user into General so
   *  they're never stranded on a project that no longer exists. */
  const deleteProject = async (e: React.MouseEvent, id: string) => {
    e.stopPropagation(); // don't also select the project we're deleting
    if (!confirm('Delete this project? Its chats are kept and moved to "General" — only the project grouping is removed. This cannot be undone.')) return;
    await window.artha.projects.delete(id);
    // Chats may have moved to General, so refresh sessions alongside projects.
    const [freshProjects, freshSessions] = await Promise.all([
      window.artha.projects.list(),
      window.artha.sessions.list() as Promise<Session[]>,
    ]);
    setProjects(freshProjects);
    setSessions(freshSessions);
    if (id !== activeProjectId) return; // deleted a non-active project — view unchanged
    const nextSessionId = selectProject(null); // land in General
    if (nextSessionId) setMessages(await window.artha.sessions.getMessages(nextSessionId));
  };

  /** One chat row — open button + pin toggle + delete. Shared by the pinned
   *  section and every recency group so behaviour stays identical. */
  const renderRow = (s: Session) => {
    const isPinned = pinned.has(s.session_id);
    return (
      <div
        key={s.session_id}
        className={`group no-drag flex items-center gap-2 w-full px-2.5 py-1.5 rounded-md text-xs transition-colors
          ${s.session_id === activeSessionId && activeView === 'chat'
            ? 'bg-artha-surface text-artha-text border border-artha-border-strong shadow-soft'
            : 'text-artha-muted hover:bg-artha-surface hover:text-artha-text border border-transparent'}`}
      >
        <button
          onClick={() => openSession(s.session_id)}
          className="flex items-center gap-2 flex-1 min-w-0 text-left"
        >
          <MessageSquare size={11} className="shrink-0" />
          <span className="truncate">{s.title}</span>
        </button>
        <button
          onClick={(e) => togglePin(e, s.session_id)}
          aria-label={isPinned ? 'Unpin chat' : 'Pin chat'}
          title={isPinned ? 'Unpin chat' : 'Pin chat'}
          className={`shrink-0 p-1 rounded transition-all ${
            isPinned
              ? 'text-artha-accent opacity-100'
              : 'text-artha-subtle opacity-0 group-hover:opacity-100 focus:opacity-100 hover:text-artha-text'
          }`}
        >
          <Pin size={11} className={isPinned ? 'fill-current' : ''} />
        </button>
        <button
          onClick={(e) => deleteChat(e, s.session_id)}
          aria-label="Delete chat"
          title="Delete chat"
          className="shrink-0 p-1 -mr-1 rounded opacity-0 group-hover:opacity-100 focus:opacity-100 text-artha-subtle hover:text-artha-danger hover:bg-artha-danger/20 transition-all"
        >
          <Trash2 size={11} />
        </button>
      </div>
    );
  };

  return (
    <aside className="flex flex-col w-60 bg-artha-surface2 border-r border-artha-border shrink-0">

      {/* ── Brand header ─────────────────────────────────────────────── */}
      {/* Mandala mark + wordmark. Lives in the macOS title-bar drag zone
          (top padding clears the traffic lights) so it doubles as a drag
          handle and gives the window a clear identity. */}
      <div className="drag-region flex items-center gap-2.5 px-4 pt-9 pb-3">
        <img
          src="./logo-mark.png"
          alt="Artha"
          width={30}
          height={30}
          draggable={false}
          className="rounded-lg shadow-soft ring-1 ring-artha-border-strong/50 select-none"
        />
        <BrandWordmark size={15} />
      </div>

      {/* ── Project switcher ─────────────────────────────────────────── */}
      <div className="px-3 pb-3 pt-1">
        <ProjectSwitcher />
      </div>

      {/* ── New chat ─────────────────────────────────────────────────── */}
      <div className="px-3 mb-3">
        <button
          onClick={newChat}
          className="no-drag flex items-center gap-2 w-full px-3 py-2 rounded-lg bg-artha-accent hover:bg-artha-accent-hover text-artha-on-accent text-sm font-medium transition-colors shadow-soft"
        >
          <Plus size={15} /> New Chat
        </button>
      </div>

      {/* ── Scrollable middle: Projects + Chats ──────────────────────── */}
      <div className="flex-1 overflow-y-auto px-3 space-y-4 pb-3">

        {/* Projects section ----------------------------------------------- */}
        <div>
          <button
            onClick={() => setProjectsOpen(o => !o)}
            className="w-full flex items-center gap-1 px-1.5 mb-1 text-[10px] uppercase tracking-wider text-artha-subtle font-semibold hover:text-artha-muted transition-colors"
          >
            {projectsOpen ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
            <span>Projects</span>
            <span className="ml-auto normal-case tracking-normal text-artha-subtle/70">{projects.length}</span>
          </button>
          {projectsOpen && (
            <div className="space-y-0.5">
              {projects.map(p => {
                const isActive = p.project_id === activeProjectId;
                // Clicking a project switches context AND lands the user on
                // that project's most recent chat (via selectProject) — same
                // behaviour as the ProjectSwitcher dropdown for consistency.
                const pickFromList = async () => {
                  const nextSessionId = selectProject(p.project_id);
                  if (nextSessionId) {
                    const msgs = await window.artha.sessions.getMessages(nextSessionId);
                    setMessages(msgs);
                  }
                };
                return (
                  // Flex container (not a button) so the delete control can sit
                  // beside the switch-project button without nesting buttons.
                  <div
                    key={p.project_id}
                    className={`group no-drag flex items-center gap-2 w-full px-2.5 py-1.5 rounded-md text-xs transition-colors
                      ${isActive
                        ? 'bg-artha-surface text-artha-text border border-artha-border-strong'
                        : 'text-artha-muted hover:bg-artha-surface hover:text-artha-text border border-transparent'}`}
                    title={p.root_path}
                  >
                    <button
                      onClick={pickFromList}
                      className="flex items-center gap-2 flex-1 min-w-0 text-left"
                    >
                      <Folder size={11} className="shrink-0 text-artha-accent" />
                      <span className="truncate">{p.name}</span>
                    </button>
                    <button
                      onClick={(e) => deleteProject(e, p.project_id)}
                      aria-label="Delete project"
                      title="Delete project (chats are kept, moved to General)"
                      className="shrink-0 p-1 -mr-1 rounded opacity-0 group-hover:opacity-100 focus:opacity-100 text-artha-subtle hover:text-artha-danger hover:bg-artha-danger/20 transition-all"
                    >
                      <Trash2 size={11} />
                    </button>
                  </div>
                );
              })}
              {projects.length === 0 && (
                <p className="px-2.5 py-1 text-[11px] text-artha-subtle">
                  No projects yet.
                </p>
              )}
            </div>
          )}
        </div>

        {/* Chats section -------------------------------------------------- */}
        <div>
          <button
            onClick={() => setChatsOpen(o => !o)}
            className="w-full flex items-center gap-1 px-1.5 mb-1 text-[10px] uppercase tracking-wider text-artha-subtle font-semibold hover:text-artha-muted transition-colors"
          >
            {chatsOpen ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
            <span>Chats</span>
            <span className="ml-auto normal-case tracking-normal text-artha-subtle/70">{visibleSessions.length}</span>
          </button>

          {chatsOpen && (
            <>
              {/* Search — filters chats in the current project by title. */}
              {visibleSessions.length > 0 && (
                <div className="relative mb-1.5 px-0.5">
                  <Search size={11} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-artha-subtle pointer-events-none" />
                  <input
                    value={query}
                    onChange={e => setQuery(e.target.value)}
                    placeholder="Search chats…"
                    className="w-full pl-7 pr-6 py-1.5 text-[11px] rounded-md border border-artha-border bg-artha-surface text-artha-text placeholder:text-artha-subtle focus:outline-none focus:border-artha-accent"
                  />
                  {query && (
                    <button
                      onClick={() => setQuery('')}
                      aria-label="Clear search"
                      className="absolute right-1.5 top-1/2 -translate-y-1/2 p-0.5 rounded text-artha-subtle hover:text-artha-text"
                    >
                      <X size={11} />
                    </button>
                  )}
                </div>
              )}

              <div className="space-y-0.5">
                {visibleSessions.length === 0 && (
                  <p className="px-2.5 py-1 text-[11px] text-artha-subtle">
                    No chats {activeProjectId ? 'in this project' : 'yet'}.
                  </p>
                )}
                {visibleSessions.length > 0 && matched.length === 0 && (
                  <p className="px-2.5 py-1 text-[11px] text-artha-subtle">No chats match “{query}”.</p>
                )}

                {/* Pinned section (always on top, shown in search results too). */}
                {pinnedSessions.length > 0 && (
                  <ChatGroup label="Pinned">
                    {pinnedSessions.map(renderRow)}
                  </ChatGroup>
                )}

                {/* When searching: one flat list of the rest. Otherwise: grouped
                    by recency (Today / Yesterday / …). */}
                {q
                  ? unpinned.map(renderRow)
                  : BUCKET_ORDER.filter(b => buckets[b]?.length).map(b => (
                      <ChatGroup key={b} label={b}>
                        {buckets[b].map(renderRow)}
                      </ChatGroup>
                    ))}
              </div>
            </>
          )}
        </div>
      </div>

      {/* ── Workspace Settings + theme toggle ────────────────────────── */}
      <nav className="border-t border-artha-border p-3 flex items-center gap-2">
        <Tooltip content="Workspace Settings · ⌘," side="right" sideOffset={10}>
          <button
            onClick={() => openWorkspaceSettings(null)}
            className="no-drag flex items-center gap-2 flex-1 px-3 py-2 rounded-lg text-sm text-artha-muted hover:bg-artha-surface hover:text-artha-text transition-colors"
          >
            <SettingsIcon size={14} /> Workspace Settings
          </button>
        </Tooltip>
        <ThemeToggle />
      </nav>
    </aside>
  );
}

/** A labelled group of chat rows (Pinned / Today / Yesterday / …). */
function ChatGroup({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="pt-1">
      <div className="px-2.5 pb-0.5 text-[9px] uppercase tracking-wider text-artha-subtle/80 font-semibold">
        {label}
      </div>
      <div className="space-y-0.5">{children}</div>
    </div>
  );
}
