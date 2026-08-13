/**
 * RAGPanel — create and manage file indexes that power rag_search and
 * docs_generate's use_rag grounding. Pick a folder, name it, and Artha embeds
 * every supported file — locally by default (Ollama nomic-embed-text; nothing
 * leaves the machine), or via an explicitly consented cloud embedder (Phase B
 * D-B1: opt-in, revocable, disclosed). Rebuild re-embeds after the folder's
 * contents change, or after switching embedders.
 */
import { useEffect, useState } from 'react';
import { toast } from '../../stores/toast';
import {
  FolderSearch, Plus, Trash2, RefreshCw, FolderOpen, Database, AlertTriangle, Loader2, X,
  HardDrive, Cloud,
} from 'lucide-react';
import { FeatureGuide } from '../ui/FeatureGuide';
import { GUIDES } from './guides';

interface RagIndex {
  index_id: string;
  name: string;
  directory_path: string;
  embedding_model: string;
  embedding_dim: number;
  last_indexed: number | null;
  doc_count: number;
  created_at: number;
}

/** Mirror of the embedding:getStatus IPC payload (see preload.ts). */
interface EmbeddingStatus {
  active: { id: string; model: string; dim: number; isLocal: boolean };
  consent: { modelId: string; model: string; dim: number; consentedAt: number } | null;
  cloudModels: { model_id: string; name: string; provider: string; base_url: string }[];
}

/** Host shown in the consent disclosure — the user should see WHERE their text
 *  goes, not just a display name. Falls back to the raw URL if unparsable. */
