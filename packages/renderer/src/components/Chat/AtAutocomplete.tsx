/**
 * AtAutocomplete — `@` reference popover for the composer. Triggers when the
 * user types `@` at a word boundary, lists projects + folders + files in the
 * current scope + tool tokens (`@web`, `@memory`), and inserts the picked
 * reference back into the textarea on Enter / click.
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
 *   - Picking @web / @memory inserts the bare token; the agent reads it
 *     as a hint to use that capability for this turn.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Folder, FileText, Globe, Brain, Star } from 'lucide-react';
import { useChatStore } from '../../stores/chat';

/** One row in the popover. The `id` is opaque to the menu — the parent uses
 *  `value` to decide what to splice into the textarea. */
export interface AtSuggestion {
  id: string;
  kind: 'project' | 'folder' | 'file' | 'tool';
  label: string;
  value: string;
  /** Optional second line — root path for projects, etc. */
  hint?: string;
  /** Marks the currently-active project. */
  current?: boolean;
  /** Side-effect to run when this row is picked (e.g. switch project). */
  onPick?: () => void;
}

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
  const { projects, activeProjectId, scopes, setActiveProjectId } = useChatStore();
  const [selectedIdx, setSelectedIdx] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

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

    // Tools — always last so they don't drown out the project list
    all.push(
      { id: 'tool:web',    kind: 'tool', label: 'web',    value: '@web',    hint: 'Search the live web' },
      { id: 'tool:memory', kind: 'tool', label: 'memory', value: '@memory', hint: 'Recall facts I told you before' },
    );

    return all.filter(s => matches(s, query));
  }, [projects, activeProjectId, scopes, query, setActiveProjectId]);

  // Reset highlight when the suggestion set shrinks/changes.
  useEffect(() => { setSelectedIdx(0); }, [query, items.length]);

  // Keyboard navigation. Bound to window so the textarea keeps focus.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!items.length) return;
      if (e.key === 'ArrowDown') { e.preventDefault(); setSelectedIdx(i => (i + 1) % items.length); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); setSelectedIdx(i => (i - 1 + items.length) % items.length); }
      else if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        const pick = items[selectedIdx];
        if (pick) {
          pick.onPick?.();
          onSelect(pick);
        }
      } else if (e.key === 'Escape') {
        e.preventDefault();
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
            const Icon = item.kind === 'project'
              ? Folder
              : item.kind === 'folder'
                ? Folder
                : item.kind === 'file'
                  ? FileText
                  : item.kind === 'tool' && item.id === 'tool:web' ? Globe : Brain;
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
