/**
 * ProjectHome — the Chat tab's empty state when an active project is selected
 * but no session is open. The project's CONTEXT HUB: everything Artha carries
 * across this project's chats, in one editable place —
 *   - rolling cross-session memory (`projects.summary`, inline-editable)
 *   - pinned memories (memory_entities.project_id — pin/unpin here)
 *   - default skill (projects.default_skill_id — auto-activates in chats)
 *   - RAG index status + rebuild, folder path, recent chats.
 *
 * Renders nothing if no project is active — ChatWindow's normal empty state
 * covers the no-project case.
 */
import { useEffect, useState } from 'react';
import {
  Folder, FolderOpen, Plus, MessageSquare, Brain, ArrowRight, Database,
  Pencil, Check, X, Pin, PinOff, Sparkles, RefreshCw,
} from 'lucide-react';
import { useChatStore, type Session } from '../../stores/chat';
import { createChat } from '../../lib/newChat';
import { toast } from '../../stores/toast';

function fmtRelative(ts: number): string {
  const now = Date.now() / 1000;
  const delta = Math.max(0, now - ts);
  if (delta < 60) return 'just now';
  if (delta < 3600) return `${Math.floor(delta / 60)}m ago`;
  if (delta < 86400) return `${Math.floor(delta / 3600)}h ago`;
  return `${Math.floor(delta / 86400)}d ago`;
}

/** Row shape from memory.list — only the fields this view touches. */
interface MemoryRow {
  entity_id: string;
  name: string;
  content: string;
  project_id: string | null;
}

/** Row shape from skills.listEnabled — only the fields this view touches. */
interface SkillRow {
  skill_id: string;
  name: string;
  icon: string;
}

