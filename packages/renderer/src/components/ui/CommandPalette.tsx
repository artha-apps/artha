/**
 * CommandPalette — a global launcher (⌘K / Ctrl+K). The app's features were
 * spread across 25 settings panels, 4 tabs, and the sidebar with no single
 * entry point; this unifies navigation and quick actions into one fuzzy list:
 * jump to a chat/project, switch model, open any settings panel, switch tab,
 * new chat, toggle theme.
 *
 * Self-contained: owns its own ⌘K listener and reads everything it needs from
 * the existing stores + IPC, so it doesn't depend on the in-flight Workflows /
 * Run-Inspector work happening elsewhere.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Search, MessageSquarePlus, SunMoon, Cpu, FolderOpen, MessagesSquare,
  Settings as SettingsIcon, ArrowRight, LayoutGrid, Undo2, Brain, FileText,
} from 'lucide-react';
import { useChatStore, type ActiveView, type ActiveTab } from '../../stores/chat';
import { useThemeStore } from '../../stores/theme';
import { toast } from '../../stores/toast';

interface Command {
  id: string;
  label: string;
  hint?: string;
  /** Optional secondary line (e.g. a search snippet). */
  sub?: string;
  group: string;
  icon: typeof Search;
  keywords?: string;
  run: () => void | Promise<void>;
}

type SearchHit = { type: 'chat' | 'memory' | 'artifact'; id: string; title: string; snippet: string; ts: number; filePath?: string };

/** Friendly labels for the settings panels reachable from the palette. */
const PANELS: { view: Exclude<ActiveView, 'chat'>; label: string }[] = [
  { view: 'models', label: 'Models' }, { view: 'skills', label: 'Skills' },
  { view: 'mcp', label: 'MCP Tools' }, { view: 'policies', label: 'Tool Policies' },
  { view: 'web', label: 'Web' }, { view: 'router', label: 'Router' },
  { view: 'memory', label: 'Memory' }, { view: 'crm', label: 'CRM' },
  { view: 'rag', label: 'RAG Index' }, { view: 'bundles', label: 'Bundles' },
  { view: 'artifacts', label: 'Artifacts' }, { view: 'cloud', label: 'Cloud Integrations' },
  { view: 'lan', label: 'LAN Server' }, { view: 'ide', label: 'IDE Integration' },
  { view: 'desktop', label: 'Desktop Control' }, { view: 'marketplace', label: 'Marketplace' },
  { view: 'team', label: 'Team' }, { view: 'license', label: 'License' },
  { view: 'scheduler', label: 'Scheduled Tasks' }, { view: 'timetravel', label: 'Time Travel' },
  { view: 'receipts', label: 'Receipts' }, { view: 'provenance', label: 'Provenance' },
  { view: 'settings', label: 'General Settings' }, { view: 'about', label: 'About' },
];

const TABS: { tab: ActiveTab; label: string }[] = [
  { tab: 'chat', label: 'Chat' }, { tab: 'workflows', label: 'Workflows' },
  { tab: 'code', label: 'Code' }, { tab: 'delegate', label: 'Delegate' },
];

