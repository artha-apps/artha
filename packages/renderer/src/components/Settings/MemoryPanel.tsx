/**
 * MemoryPanel — browse and manage the agent's long-term memory entities.
 *
 * Loads all stored memories from SQLite via IPC, lets the user inspect
 * each entry (name, type, content), delete individual rows, or wipe all.
 */
import { useEffect, useState } from 'react';
import { Brain, Trash2, RefreshCw, AlertTriangle, Download, Upload, Check } from 'lucide-react';
import { FeatureGuide } from '../ui/FeatureGuide';
import { GUIDES } from './guides';
import MemoryImport from '../MemoryImport/MemoryImport';

interface MemoryEntity {
  entity_id: string;
  name: string;
  entity_type: string;
  content: string;
  tags_json: string;
  origin?: string;
  created_at: number;
  updated_at: number;
}

const TYPE_COLOURS: Record<string, string> = {
  fact:       'bg-blue-500/20 text-blue-300',
  preference: 'bg-purple-500/20 text-purple-300',
  person:     'bg-artha-success/20 text-artha-success',
  project:    'bg-orange-500/20 text-orange-300',
  decision:   'bg-yellow-500/20 text-yellow-300',
  other:      'bg-artha-muted/20 text-artha-muted',
};

function fmtDate(epochSecs: number): string {
  return new Date(epochSecs * 1000).toLocaleDateString(undefined, {
    month: 'short', day: 'numeric', year: 'numeric',
  });
}

/**
 * Memory browser — shows all long-term memory entities the agent has written,
 * allows individual deletion or a two-step "clear all". Reads/writes through
 * the `memory:{list,delete,clear}` IPC channels.
 */
