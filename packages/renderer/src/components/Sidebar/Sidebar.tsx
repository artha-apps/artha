import { MessageSquare, Plus, Settings, Cpu, FolderSearch, Wrench, Globe, Route, History, ShieldCheck, Package, Sparkles, Archive, Store } from 'lucide-react';
import { useChatStore, ActiveView } from '../../stores/chat';

export default function Sidebar() {
  const { sessions, activeSessionId, setActiveSession, setMessages, setSessions, activeView, setActiveView } = useChatStore();

  const newChat = async () => {
    const session = await window.artha.sessions.create();
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

  const navItems: { icon: React.ElementType; label: string; view: ActiveView }[] = [
    { icon: Cpu,          label: 'Models',    view: 'models'   },
    { icon: Sparkles,     label: 'Skills',    view: 'skills'   },
    { icon: Wrench,       label: 'MCP Tools', view: 'mcp'      },
    { icon: Globe,        label: 'Web',       view: 'web'      },
    { icon: FolderSearch, label: 'RAG Index', view: 'rag'      },
    { icon: Route,        label: 'Router',    view: 'router'   },
    { icon: Archive,      label: 'Artifacts',  view: 'artifacts'   },
    { icon: Store,        label: 'Marketplace', view: 'marketplace' },
    { icon: History,      label: 'Time Travel', view: 'timetravel' },
    { icon: ShieldCheck,  label: 'Provenance', view: 'provenance' },
    { icon: Package,      label: 'Bundles',    view: 'bundles'    },
    { icon: Settings,     label: 'Settings',  view: 'settings' },
  ];

  return (
    <aside className="flex flex-col w-56 bg-artha-s2 border-r border-artha-border pt-10 shrink-0">
      {/* New chat */}
      <div className="px-3 mb-3">
        <button onClick={newChat}
          className="no-drag flex items-center gap-2 w-full px-3 py-2 rounded-lg bg-artha-accent/20 hover:bg-artha-accent/30 text-sm font-medium transition-colors">
          <Plus size={15} /> New Chat
        </button>
      </div>

      {/* Sessions list */}
      <div className="flex-1 overflow-y-auto px-3 space-y-1">
        {sessions.map(s => (
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