export default function ProjectHome() {
  const {
    projects, activeProjectId, setActiveSession, setMessages, sessions,
    setActiveTab, setProjects,
  } = useChatStore();

  const project = projects.find(p => p.project_id === activeProjectId) ?? null;

  // RAG index status — name + chunk count surface "is it ready / how much do I
  // know?" without opening the RAG settings panel.
  const [indexName, setIndexName] = useState<string | null>(null);
  const [chunkCount, setChunkCount] = useState<number | null>(null);
  const [rebuilding, setRebuilding] = useState(false);

  // Inline summary edit (Project memory card).
  const [editingSummary, setEditingSummary] = useState(false);
  const [summaryDraft, setSummaryDraft] = useState('');

  // Pinned-memories card: memories scoped to this project + globals to pin.
  const [memories, setMemories] = useState<MemoryRow[]>([]);
  const [showPinnable, setShowPinnable] = useState(false);

  // Default-skill dropdown.
  const [skills, setSkills] = useState<SkillRow[]>([]);

  useEffect(() => {
    if (!project?.rag_index_id) { setChunkCount(null); setIndexName(null); return; }
    window.artha.rag.listIndexes().then(rows => {
      const row = (rows as Array<{ index_id: string; name: string; doc_count: number }>)
        .find(r => r.index_id === project.rag_index_id);
      setChunkCount(row?.doc_count ?? 0);
      setIndexName(row?.name ?? null);
    }).catch(() => { setChunkCount(null); setIndexName(null); });
  }, [project?.rag_index_id]);

  const projectId = project?.project_id ?? null;
  useEffect(() => {
    if (!projectId) return;
    window.artha.memory.list().then(rows => setMemories(rows as MemoryRow[])).catch(() => setMemories([]));
    window.artha.skills.listEnabled().then(rows => setSkills(rows as SkillRow[])).catch(() => setSkills([]));
  }, [projectId]);

  if (!project) return null;

  // Chats in this project — sourced from the cached sessions list so the home
  // page stays in sync as new chats arrive.
  const projectChats = sessions.filter(s => s.project_id === project.project_id);
  const recentChats = projectChats.slice(0, 8);

  const pinned = memories.filter(m => m.project_id === project.project_id);
  const pinnable = memories.filter(m => m.project_id === null);

  const openChat = async (s: Session) => {
    setActiveSession(s.session_id);
    const msgs = await window.artha.sessions.getMessages(s.session_id);
    setMessages(msgs);
    setActiveTab('chat');
  };

  // Shared helper — attaches the project root scope (see lib/newChat.ts).
  const newChatHere = () => createChat(project.project_id);

  const refreshProjects = async () => {
    const fresh = await window.artha.projects.list();
    setProjects(fresh);
  };

  const saveSummary = async () => {
    await window.artha.projects.updateSummary(project.project_id, summaryDraft);
    setEditingSummary(false);
    await refreshProjects();
    toast.success('Project memory updated');
  };

  const setPin = async (m: MemoryRow, pin: boolean) => {
    await window.artha.memory.setProject(m.entity_id, pin ? project.project_id : null);
    setMemories(prev => prev.map(r =>
      r.entity_id === m.entity_id ? { ...r, project_id: pin ? project.project_id : null } : r,
    ));
  };

  const setDefaultSkill = async (skillId: string | null) => {
    await window.artha.projects.setDefaultSkill(project.project_id, skillId);
    await refreshProjects();
    toast.success(skillId ? 'Default skill set for this project' : 'Default skill cleared');
  };

  const rebuildIndex = async () => {
    if (!project.rag_index_id || rebuilding) return;
    setRebuilding(true);
    try {
      await window.artha.rag.rebuildIndex(project.rag_index_id);
      const rows = await window.artha.rag.listIndexes();
      const row = (rows as Array<{ index_id: string; doc_count: number }>)
        .find(r => r.index_id === project.rag_index_id);
      setChunkCount(row?.doc_count ?? 0);
      toast.success('Knowledge index rebuilt');
    } catch {
      toast.error('Index rebuild failed');
    } finally {
      setRebuilding(false);
    }
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
                  {indexName && <span className="text-[10px] text-artha-subtle font-mono truncate max-w-[10rem]">{indexName}</span>}
                </div>
                <div className="flex items-center gap-2">
                  {chunkCount !== null && chunkCount > 0 && (
                    <span className="text-[10px] font-semibold text-gradient-emerald">{chunkCount.toLocaleString()} chunks</span>
                  )}
                  {project.rag_index_id && (
                    <button
                      onClick={rebuildIndex}
                      disabled={rebuilding}
                      title="Re-scan the folder and rebuild the index"
                      className="inline-flex items-center gap-1 text-[10px] text-artha-muted hover:text-artha-accent transition-colors disabled:opacity-50"
                    >
                      <RefreshCw size={10} className={rebuilding ? 'animate-spin' : ''} />
                      {rebuilding ? 'Rebuilding…' : 'Rebuild'}
                    </button>
                  )}
                </div>
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

          {/* Right col — context hub (1/3 width) ----------------------------- */}
          <div className="md:col-span-1 space-y-6">

            {/* Rolling memory — inline editable */}
            <div className="card-artha bg-artha-surface2/50 p-4">
              <div className="flex items-center gap-2 mb-2">
                <Brain size={14} className="text-artha-accent" />
                <h2 className="text-sm font-semibold text-artha-text flex-1">Project memory</h2>
                {!editingSummary && (
                  <button
                    onClick={() => { setSummaryDraft(project.summary ?? ''); setEditingSummary(true); }}
                    title="Edit project memory"
                    className="text-artha-subtle hover:text-artha-accent transition-colors"
                  >
                    <Pencil size={12} />
                  </button>
                )}
              </div>
              {editingSummary ? (
                <div>
                  <textarea
                    value={summaryDraft}
                    onChange={e => setSummaryDraft(e.target.value)}
                    maxLength={4000}
                    rows={8}
                    autoFocus
                    className="w-full text-xs bg-artha-surface border border-artha-border rounded-lg p-2 text-artha-text leading-relaxed resize-y focus:outline-none focus:border-artha-accent"
                    placeholder="Durable facts, decisions, and preferences for this project…"
                  />
                  <div className="flex items-center justify-between mt-1.5">
                    <span className="text-[10px] text-artha-subtle">{summaryDraft.length}/4000 · Artha keeps merging new sessions into this</span>
                    <div className="flex gap-1">
                      <button onClick={saveSummary} title="Save" className="p-1 rounded text-artha-accent hover:bg-artha-surface transition-colors"><Check size={13} /></button>
                      <button onClick={() => setEditingSummary(false)} title="Cancel" className="p-1 rounded text-artha-muted hover:bg-artha-surface transition-colors"><X size={13} /></button>
                    </div>
                  </div>
                </div>
              ) : project.summary ? (
                <div className="text-xs text-artha-text leading-relaxed whitespace-pre-wrap">
                  {project.summary}
                </div>
              ) : (
                <p className="text-xs text-artha-muted leading-relaxed">
                  Artha will write a short, rolling summary of this project here as you chat.
                  It carries durable facts, decisions, and your preferences across sessions —
                  so a new chat already knows what happened last time. Click the pencil to seed it yourself.
                </p>
              )}
            </div>

            {/* Default skill */}
            <div className="card-artha p-4">
              <div className="flex items-center gap-2 mb-2">
                <Sparkles size={14} className="text-artha-accent" />
                <h2 className="text-sm font-semibold text-artha-text">Default skill</h2>
              </div>
              <select
                value={project.default_skill_id ?? ''}
                onChange={e => setDefaultSkill(e.target.value || null)}
                className="w-full text-xs bg-artha-surface border border-artha-border rounded-lg px-2 py-1.5 text-artha-text focus:outline-none focus:border-artha-accent"
              >
                <option value="">None — match automatically</option>
                {skills.map(s => (
                  <option key={s.skill_id} value={s.skill_id}>{s.icon} {s.name}</option>
                ))}
              </select>
              <p className="text-[10px] text-artha-subtle mt-1.5 leading-relaxed">
                Auto-activates in this project&apos;s chats when you don&apos;t invoke a /skill yourself.
              </p>
            </div>

            {/* Pinned memories */}
            <div className="card-artha p-4">
              <div className="flex items-center gap-2 mb-2">
                <Pin size={14} className="text-artha-accent" />
                <h2 className="text-sm font-semibold text-artha-text flex-1">Pinned memories</h2>
                <span className="text-[10px] text-artha-subtle">{pinned.length}</span>
              </div>
              {pinned.length === 0 ? (
                <p className="text-xs text-artha-muted leading-relaxed mb-2">
                  Pin a remembered fact to keep it scoped to this project&apos;s chats.
                </p>
              ) : (
                <ul className="space-y-1.5 mb-2">
                  {pinned.map(m => (
                    <li key={m.entity_id} className="flex items-start gap-1.5 group">
                      <span className="text-xs text-artha-text leading-snug flex-1 min-w-0 truncate" title={m.content}>{m.name}</span>
                      <button
                        onClick={() => setPin(m, false)}
                        title="Unpin — memory returns to the global pool"
                        className="opacity-0 group-hover:opacity-100 text-artha-subtle hover:text-artha-accent transition-all shrink-0"
                      >
                        <PinOff size={11} />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              {pinnable.length > 0 && (
                <div>
                  <button
                    onClick={() => setShowPinnable(v => !v)}
                    className="text-[10px] text-artha-accent hover:underline"
                  >
                    {showPinnable ? 'Hide global memories' : `Pin from global (${pinnable.length})…`}
                  </button>
                  {showPinnable && (
                    <ul className="space-y-1.5 mt-2 max-h-40 overflow-y-auto pr-1">
                      {pinnable.map(m => (
                        <li key={m.entity_id} className="flex items-start gap-1.5 group">
                          <span className="text-xs text-artha-muted leading-snug flex-1 min-w-0 truncate" title={m.content}>{m.name}</span>
                          <button
                            onClick={() => setPin(m, true)}
                            title="Pin to this project — MOVES the memory: it will only be recalled inside this project's chats"
                            className="opacity-0 group-hover:opacity-100 text-artha-subtle hover:text-artha-accent transition-all shrink-0"
                          >
                            <Pin size={11} />
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