export default function MemoryPanel() {
  // ── State ──────────────────────────────────────────────────────────────────
  const [entities, setEntities] = useState<MemoryEntity[]>([]);
  const [loading, setLoading]   = useState(true);
  // Two-step clear: first click sets confirmClear=true, second click calls handleClear().
  const [confirmClear, setConfirmClear] = useState(false);
  // When true, swap the list for the Bring-Your-Own-Memory importer.
  const [importing, setImporting] = useState(false);
  // Brief "Copied" confirmation after an export.
  const [exported, setExported] = useState(false);

  // ── Effects ────────────────────────────────────────────────────────────────
  async function load() {
    setLoading(true);
    try {
      const rows = await window.artha.memory.list();
      setEntities(rows);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, []);

  // ── Handlers ───────────────────────────────────────────────────────────────

  /** Delete one entity and remove it from local state (no full reload needed). */
  async function handleDelete(id: string) {
    await window.artha.memory.delete(id);
    setEntities(prev => prev.filter(e => e.entity_id !== id));
  }

  /** Wipe the entire memory table and reset UI state. */
  async function handleClear() {
    await window.artha.memory.clear();
    setEntities([]);
    setConfirmClear(false);
  }

  /** Export all global memory in the portable v1 format → clipboard. */
  async function handleExport() {
    const text = await window.artha.memory.export();
    try {
      await navigator.clipboard.writeText(text);
      setExported(true);
      setTimeout(() => setExported(false), 1800);
    } catch { /* clipboard blocked — silent */ }
  }

  // ── Import view (Bring Your Own Memory) ─────────────────────────────────────
  if (importing) {
    return (
      <div className="flex flex-col h-full p-6 overflow-y-auto">
        <div className="flex items-center gap-3 mb-6">
          <Brain size={22} className="text-purple-400" />
          <h2 className="text-lg font-semibold text-artha-text">Import memories</h2>
        </div>
        <MemoryImport
          variant="settings"
          onSkip={() => setImporting(false)}
          onDone={() => { setImporting(false); load(); }}
        />
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full p-6 overflow-y-auto">
      <FeatureGuide {...GUIDES.memory} />
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <Brain size={22} className="text-purple-400" />
          <div>
            <h2 className="text-lg font-semibold text-artha-text">Agent Memory</h2>
            <p className="text-sm text-artha-muted">
              {entities.length} {entities.length === 1 ? 'memory' : 'memories'} stored
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setImporting(true)}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm text-artha-text bg-artha-accent hover:bg-artha-accent/80 transition-colors"
            title="Import memories from another AI"
          >
            <Upload size={14} /> Import
          </button>
          {entities.length > 0 && (
            <button
              onClick={handleExport}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm text-artha-muted hover:text-artha-text border border-artha-border hover:bg-artha-text/8 transition-colors"
              title="Copy all memories in portable format"
            >
              {exported ? <><Check size={14} className="text-artha-success" /> Copied</> : <><Download size={14} /> Export</>}
            </button>
          )}
          <button
            onClick={load}
            className="p-2 rounded-lg hover:bg-artha-text/8 text-artha-muted hover:text-artha-text transition-colors"
            title="Refresh"
          >
            <RefreshCw size={16} className={loading ? 'animate-spin' : ''} />
          </button>
          {entities.length > 0 && !confirmClear && (
            <button
              onClick={() => setConfirmClear(true)}
              className="px-3 py-1.5 rounded-lg text-sm text-artha-danger hover:bg-artha-danger/10 border border-artha-danger/20 transition-colors"
            >
              Clear all
            </button>
          )}
          {confirmClear && (
            <div className="flex items-center gap-2">
              <span className="text-sm text-artha-danger">Delete all memories?</span>
              <button
                onClick={handleClear}
                className="px-3 py-1 rounded text-sm bg-artha-danger hover:bg-artha-danger text-artha-text transition-colors"
              >
                Yes, clear
              </button>
              <button
                onClick={() => setConfirmClear(false)}
                className="px-3 py-1 rounded text-sm hover:bg-artha-text/8 text-artha-muted transition-colors"
              >
                Cancel
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Info banner */}
      <div className="flex items-start gap-3 p-3 mb-5 rounded-lg bg-purple-500/10 border border-purple-500/20">
        <AlertTriangle size={16} className="text-purple-400 mt-0.5 flex-shrink-0" />
        <p className="text-xs text-purple-300 leading-relaxed">
          The agent automatically stores facts, preferences, and project context here so it can recall
          them in future sessions. You can delete individual entries or clear all memories below.
        </p>
      </div>

      {/* Empty state */}
      {!loading && entities.length === 0 && (
        <div className="flex-1 flex flex-col items-center justify-center text-center gap-3">
          <Brain size={40} className="text-artha-subtle" />
          <p className="text-artha-muted text-sm">No memories stored yet.</p>
          <p className="text-artha-subtle text-xs max-w-xs">
            As you work with the agent, it will automatically remember useful facts about you and your projects.
          </p>
        </div>
      )}

      {/* Memory list */}
      {!loading && entities.length > 0 && (
        <div className="space-y-2">
          {entities.map(entity => {
            // Parse tags_json inline — gracefully fall back to empty on malformed JSON.
            const tags: string[] = (() => {
              try { return JSON.parse(entity.tags_json) as string[]; } catch { return []; }
            })();
            const colour = TYPE_COLOURS[entity.entity_type] ?? TYPE_COLOURS.other;

            return (
              <div
                key={entity.entity_id}
                className="group flex items-start gap-3 p-4 rounded-xl bg-artha-text/5 hover:bg-artha-text/8 border border-artha-border transition-colors"
              >
                {/* Type + provenance badges */}
                <div className="flex-shrink-0 flex flex-col items-start gap-1">
                  <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${colour}`}>
                    {entity.entity_type}
                  </span>
                  {entity.origin === 'import' && (
                    <span className="px-2 py-0.5 rounded-full text-[10px] font-medium bg-artha-accent/15 text-artha-accent">
                      imported
                    </span>
                  )}
                </div>

                {/* Content */}
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-artha-text truncate">{entity.name}</p>
                  <p className="text-sm text-artha-muted mt-0.5 line-clamp-2">{entity.content}</p>
                  {tags.length > 0 && (
                    <div className="flex flex-wrap gap-1 mt-1.5">
                      {tags.map(tag => (
                        <span key={tag} className="px-1.5 py-0.5 rounded text-xs bg-artha-text/8 text-artha-muted">
                          #{tag}
                        </span>
                      ))}
                    </div>
                  )}
                  <p className="text-xs text-artha-subtle mt-1.5">Updated {fmtDate(entity.updated_at)}</p>
                </div>

                {/* Delete button */}
                <button
                  onClick={() => handleDelete(entity.entity_id)}
                  className="flex-shrink-0 p-1.5 rounded-lg opacity-0 group-hover:opacity-100 hover:bg-artha-danger/20 text-artha-subtle hover:text-artha-danger transition-all"
                  title="Delete this memory"
                >
                  <Trash2 size={14} />
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
