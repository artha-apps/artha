/**
 * ProjectHome — the Chat tab's empty state when an active project is selected
 * but no session is open. Surfaces the things Artha already tracks per project
 * but had no UI for: the rolling cross-session memory (`projects.summary`),
 * the RAG index status, the folder path, and recent chats inside this project.
 *
 * Phase 2A of the IA reshuffle. Renders nothing if no project is active —
 * ChatWindow's normal empty state covers the no-project case.
 */
import { useEffect, useState } from 'react';
import { Folder, FolderOpen, Plus, MessageSquare, Brain, ArrowRight, Database } from 'lucide-react';
import { useChatStore, type Session } from '../../stores/chat';

/** Shape returned by sessions:list — extended with a snippet for preview. */
function fmtRelative(ts: number): string {
  const now = Date.now() / 1000;
  const delta = Math.max(0, now - ts);
  if (delta < 60) return 'just now';
  if (delta < 3600) return `${Math.floor(delta / 60)}m ago`;
  if (delta < 86400) return `${Math.floor(delta / 3600)}h ago`;
  return `${Math.floor(delta / 86400)}d ago`;
}

export default function ProjectHome() {
  const {
    projects, activeProjectId, setActiveSession, setMessages, sessions, setSessions,
    setActiveTab,
  } = useChatStore();

  const project = projects.find(p => p.project_id === activeProjectId) ?? null;

  // RAG index status — chunk count surfaces "is it ready / how much do I know?"
  // without the user having to open the RAG settings panel.
  const [chunkCount, setChunkCount] = useState<number | null>(null);

  useEffect(() => {
    if (!project?.rag_index_id) { setChunkCount(null); return; }
    window.artha.rag.listIndexes().then(rows => {
      const row = (rows as Array<{ index_id: string; doc_count: number }>).find(r => r.index_id === project.rag_index_id);
      setChunkCount(row?.doc_count ?? 0);
    }).catch(() => setChunkCount(null));
  }, [project?.rag_index_id]);

  if (!project) return null;

  // Chats in this project — sourced from the cached sessions list so the home
  // page stays in sync as new chats arrive.
  const projectChats = sessions.filter(s => s.project_id === project.project_id);
  const recentChats = projectChats.slice(0, 8);

  const openChat = async (s: Session) => {
    setActiveSession(s.session_id);
    const msgs = await window.artha.sessions.getMessages(s.session_id);
    setMessages(msgs);
    setActiveTab('chat');
  };

  const newChatHere = async () => {
    const session = await window.artha.sessions.create(project.project_id);
    // Same auto-attach as Sidebar.newChat — keep the project root in scope.
    await window.artha.scopes.addFolderPath(session.session_id, project.root_path).catch(() => { /* non-fatal */ });
    const updated = await window.artha.sessions.list();
    setSessions(updated);
    setActiveSession(session.session_id);
    setMessages([]);
    setActiveTab('chat');
  };

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-4xl mx-auto px-8 py-10 animate-fade-up">

        {/* ── Header ───────────────────────────────────────────────────── */}
        <div className="flex items-start gap-4 mb-8">
          <div className="w-12 h-12 rounded-xl bg-artha-accent/10 border border-artha-accent/30 flex items-center justify-center shrink-0 shadow-glow-sm">
            <Folder size={20} className="text-artha-accent" />
          </div>
          <div className="flex-1 min-w-0">
            <h1 className="text-xl font-semibold text-gradient-emerald mb-1 truncate">{project.name}</h1>
            <button
              onClick={() => window.artha.system.revealInFolder(project.root_path)}
              className="group inline-flex items-center gap-1.5 text-xs text-artha-muted hover:text-artha-accent transition-colors font-mono truncate max-w-full"
              title="Reveal in Finder"
            >
              <FolderOpen size={11} className="shrink-0" />
              <span className="truncate">{project.root_path}</span>
            </button>
          </div>
          <button onClick={newChatHere} className="btn-primary shrink-0 px-3 py-2 text-xs">
            <Plus size={13} /> New chat
          </button>
        </div>

        {/* ── Two columns ──────────────────────────────────────────────── */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">

          {/* Left col — meta + chats (2/3 width) ----------------------------- */}
          <div className="md:col-span-2 space-y-6">

            {/* RAG status card */}
            <div className="card-artha-interactive p-4">
              <div className="flex items-center justify-between mb-1">
                <div className="flex items-center gap-2">
                  <Database size={14} className="text-artha-accent" />
                  <h2 className="text-sm font-semibold text-artha-text">Knowledge index</h2>
                </div>
                {chunkCount !== null && chunkCount > 0 && (
                  <span className="text-[10px] font-semibold text-gradient-emerald">{chunkCount.toLocaleString()} chunks</span>
                )}
              </div>
              <p className="text-xs text-artha-muted leading-relaxed">
                {chunkCount === null
                  ? 'No index for this folder yet.'
                  : chunkCount === 0
                    ? 'Building index in the background — Artha will start matching against this folder once it finishes.'
                    : 'Artha can semantically search this folder. Ask "find X" or use @-references to files inside.'}
              </p>
            </div>

            {/* Recent chats card */}
            <div className="card-artha overflow-hidden">
              <div className="px-4 pt-4 pb-2 flex items-center gap-2 border-b border-artha-border">
                <MessageSquare size={14} className="text-artha-accent" />
                <h2 className="text-sm font-semibold text-artha-text flex-1">Recent chats</h2>
                <span className="text-[10px] text-artha-subtle">{projectChats.length}</span>
              </div>
              {recentChats.length === 0 ? (
                <div className="px-4 py-6 text-center">
                  <p className="text-xs text-artha-muted mb-3">No chats in this project yet.</p>
                  <button
                    onClick={newChatHere}
                    className="inline-flex items-center gap-1.5 text-xs text-artha-accent hover:underline"
                  >
                    Start the first one <ArrowRight size={11} />
                  </button>
                </div>
              ) : (
                <ul className="divide-y divide-artha-border">
                  {recentChats.map(s => (
                    <li key={s.session_id}>
                      <button
                        onClick={() => openChat(s)}
                        className="w-full text-left px-4 py-2.5 hover:bg-artha-surface2 transition-colors group"
                      >
                        <div className="flex items-center gap-3">
                          <MessageSquare size={11} className="text-artha-subtle group-hover:text-artha-accent transition-colors shrink-0" />
                          <span className="text-xs text-artha-text flex-1 truncate">{s.title}</span>
                          <span className="text-[10px] text-artha-subtle shrink-0">{fmtRelative(s.last_activity)}</span>
                        </div>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>

          {/* Right col — rolling memory (1/3 width) ------------------------- */}
          <div className="md:col-span-1">
            <div className="card-artha bg-artha-surface2/50 p-4 h-full">
              <div className="flex items-center gap-2 mb-2">
                <Brain size={14} className="text-artha-accent" />
                <h2 className="text-sm font-semibold text-artha-text">Project memory</h2>
              </div>
              {project.summary ? (
                <div className="text-xs text-artha-text leading-relaxed whitespace-pre-wrap">
                  {project.summary}
                </div>
              ) : (
                <p className="text-xs text-artha-muted leading-relaxed">
                  Artha will write a short, rolling summary of this project here as you chat.
                  It carries durable facts, decisions, and your preferences across sessions —
                  so a new chat already knows what happened last time.
                </p>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
