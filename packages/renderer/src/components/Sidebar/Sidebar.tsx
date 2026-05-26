import { useEffect, useRef, useState } from 'react';
import { MessageSquare, Plus, Settings, Cpu, FolderSearch, Wrench, Globe, Route, History, ShieldCheck, Package, Sparkles, Archive, Store, Brain, Code2, Link, Wifi, Monitor, Folder, FolderPlus, ChevronDown, Check, Trash2, RefreshCw } from 'lucide-react';
import { useChatStore, ActiveView } from '../../stores/chat';

export default function Sidebar() {
  const {
    sessions, activeSessionId, setActiveSession, setMessages, setSessions,
    activeView, setActiveView, projects, activeProjectId, setProjects, setActiveProjectId,
  } = useChatStore();
  const [projectMenuOpen, setProjectMenuOpen] = useState(false);
  const [reindexingId, setReindexingId] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  // Load projects once.
  useEffect(() => {
    window.artha.projects.list().then(setProjects).catch(() => {});
  }, [setProjects]);

  // Close the project dropdown on outside click.
  useEffect(() => {
    if (!projectMenuOpen) return;
    const onClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setProjectMenuOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [projectMenuOpen]);

  const activeProject = projects.find(p => p.project_id === activeProjectId) ?? null;

  // Sessions shown depend on the active project: a project shows its own
  // sessions; "No Project" shows general (unscoped) sessions.
  const visibleSessions = sessions.filter(s =>
    activeProjectId ? s.project_id === activeProjectId : !s.project_id
  );

  const newChat = async () => {
    const session = await window.artha.sessions.create(activeProjectId);
    const updated = await window.artha.sessions.list();
    setSessions(updated);
    setActiveSession(session.session_id);
    setMessages([]);
    setActiveView('chat');
  };

  const openSession = async (id: string) => {
    setActiveView('chat');
    setActiveSession(id);
    const msgs = await window.artha.sessions.getMessages(id);
    setMessages(msgs);
  };

  const pickProject = (id: string | null) => {
    setActiveProjectId(id);
    setProjectMenuOpen(false);
  };

  const newProject = async () => {
    const proj = await window.artha.projects.create();
    if (!proj) return;
    const updated = await window.artha.projects.list();
    setProjects(updated);
    setActiveProjectId(proj.project_id);
    setProjectMenuOpen(false);
  };

  const reindexProject = async (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    setReindexingId(id);
    try {
      await window.artha.projects.reindex(id);
    } finally {
      setReindexingId(null);
    }
  };

  const deleteProject = async (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    await window.artha.projects.delete(id);
    const [updatedProjects, updatedSessions] = await Promise.all([
      window.artha.projects.list(),
      window.artha.sessions.list(),
    ]);
    setProjects(updatedProjects);
    setSessions(updatedSessions);
    if (activeProjectId === id) setActiveProjectId(null);
  };

  const navItems: { icon: React.ElementType; label: string; view: ActiveView }[] = [
    { icon: Cpu,          label: 'Models',    view: 'models'   },
    { icon: Sparkles,     label: 'Skills',    view: 'skills'   },
    { icon: Wrench,       label: 'MCP Tools', view: 'mcp'      },
    { icon: Globe,        label: 'Web',       view: 'web'      },
    { icon: FolderSearch, label: 'RAG Index', view: 'rag'      },
    { icon: Route,        label: 'Router',    view: 'router'   },
    { icon: Archive,      label: 'Artifacts',  view: 'artifacts'   },
    { icon: Brain,        label: 'Memory',     view: 'memory'      },
    { icon: Code2,        label: 'IDE',        view: 'ide'         },
    { icon: Link,         label: 'Cloud',      view: 'cloud'       },
    { icon: Wifi,         label: 'LAN Server', view: 'lan'         },
    { icon: Monitor,      label: 'Desktop',    view: 'desktop'     },
    { icon: Store,        label: 'Marketplace', view: 'marketplace' },
    { icon: History,      label: 'Time Travel', view: 'timetravel' },
    { icon: ShieldCheck,  label: 'Provenance', view: 'provenance' },
    { icon: Package,      label: 'Bundles',    view: 'bundles'    },
    { icon: Settings,     label: 'Settings',  view: 'settings' },
  ];

  return (
    <aside className="flex flex-col w-56 bg-artha-s2 border-r border-artha-border pt-10 shrink-0">
      {/* Project switcher */}
      <div className="px-3 mb-2 relative" ref={menuRef}>
        <button
          onClick={() => setProjectMenuOpen(o => !o)}
          title={activeProject ? activeProject.root_path : 'No project — general chats'}
          className="no-drag flex items-center gap-2 w-full px-3 py-2 rounded-lg border border-artha-border text-sm text-left hover:bg-white/5 transition-colors"
        >
          <Folder size={14} className="shrink-0 text-artha-accent" />
          <span className="truncate flex-1 text-white">{activeProject ? activeProject.name : 'No Project'}</span>
          <ChevronDown size={13} className="shrink-0 text-artha-muted" />
        </button>

        {projectMenuOpen && (
          <div className="absolute left-3 right-3 top-full mt-1 z-30 bg-artha-surface border border-artha-border rounded-lg shadow-xl overflow-hidden py-1">
            <button
              onClick={() => pickProject(null)}
              className="w-full flex items-center gap-2 px-3 py-2 text-sm text-left hover:bg-white/5 transition-colors"
            >
              <span className="w-4 shrink-0">{!activeProjectId && <Check size={13} className="text-artha-accent" />}</span>
              <span className="truncate text-artha-muted">No Project</span>
            </button>
            {projects.map(p => (
              <button
                key={p.project_id}
                onClick={() => pickProject(p.project_id)}
                title={p.root_path}
                className="group w-full flex items-center gap-2 px-3 py-2 text-sm text-left hover:bg-white/5 transition-colors"
              >
                <span className="w-4 shrink-0">{activeProjectId === p.project_id && <Check size={13} className="text-artha-accent" />}</span>
                <span className="truncate flex-1 text-white">{p.name}</span>
                <span
                  onClick={(e) => reindexProject(e, p.project_id)}
                  className={`text-artha-muted hover:text-artha-accent transition-colors ${reindexingId === p.project_id ? '' : 'opacity-0 group-hover:opacity-100'}`}
                  title="Re-index project files"
                >
                  <RefreshCw size={12} className={reindexingId === p.project_id ? 'animate-spin' : ''} />
                </span>
                <span
                  onClick={(e) => deleteProject(e, p.project_id)}
                  className="opacity-0 group-hover:opacity-100 text-artha-muted hover:text-red-400 transition-colors"
                  title="Remove project (keeps chats)"
                >
                  <Trash2 size={12} />
                </span>
              </button>
            ))}
            <div className="my-1 border-t border-artha-border" />
            <button
              onClick={newProject}
              className="w-full flex items-center gap-2 px-3 py-2 text-sm text-left text-artha-accent hover:bg-white/5 transition-colors"
            >
              <FolderPlus size={13} className="shrink-0" />
              New Project…
            </button>
          </div>
        )}
      </div>

      {/* New chat */}
      <div className="px-3 mb-3">
        <button onClick={newChat}
          className="no-drag flex items-center gap-2 w-full px-3 py-2 rounded-lg bg-artha-accent/20 hover:bg-artha-accent/30 text-sm font-medium transition-colors">
          <Plus size={15} /> New Chat
        </button>
      </div>

      {/* Sessions list */}
      <div className="flex-1 overflow-y-auto px-3 space-y-1">
        {visibleSessions.length === 0 && (
          <p className="px-3 py-2 text-xs text-artha-muted/60">
            No chats {activeProject ? `in ${activeProject.name}` : 'yet'}.
          </p>
        )}
        {visibleSessions.map(s => (
          <button key={s.session_id} onClick={() => openSession(s.session_id)}
            className={`no-drag flex items-center gap-2 w-full px-3 py-2 rounded-lg text-sm text-left transition-colors truncate
              ${s.session_id === activeSessionId && activeView === 'chat'
                ? 'bg-artha-accent/25 text-white'
                : 'text-artha-muted hover:bg-white/5 hover:text-white'}`}>
            <MessageSquare size={13} className="shrink-0" />
            <span className="truncate">{s.title}</span>
          </button>
        ))}
      </div>

      {/* Bottom nav */}
      <nav className="border-t border-artha-border p-3 space-y-1">
        {navItems.map(({ icon: Icon, label, view }) => (
          <button key={label}
            onClick={() => setActiveView(view)}
            className={`no-drag flex items-center gap-2 w-full px-3 py-2 rounded-lg text-sm transition-colors
              ${activeView === view
                ? 'bg-artha-accent/20 text-white'
                : 'text-artha-muted hover:bg-white/5 hover:text-white'}`}>
            <Icon size={14} /> {label}
          </button>
        ))}
      </nav>
    </aside>
  );
}
