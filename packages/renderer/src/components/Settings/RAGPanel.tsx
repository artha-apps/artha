/**
 * RAGPanel — create and manage local file indexes that power rag_search and
 * docs_generate's use_rag grounding. Pick a folder, name it, and Artha embeds
 * every supported file locally (Ollama nomic-embed-text). Nothing leaves the
 * machine. Rebuild re-embeds after the folder's contents change.
 */
import { useEffect, useState } from 'react';
import {
  FolderSearch, Plus, Trash2, RefreshCw, FolderOpen, Database, AlertTriangle, Loader2, X,
} from 'lucide-react';
import { FeatureGuide } from '../ui/FeatureGuide';
import { GUIDES } from './guides';

interface RagIndex {
  index_id: string;
  name: string;
  directory_path: string;
  embedding_model: string;
  last_indexed: number | null;
  doc_count: number;
  created_at: number;
}

function relativeTime(unixSec: number | null): string {
  if (!unixSec) return 'never';
  const diff = Math.floor(Date.now() / 1000) - unixSec;
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

/**
 * RAG Index panel — create, rebuild, and delete local vector indexes.
 * Each index embeds files in a chosen folder using nomic-embed-text via Ollama.
 * Resulting chunks are stored in SQLite and queried by the rag_search tool.
 */
export default function RAGPanel() {
  // ── State ──────────────────────────────────────────────────────────────────
  const [indexes, setIndexes] = useState<RagIndex[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  // Controlled inputs for the new-index form.
  const [name, setName] = useState('');
  const [dirPath, setDirPath] = useState('');
  // `building` blocks the form while indexing is in progress (can take minutes).
  const [building, setBuilding] = useState(false);
  // `rebuilding` holds the index_id being re-embedded so we can animate that row only.
  const [rebuilding, setRebuilding] = useState<string | null>(null);
  const [error, setError] = useState('');

  const load = async () => {
    setLoading(true);
    try {
      setIndexes(await window.artha.rag.listIndexes() as RagIndex[]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const pickFolder = async () => {
    const picked = await window.artha.rag.selectDirectory();
    if (picked) {
      setDirPath(picked);
      // Default the index name to the folder name if the user hasn't typed one.
      if (!name.trim()) {
        const base = picked.split('/').filter(Boolean).pop() ?? 'Index';
        setName(base);
      }
    }
  };

  const create = async () => {
    if (!name.trim()) { setError('Give the index a name'); return; }
    if (!dirPath.trim()) { setError('Choose a folder to index'); return; }
    setBuilding(true);
    setError('');
    try {
      await window.artha.rag.createIndex(name.trim(), dirPath.trim());
      setShowForm(false);
      setName(''); setDirPath('');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to build index');
    } finally {
      setBuilding(false);
    }
  };

  const rebuild = async (idx: RagIndex) => {
    setRebuilding(idx.index_id);
    try {
      await window.artha.rag.rebuildIndex(idx.index_id);
      await load();
    } finally {
      setRebuilding(null);
    }
  };

  const remove = async (idx: RagIndex) => {
    await window.artha.rag.deleteIndex(idx.index_id);
    setIndexes(prev => prev.filter(i => i.index_id !== idx.index_id));
  };

  return (
    <div className="flex-1 overflow-y-auto px-8 py-8 max-w-3xl mx-auto w-full">
      <FeatureGuide {...GUIDES.rag} />
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg bg-artha-accent/20 flex items-center justify-center">
            <FolderSearch size={16} className="text-artha-accent" />
          </div>
          <div>
            <h1 className="text-base font-semibold text-artha-text">RAG Index</h1>
            <p className="text-xs text-artha-muted">Make your files searchable — powers <code className="font-mono">rag_search</code> and grounded documents</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={load} disabled={loading}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-artha-border text-artha-muted hover:text-artha-text hover:bg-artha-text/5 text-xs transition-colors disabled:opacity-40">
            <RefreshCw size={12} className={loading ? 'animate-spin' : ''} /> Refresh
          </button>
          {!showForm && (
            <button onClick={() => { setError(''); setShowForm(true); }}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-artha-accent hover:bg-artha-accent/80 text-xs font-medium transition-colors">
              <Plus size={13} /> New Index
            </button>
          )}
        </div>
      </div>

      {/* Embedding requirement note */}
      <div className="flex items-start gap-2 mb-5 text-xs text-artha-muted bg-artha-s2 border border-artha-border rounded-lg px-3 py-2.5">
        <AlertTriangle size={13} className="text-amber-400 shrink-0 mt-0.5" />
        <p className="leading-relaxed">
          Indexing runs locally via Ollama's <code className="bg-black/30 px-1 rounded font-mono">nomic-embed-text</code> model.
          Make sure Ollama is running and pull it once with <code className="bg-black/30 px-1 rounded font-mono">ollama pull nomic-embed-text</code>.
          Supported files: txt, md, pdf, docx, csv, json, and common code files.
        </p>
      </div>

      {/* Create form */}
      {showForm && (
        <div className="bg-artha-s2 border border-artha-border rounded-xl p-4 space-y-3 mb-5">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-medium text-artha-text">New index</h2>
            <button onClick={() => { setShowForm(false); setError(''); }}
              className="p-1 text-artha-muted hover:text-artha-text rounded transition-colors"><X size={14} /></button>
          </div>

          <div>
            <label className="block text-xs font-medium text-artha-muted mb-1">Name</label>
            <input value={name} onChange={e => setName(e.target.value)}
              placeholder="My Notes"
              className="w-full bg-artha-surface border border-artha-border rounded-lg px-3 py-2 text-sm text-artha-text placeholder-artha-muted focus:border-artha-accent/50 focus:outline-none" />
          </div>

          <div>
            <label className="block text-xs font-medium text-artha-muted mb-1">Folder</label>
            <div className="flex gap-2">
              <input value={dirPath} readOnly
                placeholder="Choose a folder…"
                className="flex-1 bg-artha-surface border border-artha-border rounded-lg px-3 py-2 text-sm text-artha-text placeholder-artha-muted focus:outline-none font-mono truncate" />
              <button onClick={pickFolder}
                className="flex items-center gap-1.5 px-3 py-2 rounded-lg border border-artha-border text-artha-muted hover:text-artha-text hover:bg-artha-text/5 text-sm transition-colors shrink-0">
                <FolderOpen size={14} /> Browse
              </button>
            </div>
          </div>

          {error && <p className="text-xs text-red-400 flex items-center gap-1"><X size={11} /> {error}</p>}

          <div className="flex gap-2">
            <button onClick={create} disabled={building}
              className="flex items-center gap-1.5 px-4 py-2 rounded-lg bg-artha-accent hover:bg-artha-accent/80 disabled:opacity-40 text-sm font-medium transition-colors">
              {building ? <><Loader2 size={13} className="animate-spin" /> Indexing…</> : <><Database size={13} /> Build index</>}
            </button>
            <button onClick={() => { setShowForm(false); setError(''); }}
              className="px-4 py-2 rounded-lg text-sm text-artha-muted hover:text-artha-text hover:bg-artha-text/5 transition-colors">
              Cancel
            </button>
          </div>
          {building && (
            <p className="text-xs text-artha-muted">Embedding files locally — this can take a minute for large folders.</p>
          )}
        </div>
      )}

      {/* Index list */}
      {loading ? (
        <div className="space-y-2">
          {[1, 2].map(i => <div key={i} className="h-20 bg-artha-s2 border border-artha-border rounded-xl animate-pulse" />)}
        </div>
      ) : indexes.length === 0 ? (
        <div className="text-center py-16 text-artha-muted">
          <FolderSearch size={32} className="mx-auto mb-3 opacity-30" />
          <p className="text-sm font-medium text-artha-text mb-1">No indexes yet</p>
          <p className="text-xs">Index a folder to let Artha search and cite your own files.</p>
        </div>
      ) : (
        <div className="space-y-2">
          {indexes.map(idx => (
            <div key={idx.index_id}
              className="flex items-center gap-3 px-4 py-3 rounded-xl bg-artha-s2 border border-artha-border">
              <div className="w-9 h-9 rounded-lg bg-artha-surface border border-artha-border flex items-center justify-center shrink-0">
                <Database size={16} className="text-artha-accent" />
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-artha-text truncate">{idx.name}</p>
                <code className="text-[11px] text-artha-muted font-mono truncate block">{idx.directory_path}</code>
                <p className="text-[11px] text-artha-muted mt-0.5">
                  {idx.doc_count} chunks · indexed {relativeTime(idx.last_indexed)}
                </p>
              </div>
              <button onClick={() => rebuild(idx)} disabled={rebuilding === idx.index_id} title="Rebuild"
                className="p-1.5 text-artha-muted hover:text-artha-text hover:bg-artha-text/5 rounded-lg transition-colors disabled:opacity-40">
                <RefreshCw size={14} className={rebuilding === idx.index_id ? 'animate-spin' : ''} />
              </button>
              <button onClick={() => remove(idx)} title="Delete"
                className="p-1.5 text-artha-muted hover:text-red-400 hover:bg-artha-text/5 rounded-lg transition-colors">
                <Trash2 size={14} />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
