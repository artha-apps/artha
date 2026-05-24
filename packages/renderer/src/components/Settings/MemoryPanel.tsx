/**
 * MemoryPanel — browse and manage the agent's long-term memory entities.
 *
 * Loads all stored memories from SQLite via IPC, lets the user inspect
 * each entry (name, type, content), delete individual rows, or wipe all.
 */
import { useEffect, useState } from 'react';
import { Brain, Trash2, RefreshCw, AlertTriangle } from 'lucide-react';

interface MemoryEntity {
  entity_id: string;
  name: string;
  entity_type: string;
  content: string;
  tags_json: string;
  created_at: number;
  updated_at: number;
}

const TYPE_COLOURS: Record<string, string> = {
  fact:       'bg-blue-500/20 text-blue-300',
  preference: 'bg-purple-500/20 text-purple-300',
  person:     'bg-green-500/20 text-green-300',
  project:    'bg-orange-500/20 text-orange-300',
  decision:   'bg-yellow-500/20 text-yellow-300',
  other:      'bg-gray-500/20 text-gray-300',
};

function fmtDate(epochSecs: number): string {
  return new Date(epochSecs * 1000).toLocaleDateString(undefined, {
    month: 'short', day: 'numeric', year: 'numeric',
  });
}

export default function MemoryPanel() {
  const [entities, setEntities] = useState<MemoryEntity[]>([]);
  const [loading, setLoading]   = useState(true);
  const [confirmClear, setConfirmClear] = useState(false);

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

  async function handleDelete(id: string) {
    await window.artha.memory.delete(id);
    setEntities(prev => prev.filter(e => e.entity_id !== id));
  }

  async function handleClear() {
    await window.artha.memory.clear();
    setEntities([]);
    setConfirmClear(false);
  }

  return (
    <div className="flex flex-col h-full p-6 overflow-y-auto">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <Brain size={22} className="text-purple-400" />
          <div>
            <h2 className="text-lg font-semibold text-white">Agent Memory</h2>
            <p className="text-sm text-gray-400">
              {entities.length} {entities.length === 1 ? 'memory' : 'memories'} stored
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={load}
            className="p-2 rounded-lg hover:bg-white/10 text-gray-400 hover:text-white transition-colors"
            title="Refresh"
          >
            <RefreshCw size={16} className={loading ? 'animate-spin' : ''} />
          </button>
          {entities.length > 0 && !confirmClear && (
            <button
              onClick={() => setConfirmClear(true)}
              className="px-3 py-1.5 rounded-lg text-sm text-red-400 hover:bg-red-500/10 border border-red-500/20 transition-colors"
            >
              Clear all
            </button>
          )}
          {confirmClear && (
            <div className="flex items-center gap-2">
              <span className="text-sm text-red-400">Delete all memories?</span>
              <button
                onClick={handleClear}
                className="px-3 py-1 rounded text-sm bg-red-500 hover:bg-red-600 text-white transition-colors"
              >
                Yes, clear
              </button>
              <button
                onClick={() => setConfirmClear(false)}
                className="px-3 py-1 rounded text-sm hover:bg-white/10 text-gray-400 transition-colors"
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
          <Brain size={40} className="text-gray-600" />
          <p className="text-gray-400 text-sm">No memories stored yet.</p>
          <p className="text-gray-500 text-xs max-w-xs">
            As you work with the agent, it will automatically remember useful facts about you and your projects.
          </p>
        </div>
      )}

      {/* Memory list */}
      {!loading && entities.length > 0 && (
        <div className="space-y-2">
          {entities.map(entity => {
            const tags: string[] = (() => {
              try { return JSON.parse(entity.tags_json) as string[]; } catch { return []; }
            })();
            const colour = TYPE_COLOURS[entity.entity_type] ?? TYPE_COLOURS.other;

            return (
              <div
                key={entity.entity_id}
                className="group flex items-start gap-3 p-4 rounded-xl bg-white/5 hover:bg-white/8 border border-white/5 transition-colors"
              >
                {/* Type badge */}
                <span className={`flex-shrink-0 px-2 py-0.5 rounded-full text-xs font-medium ${colour}`}>
                  {entity.entity_type}
                </span>

                {/* Content */}
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-white truncate">{entity.name}</p>
                  <p className="text-sm text-gray-300 mt-0.5 line-clamp-2">{entity.content}</p>
                  {tags.length > 0 && (
                    <div className="flex flex-wrap gap-1 mt-1.5">
                      {tags.map(tag => (
                        <span key={tag} className="px-1.5 py-0.5 rounded text-xs bg-white/10 text-gray-400">
                          #{tag}
                        </span>
                      ))}
                    </div>
                  )}
                  <p className="text-xs text-gray-500 mt-1.5">Updated {fmtDate(entity.updated_at)}</p>
                </div>

                {/* Delete button */}
                <button
                  onClick={() => handleDelete(entity.entity_id)}
                  className="flex-shrink-0 p-1.5 rounded-lg opacity-0 group-hover:opacity-100 hover:bg-red-500/20 text-gray-500 hover:text-red-400 transition-all"
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