export default function CommandPalette() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [sel, setSel] = useState(0);
  const [models, setModels] = useState<{ name: string }[]>([]);
  const [undoables, setUndoables] = useState<{ id: string; label: string }[]>([]);
  const [results, setResults] = useState<SearchHit[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const store = useChatStore();
  const toggleTheme = useThemeStore((s) => s.toggleTheme);

  // ⌘K / Ctrl+K toggles. Esc closes (handled here so it works even when the
  // input isn't focused).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault();
        setOpen((v) => !v);
      } else if (e.key === 'Escape' && open) {
        setOpen(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  // On open: reset query/selection, focus the input, lazy-load models.
  useEffect(() => {
    if (!open) return;
    setQuery('');
    setSel(0);
    requestAnimationFrame(() => inputRef.current?.focus());
    window.artha.llm.listModels()
      .then((m) => setModels((m as { name: string }[]) ?? []))
      .catch(() => setModels([]));
    window.artha.undo.list()
      .then((u) => setUndoables(u.map((x) => ({ id: x.id, label: x.label }))))
      .catch(() => setUndoables([]));
  }, [open]);

  // Debounced global content search across chats / memory / artifacts. Uses the
  // fast keyword path (semantic off) so typeahead stays snappy.
  useEffect(() => {
    if (!open) return;
    const q = query.trim();
    if (q.length < 2) { setResults([]); return; }
    const handle = window.setTimeout(() => {
      window.artha.search.global(q).then(setResults).catch(() => setResults([]));
    }, 160);
    return () => window.clearTimeout(handle);
  }, [query, open]);

  const openSession = async (id: string) => {
    // Force the Chat tab — otherwise jumping to a chat from Workflows/Code/
    // Delegate switches the session but leaves you on the wrong surface.
    store.setActiveTab('chat');
    store.setActiveSession(id);
    try { store.setMessages(await window.artha.sessions.getMessages(id)); } catch { /* fresh */ }
  };

  const commands: Command[] = useMemo(() => {
    const cmds: Command[] = [];
    // Quick actions
    cmds.push({
      id: 'new-chat', group: 'Actions', label: 'New chat', icon: MessageSquarePlus,
      run: async () => {
        const s = await window.artha.sessions.create(store.activeProjectId ?? null);
        store.setSessions(await window.artha.sessions.list());
        store.setActiveTab('chat');
        store.setActiveSession(s.session_id);
        store.setMessages([]);
      },
    });
    cmds.push({ id: 'toggle-theme', group: 'Actions', label: 'Toggle light / dark theme', icon: SunMoon, run: () => toggleTheme() });
    // Undo recent agent file actions (move/copy/create-folder/trash).
    for (const u of undoables) {
      cmds.push({
        id: `undo-${u.id}`, group: 'Undo recent file action', label: u.label, hint: 'undo', icon: Undo2, keywords: 'undo revert',
        run: async () => {
          const r = await window.artha.undo.revert(u.id);
          if (r.ok) toast.success('Undone', r.label);
          else toast.error('Couldn’t undo', r.error);
        },
      });
    }
    // Tabs
    for (const t of TABS) {
      cmds.push({ id: `tab-${t.tab}`, group: 'Go to', label: `${t.label} tab`, icon: LayoutGrid, keywords: 'tab room switch', run: () => store.setActiveTab(t.tab) });
    }
    // Settings panels
    for (const p of PANELS) {
      cmds.push({ id: `panel-${p.view}`, group: 'Settings', label: p.label, icon: SettingsIcon, keywords: 'settings open ' + p.view, run: () => store.openWorkspaceSettings(p.view) });
    }
    // Models
    for (const m of models) {
      cmds.push({ id: `model-${m.name}`, group: 'Switch model', label: m.name, icon: Cpu, keywords: 'model llm', run: () => { window.artha.llm.setActiveModel(m.name); } });
    }
    // Projects
    for (const p of store.projects) {
      cmds.push({
        id: `proj-${p.project_id}`, group: 'Projects', label: p.name, hint: 'project', icon: FolderOpen, keywords: 'project',
        run: async () => { store.setActiveTab('chat'); const sid = store.selectProject(p.project_id); if (sid) store.setMessages(await window.artha.sessions.getMessages(sid)); },
      });
    }
    // Recent chats (cap to keep the list snappy)
    for (const s of store.sessions.slice(0, 30)) {
      cmds.push({ id: `sess-${s.session_id}`, group: 'Recent chats', label: s.title || 'Untitled chat', icon: MessagesSquare, keywords: 'chat session', run: () => openSession(s.session_id) });
    }
    return cmds;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [models, undoables, store.projects, store.sessions, store.activeProjectId]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return commands;
    return commands.filter((c) => (c.label + ' ' + c.group + ' ' + (c.keywords ?? '')).toLowerCase().includes(q));
  }, [commands, query]);

  // Content-search hits become commands. They bypass the substring filter above
  // because the match may live in a message body, not the title.
  const searchCommands: Command[] = useMemo(() => results.map((r) => ({
    id: `search-${r.type}-${r.id}`,
    group: 'Search results',
    label: r.title,
    sub: r.snippet,
    hint: r.type,
    icon: r.type === 'chat' ? MessagesSquare : r.type === 'memory' ? Brain : FileText,
    run: async () => {
      if (r.type === 'chat') await openSession(r.id);
      else if (r.type === 'memory') store.openWorkspaceSettings('memory');
      else if (r.filePath) window.artha.artifacts.open(r.filePath);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
  })), [results]);

  const items = useMemo(() => [...searchCommands, ...filtered], [searchCommands, filtered]);

  // Keep selection in range as the list shrinks.
  useEffect(() => { setSel((i) => Math.min(i, Math.max(0, items.length - 1))); }, [items.length]);

  if (!open) return null;

  const run = (c?: Command) => { if (!c) return; setOpen(false); void c.run(); };

  const onInputKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setSel((i) => Math.min(i + 1, items.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setSel((i) => Math.max(i - 1, 0)); }
    else if (e.key === 'Enter') { e.preventDefault(); run(items[sel]); }
  };

  return (
    <div className="fixed inset-0 z-[95] flex items-start justify-center pt-[12vh] bg-artha-bg/60 backdrop-blur-md animate-fade-in" onClick={() => setOpen(false)}>
      <div className="w-full max-w-xl mx-4 rounded-2xl border border-artha-border bg-artha-surface-raised shadow-modal overflow-hidden animate-scale-in" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-2 px-4 py-3 border-b border-artha-border">
          <Search size={16} className="text-artha-muted shrink-0" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => { setQuery(e.target.value); setSel(0); }}
            onKeyDown={onInputKey}
            placeholder="Search actions, settings, chats, memory, artifacts…"
            className="flex-1 bg-transparent text-sm text-artha-text placeholder:text-artha-subtle focus:outline-none"
          />
          <kbd className="px-1.5 py-0.5 rounded-md bg-artha-bg border border-artha-border text-[10px] font-mono text-artha-muted">esc</kbd>
        </div>
        <div ref={listRef} className="max-h-[50vh] overflow-auto py-1">
          {items.length === 0 && (
            <p className="px-4 py-6 text-center text-sm text-artha-muted">No matches</p>
          )}
          {items.map((c, i) => {
            const Icon = c.icon;
            const isSel = i === sel;
            const newGroup = i === 0 || items[i - 1].group !== c.group;
            return (
              <div key={c.id}>
                {newGroup && <p className="px-4 pt-2 pb-1 text-[10px] uppercase tracking-wide text-artha-subtle">{c.group}</p>}
                <button
                  onMouseEnter={() => setSel(i)}
                  onClick={() => run(c)}
                  className={`w-full flex items-start gap-3 px-4 py-2 text-left text-sm transition-colors ${isSel ? 'bg-artha-accent/10 text-artha-text' : 'text-artha-text hover:bg-artha-text/5'}`}
                >
                  <Icon size={14} className={`mt-0.5 ${isSel ? 'text-artha-accent' : 'text-artha-muted'}`} />
                  <span className="flex-1 min-w-0">
                    <span className="flex items-center gap-2">
                      <span className="flex-1 truncate">{c.label}</span>
                      {c.hint && <span className="text-[10px] text-artha-subtle shrink-0">{c.hint}</span>}
                    </span>
                    {c.sub && <span className="block text-[11px] text-artha-muted truncate">{c.sub}</span>}
                  </span>
                  {isSel && <ArrowRight size={13} className="text-artha-accent shrink-0 mt-0.5" />}
                </button>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