function hostOf(url: string): string {
  try { return new URL(url).host; } catch { return url; }
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
  // Honest degraded state: semantic search needs local embeddings (Ollama +
  // nomic-embed-text). Without them, indexing silently produced useless
  // zero-vector indexes — now we say so BEFORE the user indexes anything.
  const [semantic, setSemantic] = useState<
    { available: true } | { available: false; reason: 'ollama_down' | 'embed_model_missing' } | null
  >(null);
  // ── Embedder state (Phase B Slice 2c) ─────────────────────────────────────
  const [embed, setEmbed] = useState<EmbeddingStatus | null>(null);
  // Cloud-consent form: pick a saved BYOK model row + an embedding model name,
  // acknowledge the disclosure, then enable (probe-verified main-side).
  const [showCloudForm, setShowCloudForm] = useState(false);
  const [cloudModelId, setCloudModelId] = useState('');
  const [cloudEmbedModel, setCloudEmbedModel] = useState('text-embedding-3-small');
  const [cloudAck, setCloudAck] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [cloudError, setCloudError] = useState('');

  const load = async () => {
    setLoading(true);
    try {
      setIndexes(await window.artha.rag.listIndexes() as RagIndex[]);
    } finally {
      setLoading(false);
    }
    window.artha.llm.semanticStatus?.().then(setSemantic).catch(() => setSemantic(null));
    window.artha.rag.embeddingStatus?.().then(setEmbed).catch(() => setEmbed(null));
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
      // A rebuild failure used to be completely silent — the spinner ended and
      // nothing indicated success vs failure (audit H23).
      const res = await window.artha.rag.rebuildIndex(idx.index_id);
      await load();
      if (!res.ok) toast.error('Index rebuild failed', res.error);
      else if (res.embedded === 0) toast.warning('Index rebuilt, but empty', 'No chunks were embedded — semantic search needs local embeddings running.');
    } catch (err) {
      toast.error('Index rebuild failed', err instanceof Error ? err.message : undefined);
    } finally {
      setRebuilding(null);
    }
  };

  const remove = async (idx: RagIndex) => {
    await window.artha.rag.deleteIndex(idx.index_id);
    setIndexes(prev => prev.filter(i => i.index_id !== idx.index_id));
  };

  /** Enable cloud embeddings — only reachable after the disclosure checkbox.
   *  The main process probes the endpoint first; consent is recorded on
   *  success only, so a bad key/model never leaves the app half-switched. */
  const enableCloud = async () => {
    if (!cloudModelId || !cloudEmbedModel.trim() || !cloudAck) return;
    setSwitching(true);
    setCloudError('');
    try {
      const res = await window.artha.rag.enableCloudEmbedding(cloudModelId, cloudEmbedModel.trim());
      if (!res.ok) { setCloudError(res.error ?? 'Could not enable cloud embeddings.'); return; }
      setShowCloudForm(false);
      setCloudAck(false);
      toast.success(
        'Cloud embeddings enabled',
        `${cloudEmbedModel.trim()} (${res.dim}-dim). Rebuild any index you want searchable with it — existing local indexes keep working until then.`,
      );
      await load();
    } finally {
      setSwitching(false);
    }
  };

  /** Revoke cloud consent — back to local-only. Cloud-built indexes stay on
   *  disk but are refused at query time until rebuilt locally (D-B3). */
  const disableCloud = async () => {
    setSwitching(true);
    try {
      await window.artha.rag.disableCloudEmbedding();
      toast.success('Back to local embeddings', 'Nothing leaves this machine. Rebuild cloud-built indexes to search them locally.');
      await load();
    } finally {
      setSwitching(false);
    }
  };

  /** Does this index's vector space differ from the active embedder? Shown as
   *  an honest per-index badge — searching it would be refused (D-B3). */
  const mismatched = (idx: RagIndex): boolean =>
    !!embed && (idx.embedding_model !== embed.active.model || idx.embedding_dim !== embed.active.dim);

  return (
    <div className="flex-1 overflow-y-auto px-8 py-8 max-w-3xl mx-auto w-full">
      <FeatureGuide {...GUIDES.rag} />
      {/* Semantic search unavailable — honest state, shown BEFORE indexing. */}
      {semantic && !semantic.available && (
        <div className="mb-4 px-3 py-2.5 rounded-lg bg-artha-warn/10 border border-artha-warn/30 text-xs leading-relaxed">
          <span className="font-medium text-artha-text">Semantic search is unavailable right now. </span>
          <span className="text-artha-muted">
            {semantic.reason === 'ollama_down'
              ? 'Local embeddings need Ollama running on this machine (even if you chat via a cloud model). Until then, document search falls back to keyword matching.'
              : 'The embedding model (nomic-embed-text) isn’t installed yet — Artha pulls it automatically when Ollama is running. Until then, document search falls back to keyword matching.'}
          </span>
        </div>
      )}
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

      {/* Embedder card — who computes the vectors, and the cloud consent switch.
          The privacy boundary (D-B1) is enforced in the main process; this UI
          only ever ASKS, with the destination spelled out. */}
      <div className="bg-artha-s2 border border-artha-border rounded-xl p-4 mb-5 space-y-3">
        <div className="flex items-start gap-2.5">
          {(!embed || embed.active.isLocal)
            ? <HardDrive size={15} className="text-artha-accent shrink-0 mt-0.5" />
            : <Cloud size={15} className="text-amber-400 shrink-0 mt-0.5" />}
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium text-artha-text">
              Embeddings: {(!embed || embed.active.isLocal) ? 'Local' : 'Cloud'}
              <code className="ml-1.5 text-[11px] font-mono text-artha-muted">{embed ? `${embed.active.model} · ${embed.active.dim}-dim` : 'nomic-embed-text · 768-dim'}</code>
            </p>
            <p className="text-xs text-artha-muted leading-relaxed mt-0.5">
              {(!embed || embed.active.isLocal)
                ? <>Indexing runs on this machine via Ollama — indexed text never leaves it. Pull the model once with <code className="bg-black/30 px-1 rounded font-mono">ollama pull nomic-embed-text</code>. Supported files: txt, md, pdf, docx, csv, json, and common code files.</>
                : <>Text you index and every search query are sent to this provider. You can switch back to local at any time.</>}
            </p>
          </div>
          {embed && (embed.active.isLocal
            ? (!showCloudForm && embed.cloudModels.length > 0 && (
                <button onClick={() => { setCloudError(''); setCloudModelId(embed.cloudModels[0].model_id); setShowCloudForm(true); }}
                  className="shrink-0 px-3 py-1.5 rounded-lg border border-artha-border text-artha-muted hover:text-artha-text hover:bg-artha-text/5 text-xs transition-colors">
                  Use cloud embeddings…
                </button>
              ))
            : (
                <button onClick={disableCloud} disabled={switching}
                  className="shrink-0 px-3 py-1.5 rounded-lg border border-artha-border text-artha-muted hover:text-artha-text hover:bg-artha-text/5 text-xs transition-colors disabled:opacity-40">
                  {switching ? <Loader2 size={12} className="animate-spin" /> : 'Switch back to local'}
                </button>
              ))}
        </div>

        {/* Consent flow — explicit destination + acknowledgement, never a bare toggle. */}
        {showCloudForm && embed?.active.isLocal && (
          <div className="border-t border-artha-border pt-3 space-y-3">
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="block text-xs font-medium text-artha-muted mb-1">Cloud model (BYOK)</label>
                <select value={cloudModelId} onChange={e => setCloudModelId(e.target.value)}
                  className="w-full bg-artha-surface border border-artha-border rounded-lg px-2.5 py-2 text-sm text-artha-text focus:border-artha-accent/50 focus:outline-none">
                  {embed.cloudModels.map(m => (
                    <option key={m.model_id} value={m.model_id}>{m.name} ({hostOf(m.base_url)})</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-artha-muted mb-1">Embedding model</label>
                <input value={cloudEmbedModel} onChange={e => setCloudEmbedModel(e.target.value)}
                  placeholder="text-embedding-3-small" spellCheck={false}
                  className="w-full bg-artha-surface border border-artha-border rounded-lg px-2.5 py-2 text-sm text-artha-text font-mono placeholder-artha-muted focus:border-artha-accent/50 focus:outline-none" />
              </div>
            </div>

            {(() => {
              const target = embed.cloudModels.find(m => m.model_id === cloudModelId);
              return (
                <div className="flex items-start gap-2 px-3 py-2.5 rounded-lg bg-artha-warn/10 border border-artha-warn/30 text-xs leading-relaxed">
                  <AlertTriangle size={13} className="text-amber-400 shrink-0 mt-0.5" />
                  <p className="text-artha-muted">
                    <span className="font-medium text-artha-text">Cloud embeddings send data off this machine. </span>
                    Every file you index and every search query will be sent to{' '}
                    <span className="font-medium text-artha-text">{target ? `${target.name} (${hostOf(target.base_url)})` : 'the selected provider'}</span>.
                    Artha stays local by default — this is opt-in and you can turn it off any time.
                    Existing local indexes keep working until you rebuild them with the cloud embedder.
                  </p>
                </div>
              );
            })()}

            <label className="flex items-center gap-2 text-xs text-artha-text cursor-pointer select-none">
              <input type="checkbox" checked={cloudAck} onChange={e => setCloudAck(e.target.checked)}
                className="accent-amber-400" />
              I understand — send my indexed text and search queries to this provider
            </label>

            {cloudError && <p className="text-xs text-artha-danger flex items-center gap-1"><X size={11} /> {cloudError}</p>}

            <div className="flex gap-2">
              <button onClick={enableCloud} disabled={switching || !cloudAck || !cloudModelId || !cloudEmbedModel.trim()}
                className="flex items-center gap-1.5 px-4 py-2 rounded-lg bg-artha-accent hover:bg-artha-accent/80 disabled:opacity-40 text-sm font-medium transition-colors">
                {switching ? <><Loader2 size={13} className="animate-spin" /> Testing…</> : <><Cloud size={13} /> Enable cloud embeddings</>}
              </button>
              <button onClick={() => { setShowCloudForm(false); setCloudAck(false); setCloudError(''); }}
                className="px-4 py-2 rounded-lg text-sm text-artha-muted hover:text-artha-text hover:bg-artha-text/5 transition-colors">
                Cancel
              </button>
            </div>
          </div>
        )}

        {embed?.active.isLocal && embed.cloudModels.length === 0 && (
          <p className="text-[11px] text-artha-muted border-t border-artha-border pt-2.5">
            To enable cloud embeddings, first add a cloud (BYOK) model in the Models panel.
          </p>
        )}
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

          {error && <p className="text-xs text-artha-danger flex items-center gap-1"><X size={11} /> {error}</p>}

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
                {/* D-B3 honesty: this index can't be searched with the active
                    embedder — say so here, where the Rebuild button is. */}
                {mismatched(idx) && embed && (
                  <p className="text-[11px] text-amber-400 mt-0.5 flex items-center gap-1">
                    <AlertTriangle size={10} className="shrink-0" />
                    Built with {idx.embedding_model} ({idx.embedding_dim}-dim) — rebuild to search with {embed.active.model}
                  </p>
                )}
              </div>
              <button onClick={() => rebuild(idx)} disabled={rebuilding === idx.index_id} title="Rebuild"
                className="p-1.5 text-artha-muted hover:text-artha-text hover:bg-artha-text/5 rounded-lg transition-colors disabled:opacity-40">
                <RefreshCw size={14} className={rebuilding === idx.index_id ? 'animate-spin' : ''} />
              </button>
              <button onClick={() => remove(idx)} title="Delete"
                className="p-1.5 text-artha-muted hover:text-artha-danger hover:bg-artha-text/5 rounded-lg transition-colors">
                <Trash2 size={14} />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
