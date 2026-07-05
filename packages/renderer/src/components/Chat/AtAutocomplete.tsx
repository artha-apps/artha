/**
 * AtAutocomplete — `@` reference popover for the composer. Triggers when the
 * user types `@` at a word boundary, lists projects + folders + files in the
 * current scope + cross-chat/memory references (`@chat:"…"`, `@memory:"…"`)
 * + tool tokens (`@web`, `@memory`), and inserts the picked reference back
 * into the textarea on Enter / click.
 *
 * Reference syntax — one `@` for everything, matching Cursor / GitHub /
 * Linear / Notion. Don't split into `@`/`#`/`!`; users have one mental slot
 * for "reference something."
 *
 * Selection model:
 *   - Picking a PROJECT also switches the sidebar context to that project,
 *     so the rest of the chat lands in the right scope automatically.
 *   - Picking a FILE or FOLDER inserts the path; the orchestrator's
 *     sandbox + scope block already make those references meaningful.
 *   - Picking a CHAT or MEMORY inserts a compact `@chat:"title"` /
 *     `@memory:"name"` token — the main process expands it into real content
 *     at send time (agent/mentionResolver.ts), so the message stays short.
 *   - Picking @web / @memory inserts the bare token; the agent reads it
 *     as a hint to use that capability for this turn.
 *
 * Typing `chat:` or `memory:` after the `@` narrows the list to that group.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Folder, FileText, Globe, Brain, Star, MessagesSquare } from 'lucide-react';
import { useChatStore } from '../../stores/chat';

/** One row in the popover. The `id` is opaque to the menu — the parent uses
 *  `value` to decide what to splice into the textarea. */
export interface AtSuggestion {
  id: string;
  kind: 'project' | 'folder' | 'file' | 'chat' | 'memory' | 'tool';
  label: string;
  value: string;
  /** Optional second line — root path for projects, etc. */
  hint?: string;
  /** Marks the currently-active project. */
  current?: boolean;
  /** Side-effect to run when this row is picked (e.g. switch project). */
  onPick?: () => void;
}

/** Caps so reference groups never drown the list. */
const MAX_CHAT_SUGGESTIONS = 8;
const MAX_MEMORY_SUGGESTIONS = 8;

interface AtAutocompleteProps {
  /** Free-text query after the `@` (without the `@`). Empty = show all. */
  query: string;
  /** Picked a row — parent splices it into the composer. */
  onSelect: (suggestion: AtSuggestion) => void;
  /** Esc / outside-click / blur. Parent clears the open state. */
  onClose: () => void;
}

/** Bare matcher — case-insensitive substring on label + value. */
function matches(s: AtSuggestion, q: string): boolean {
  if (!q) return true;
  const needle = q.toLowerCase();
  return s.label.toLowerCase().includes(needle) || s.value.toLowerCase().includes(needle);
}

