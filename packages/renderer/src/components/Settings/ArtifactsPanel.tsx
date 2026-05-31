/**
 * ArtifactsPanel — browse, open, and delete files the agent has generated.
 *
 * Every call to `docs_generate` (and any other tool that logs to `artifacts`)
 * writes a row. This panel reads those rows back and gives the user a
 * one-stop place to find everything Artha has produced for them.
 */
import { useEffect, useState } from 'react';
import { FolderOpen, Trash2, FileText, FileSpreadsheet, Presentation, File, RefreshCw } from 'lucide-react';

interface Artifact {
  artifact_id: string;
  session_id: string | null;
  name: string;
  file_path: string;
  file_type: string;
  size_bytes: number | null;
  created_at: number;
}

function fileIcon(type: string) {
  if (type === 'docx') return <FileText size={16} className="text-blue-400" />;
  if (type === 'xlsx') return <FileSpreadsheet size={16} className="text-green-400" />;
  if (type === 'pptx') return <Presentation size={16} className="text-orange-400" />;
  if (type === 'pdf')  return <FileText size={16} className="text-red-400" />;
  return <File size={16} className="text-artha-muted" />;
}

function formatBytes(n: number | null) {
  if (n == null) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDate(ts: number) {
  return new Date(ts * 1000).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

/** Artifact browser — lists files written to the `artifacts` table, lets the
 *  user open them with the OS default app or remove the record from the list. */
export default function ArtifactsPanel() {
  // ── State ──────────────────────────────────────────────────────────────────
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  const [loading, setLoading] = useState(true);
  // `deleting` holds the artifact_id whose delete button is in-flight.
  const [deleting, setDeleting] = useState<string | null>(null);

  // ── Effects ────────────────────────────────────────────────────────────────
  const load = async () => {
    setLoading(true);
    try {
      const rows = await window.artha.artifacts.list();
      setArtifacts(rows);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  // ── Handlers ───────────────────────────────────────────────────────────────

  /** Ask the OS to open the file with its default application (e.g. Word for .docx). */
  const open = async (filePath: string) => {
    await window.artha.artifacts.open(filePath);
  };

  /** Remove the artifact record from the DB (and the file from disk) and update
   *  the local list optimistically to avoid a full reload. */
  const remove = async (artifactId: string) => {
    setDeleting(artifactId);
    await window.artha.artifacts.delete(artifactId);
    setArtifacts(prev => prev.filter(a => a.artifact_id !== artifactId));
    setDeleting(null);
  };

  return (
    <div className="flex-1 overflow-y-auto p-6">
      <div className="max-w-3xl mx-auto">

        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <div>
            <h2 className="text-lg font-semibold text-artha-text">Generated Artifacts</h2>
            <p className="text-sm text-artha-muted mt-0.5">
              Files Artha has created for you — click to open, or delete to remove from the list.
            </p>
          </div>
          <button
            onClick={load}
            disabled={loading}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs text-artha-muted hover:text-artha-text hover:bg-artha-text/5 border border-artha-border transition-colors disabled:opacity-40"
          >
            <RefreshCw size={12} className={loading ? 'animate-spin' : ''} />
            Refresh
          </button>
        </div>

        {/* Empty state */}
        {!loading && artifacts.length === 0 && (
          <div className="flex flex-col items-center justify-center gap-3 py-20 text-artha-muted">
            <File size={32} className="opacity-30" />
            <p className="text-sm">No artifacts yet — ask Artha to generate a report, spreadsheet, or presentation.</p>
          </div>
        )}

        {/* Artifact rows */}
        <div className="space-y-2">
          {artifacts.map(a => (
            <div
              key={a.artifact_id}
              className="flex items-center gap-3 px-4 py-3 rounded-xl bg-artha-s2 border border-artha-border hover:border-artha-accent/30 transition-colors group"
            >
              <div className="shrink-0">{fileIcon(a.file_type)}</div>

              <div className="flex-1 min-w-0">
                <p className="text-sm text-artha-text truncate">{a.name}</p>
                <p className="text-xs text-artha-muted truncate mt-0.5">
                  {a.file_type.toUpperCase()}{a.size_bytes ? ` · ${formatBytes(a.size_bytes)}` : ''} · {formatDate(a.created_at)}
                </p>
                <p className="text-[11px] text-artha-muted/60 truncate mt-0.5">{a.file_path}</p>
              </div>

              <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
                <button
                  onClick={() => open(a.file_path)}
                  title="Open file"
                  className="p-1.5 rounded-lg hover:bg-artha-accent/20 text-artha-muted hover:text-artha-accent transition-colors"
                >
                  <FolderOpen size={14} />
                </button>
                <button
                  onClick={() => remove(a.artifact_id)}
                  disabled={deleting === a.artifact_id}
                  title="Remove from list"
                  className="p-1.5 rounded-lg hover:bg-red-500/20 text-artha-muted hover:text-red-400 transition-colors disabled:opacity-40"
                >
                  <Trash2 size={14} />
                </button>
              </div>
            </div>
          ))}
        </div>

      </div>
    </div>
  );
}