export default function AtAutocomplete({ query, onSelect, onClose }: AtAutocompleteProps) {
  const { projects, activeProjectId, scopes, setActiveProjectId, sessions, activeSessionId } = useChatStore();
  const [selectedIdx, setSelectedIdx] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  // Memory names for `@memory:"…"` — fetched once per mount (the popover is
  // ephemeral, so "on mount" is effectively "on open"). Scoped global ∪ active
  // project to mirror what recall will actually inject.
  const [memories, setMemories] = useState<Array<{ entity_id: string; name: string; content: string; project_id: string | null }>>([]);
  useEffect(() => {
    window.artha.memory.list()
      .then(rows => setMemories(rows.filter(r => !r.project_id || r.project_id === activeProjectId)))
      .catch(() => setMemories([]));
  }, [activeProjectId]);

  // `chat:`/`memory:` prefixes narrow the popover to that reference group,
  // matching the token grammar the resolver parses. Quotes are stripped so
  // matching keeps working while the user types `@chat:"my ti…`.
  const kindFilter: 'chat' | 'memory' | null =
    query.startsWith('chat:') ? 'chat' : query.startsWith('memory:') ? 'memory' : null;
  const effectiveQuery = kindFilter
    ? query.slice(kindFilter.length + 1).replace(/"/g, '')
    : query;

  // Build the suggestion list every render — projects/scopes change rarely.
  const items = useMemo<AtSuggestion[]>(() => {
    const all: AtSuggestion[] = [];

    // Projects
    for (const p of projects) {
      all.push({
        id: `project:${p.project_id}`,
        kind: 'project',
        label: p.name,
        value: `@${p.name}`,
        hint: p.root_path,
        current: p.project_id === activeProjectId,
        onPick: () => setActiveProjectId(p.project_id),
      });
    }

    // Folders + files attached to the current chat (the scope sandbox)
    for (const s of scopes) {
      const base = s.path.split('/').filter(Boolean).pop() ?? s.path;
      all.push({
        id: `scope:${s.scope_id}`,
        kind: s.kind,
        label: base,
        value: `@${base}`,
        hint: s.path,
      });
    }

    // Other chats — same-project first (most relevant), then the rest; both
    // buckets keep their recency order (sessions arrive last_activity DESC).
    const otherChats = sessions.filter(s => s.session_id !== activeSessionId);
    const orderedChats = [
      ...otherChats.filter(s => s.project_id === activeProjectId),
      ...otherChats.filter(s => s.project_id !== activeProjectId),
    ].slice(0, MAX_CHAT_SUGGESTIONS);
    for (const s of orderedChats) {
      all.push({
        id: `chat:${s.session_id}`,
        kind: 'chat',
        label: s.title,
        value: `@chat:"${s.title}"`,
        hint: 'Pull that chat’s context into this one',
      });
    }

    // Specific memories — inserts a reference to ONE remembered fact.
    for (const m of memories.slice(0, MAX_MEMORY_SUGGESTIONS)) {
      all.push({
        id: `memory:${m.entity_id}`,
        kind: 'memory',
        label: m.name,
        value: `@memory:"${m.name}"`,
        hint: m.content,
      });
    }

    // Tools — always last so they don't drown out the project list
    all.push(
      { id: 'tool:web',    kind: 'tool', label: 'web',    value: '@web',    hint: 'Search the live web' },
      { id: 'tool:memory', kind: 'tool', label: 'memory', value: '@memory', hint: 'Recall facts I told you before' },
    );

    return all.filter(s => {
      if (kindFilter && s.kind !== kindFilter) return false;
      return matches(s, effectiveQuery);
    });
  }, [projects, activeProjectId, scopes, sessions, activeSessionId, memories, kindFilter, effectiveQuery, setActiveProjectId]);

  // Reset highlight when the suggestion set shrinks/changes.
  useEffect(() => { setSelectedIdx(0); }, [query, items.length]);

  // Keyboard navigation. Bound to window in CAPTURE phase + we stop
  // propagation/immediate-propagation so React's textarea onKeyDown (which
  // would otherwise treat Enter as "send") never fires while the popover
  // is open and a handled key is pressed.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!items.length) return;
      const handled =
        e.key === 'ArrowDown' || e.key === 'ArrowUp' ||
        e.key === 'Enter'     || e.key === 'Tab'    ||
        e.key === 'Escape';
      if (!handled) return;
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      if (e.key === 'ArrowDown') setSelectedIdx(i => (i + 1) % items.length);
      else if (e.key === 'ArrowUp') setSelectedIdx(i => (i - 1 + items.length) % items.length);
      else if (e.key === 'Enter' || e.key === 'Tab') {
        const pick = items[selectedIdx];
        if (pick) { pick.onPick?.(); onSelect(pick); }
      } else if (e.key === 'Escape') {
        onClose();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [items, selectedIdx, onSelect, onClose]);

  if (!items.length) {
    return (
      <div className="absolute bottom-full left-0 mb-1 w-80 rounded-lg border border-artha-border bg-artha-surface shadow-modal p-3 text-xs text-artha-subtle">
        No matches for &ldquo;{query}&rdquo;
      </div>
    );
  }

  // Group rows visually by kind without splitting the index — the keyboard
  // walks the flat list to keep up/down predictable.
  const grouped: { label: string; rows: { item: AtSuggestion; idx: number }[] }[] = [];
  const pushGroup = (label: string, kind: AtSuggestion['kind'] | 'folderOrFile') => {
    const rows = items
      .map((item, idx) => ({ item, idx }))
      .filter(({ item }) =>
        kind === 'folderOrFile' ? (item.kind === 'folder' || item.kind === 'file') : item.kind === kind
      );
    if (rows.length) grouped.push({ label, rows });
  };
  pushGroup('Projects', 'project');
  pushGroup('In this scope', 'folderOrFile');
  pushGroup('Chats', 'chat');
  pushGroup('Memories', 'memory');
  pushGroup('Tools', 'tool');

  return (
    <div
      ref={listRef}
      className="absolute bottom-full left-0 mb-1 w-80 max-h-72 overflow-y-auto rounded-lg border border-artha-border bg-artha-surface shadow-modal py-1"
    >
      {grouped.map(group => (
        <div key={group.label}>
          <div className="px-3 pt-2 pb-1 text-[10px] uppercase tracking-wider text-artha-subtle font-semibold">
            {group.label}
          </div>
          {group.rows.map(({ item, idx }) => {
            const Icon =
              item.kind === 'project' || item.kind === 'folder' ? Folder
              : item.kind === 'file' ? FileText
              : item.kind === 'chat' ? MessagesSquare
              : item.kind === 'memory' ? Brain
              : item.id === 'tool:web' ? Globe : Brain;
            return (
              <button
                key={item.id}
                onMouseEnter={() => setSelectedIdx(idx)}
                onClick={() => { item.onPick?.(); onSelect(item); }}
                className={`w-full flex items-center gap-2 px-3 py-1.5 text-xs text-left transition-colors
                  ${idx === selectedIdx
                    ? 'bg-artha-accent/10 text-artha-text'
                    : 'text-artha-muted hover:bg-artha-surface2 hover:text-artha-text'}`}
              >
                <Icon size={12} className="shrink-0 text-artha-accent" />
                <span className="truncate flex-1">{item.label}</span>
                {item.current && (
                  <span className="inline-flex items-center gap-0.5 text-[10px] text-artha-accent">
                    <Star size={9} /> current
                  </span>
                )}
                {item.hint && !item.current && (
                  <span className="truncate text-[10px] text-artha-subtle max-w-[140px]">{item.hint}</span>
                )}
              </button>
            );
          })}
        </div>
      ))}
    </div>
  );
}
