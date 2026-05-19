/**
 * BundlesPanel — Export any agent run as a portable .artha-bundle, or import
 * one and verify its signature + missing dependencies.
 */
import { useEffect, useState } from 'react';
import {
  Package, Download, Upload, CheckCircle2, XCircle, FolderOpen,
  ShieldCheck, ShieldAlert, History, RefreshCw, AlertTriangle, FileText,
} from 'lucide-react';

/** Subset of `agent_runs` shown in the run-picker dropdown. */
interface RunRow {
  run_id: string;
  session_id: string;
  goal: string;
  model: string;
  status: string;
  created_at: number;
}

/** Subset of `generated_documents` for the optional "attach golden artifact" picker. */
interface DocRow {
  doc_id: string;
  title: string;
  doc_type: string;
}

/** Payload returned by `bundles:import` — drives the verification UI below. */
interface ImportResult {
  bundleId: string;
  manifest: {
    bundleId: string;
    exportedAt: string;
    prompt: string;
    model: string;
    sessionTitle: string;
    mcpServers: { name: string; uri: string }[];
    goldenContentHash: string | null;
  };
  signatureValid: boolean;
  stepCount: number;
  artifactNames: string[];
  missingMcpServers: { name: string; uri: string }[];
  extractedDir: string;
}

function relativeTime(unixSec: number): string {
  const diff = Math.floor(Date.now() / 1000) - unixSec;
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

export default function BundlesPanel() {
  const [tab, setTab] = useState<'export' | 'import'>('export');
  const [runs, setRuns] = useState<RunRow[]>([]);
  const [docs, setDocs] = useState<DocRow[]>([]);
  const [selectedRun, setSelectedRun] = useState<string>('');
  const [selectedDoc, setSelectedDoc] = useState<string>('');
  const [exporting, setExporting] = useState(false);
  const [importing, setImporting] = useState(false);
  const [exportStatus, setExportStatus] = useState<string>('');
  const [imported, setImported] = useState<ImportResult | null>(null);

  const load = async () => {
    const [r, d] = await Promise.all([
      window.artha.timetravel.listRuns() as Promise<RunRow[]>,
      window.artha.provenance.listDocs() as Promise<DocRow[]>,
    ]);
    setRuns(r);
    setDocs(d);
    if (r.length && !selectedRun) setSelectedRun(r[0].run_id);
  };

  useEffect(() => { load(); }, []);

  /** Show the system save dialog and write a signed bundle. The status string
   *  doubles as a success/error message under the button. */
  const handleExport = async () => {
    if (!selectedRun) return;
    setExporting(true);
    setExportStatus('');
    try {
      const result = await window.artha.bundles.export(selectedRun, selectedDoc || undefined) as { outPath: string; size: number } | null;
      if (result) {
        setExportStatus(`Bundle written to ${result.outPath} (${Math.round(result.size / 1024)} KB)`);
      }
    } catch (err) {
      setExportStatus(`Export failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setExporting(false);
    }
  };

  /** Open a `.artha-bundle`, verify its signature, extract artifacts, and
   *  report missing MCP servers + the on-disk extracted folder. */
  const handleImport = async () => {
    setImporting(true);
    setImported(null);
    try {
      const result = await window.artha.bundles.import() as ImportResult | null;
      if (result) setImported(result);
    } catch (err) {
      setExportStatus(`Import failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setImporting(false);
    }
  };

  return (
    <div className="flex-1 overflow-y-auto px-8 py-8 max-w-3xl mx-auto w-full">
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg bg-artha-accent/20 flex items-center justify-center">
            <Package size={16} className="text-artha-accent" />
          </div>
          <div>
            <h1 className="text-base font-semibold text-white">Workflow Bundles</h1>
            <p className="text-xs text-artha-muted">Share or replay full agent runs without the cloud.</p>
          </div>
        </div>
        <button onClick={load} className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-artha-border text-artha-muted hover:text-white hover:bg-white/5 text-xs">
          <RefreshCw size={12} /> Refresh
        </button>
      </div>

      <div className="flex gap-1 mb-6 p-1 bg-artha-s2 border border-artha-border rounded-xl w-fit">
        {(['export', 'import'] as const).map(t => (
          <button key={t} onClick={() => setTab(t)}
            className={`px-4 py-1.5 rounded-lg text-sm font-medium transition-colors capitalize
              ${tab === t ? 'bg-artha-accent/20 text-white' : 'text-artha-muted hover:text-white'}`}>
            {t === 'export' ? <><Download size={12} className="inline mr-1.5" /> Export</> : <><Upload size={12} className="inline mr-1.5" /> Import</>}
          </button>
        ))}
      </div>

      {tab === 'export' && (
        <div className="space-y-5">
          <section>
            <label className="block text-xs font-medium text-artha-muted uppercase tracking-wide mb-2">
              <History size={11} className="inline mr-1" /> Run to package
            </label>
            <select
              value={selectedRun}
              onChange={e => setSelectedRun(e.target.value)}
              className="w-full bg-artha-s2 border border-artha-border rounded-lg px-3 py-2 text-sm text-artha-text focus:border-artha-accent/50 focus:outline-none"
            >
              <option value="">Select an agent run…</option>
              {runs.map(r => (
                <option key={r.run_id} value={r.run_id}>
                  {(r.goal || 'No goal').slice(0, 80)} · {r.model} · {relativeTime(r.created_at)}
                </option>
              ))}
            </select>
          </section>

          <section>
            <label className="block text-xs font-medium text-artha-muted uppercase tracking-wide mb-2">
              <FileText size={11} className="inline mr-1" /> Attach golden artifact (optional)
            </label>
            <select
              value={selectedDoc}
              onChange={e => setSelectedDoc(e.target.value)}
              className="w-full bg-artha-s2 border border-artha-border rounded-lg px-3 py-2 text-sm text-artha-text focus:border-artha-accent/50 focus:outline-none"
            >
              <option value="">None</option>
              {docs.map(d => (
                <option key={d.doc_id} value={d.doc_id}>
                  {d.title || 'Untitled'} ({d.doc_type})
                </option>
              ))}
            </select>
            <p className="text-[11px] text-artha-muted mt-1">
              Including a doc lets recipients verify their replay byte-matches yours.
            </p>
          </section>

          <button
            onClick={handleExport}
            disabled={!selectedRun || exporting}
            className="flex items-center gap-2 px-4 py-2 rounded-lg bg-artha-accent hover:bg-artha-accent/80 disabled:opacity-40 text-sm font-medium"
          >
            <Download size={13} /> {exporting ? 'Packaging…' : 'Export bundle'}
          </button>

          {exportStatus && (
            <p className={`text-xs ${exportStatus.startsWith('Bundle') ? 'text-green-400' : 'text-red-400'}`}>
              {exportStatus}
            </p>
          )}
        </div>
      )}

      {tab === 'import' && (
        <div className="space-y-5">
          <button
            onClick={handleImport}
            disabled={importing}
            className="flex items-center gap-2 px-4 py-2 rounded-lg bg-artha-accent hover:bg-artha-accent/80 disabled:opacity-40 text-sm font-medium"
          >
            <Upload size={13} /> {importing ? 'Verifying…' : 'Import .artha-bundle'}
          </button>

          {imported && (
            <div className="space-y-4">
              <div className={`rounded-xl border p-4 flex items-start gap-3 ${
                imported.signatureValid
                  ? 'border-green-500/30 bg-green-500/5'
                  : 'border-red-500/30 bg-red-500/5'
              }`}>
                {imported.signatureValid
                  ? <ShieldCheck size={20} className="text-green-400 mt-0.5" />
                  : <ShieldAlert size={20} className="text-red-400 mt-0.5" />}
                <div className="flex-1">
                  <p className={`text-sm font-semibold ${imported.signatureValid ? 'text-green-400' : 'text-red-400'}`}>
                    {imported.signatureValid ? 'Signature valid' : 'Signature INVALID — bundle has been modified'}
                  </p>
                  <p className="text-xs text-artha-muted mt-1">
                    Bundle <code className="font-mono">{imported.bundleId.slice(0, 12)}…</code> · {imported.stepCount} steps · {imported.artifactNames.length} artifacts
                  </p>
                </div>
              </div>

              <section className="rounded-xl border border-artha-border bg-artha-s2 p-4 space-y-2 text-xs">
                <div className="flex gap-2"><span className="text-artha-muted w-24">Title</span><span className="text-artha-text">{imported.manifest.sessionTitle || '(no title)'}</span></div>
                <div className="flex gap-2"><span className="text-artha-muted w-24">Prompt</span><span className="text-artha-text flex-1">{imported.manifest.prompt}</span></div>
                <div className="flex gap-2"><span className="text-artha-muted w-24">Model</span><code className="font-mono text-artha-text">{imported.manifest.model}</code></div>
                <div className="flex gap-2"><span className="text-artha-muted w-24">Exported</span><span className="text-artha-text">{new Date(imported.manifest.exportedAt).toLocaleString()}</span></div>
                {imported.manifest.goldenContentHash && (
                  <div className="flex gap-2"><span className="text-artha-muted w-24">Golden hash</span><code className="font-mono text-artha-text break-all">{imported.manifest.goldenContentHash}</code></div>
                )}
              </section>

              {imported.missingMcpServers.length > 0 && (
                <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-4">
                  <p className="flex items-center gap-2 text-amber-400 text-sm font-medium mb-2">
                    <AlertTriangle size={14} /> Missing MCP servers
                  </p>
                  <p className="text-xs text-artha-muted mb-2">
                    Install these in the MCP Tools panel to deterministically replay:
                  </p>
                  <ul className="space-y-1">
                    {imported.missingMcpServers.map(s => (
                      <li key={s.name} className="text-xs">
                        <span className="text-artha-text font-medium">{s.name}</span>
                        <code className="ml-2 text-artha-muted/70 font-mono">{s.uri}</code>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              <button
                onClick={() => window.artha.bundles.openExtracted(imported.extractedDir)}
                className="flex items-center gap-2 px-3 py-2 rounded-lg border border-artha-border text-xs text-artha-muted hover:text-white hover:bg-white/5"
              >
                <FolderOpen size={12} /> Open extracted folder
              </button>

              {imported.artifactNames.length > 0 && (
                <section>
                  <p className="text-xs font-medium text-artha-muted uppercase tracking-wide mb-2">Artifacts</p>
                  <ul className="space-y-1 text-xs">
                    {imported.artifactNames.map(n => (
                      <li key={n} className="flex items-center gap-2 text-artha-text">
                        <CheckCircle2 size={11} className="text-green-400" />
                        <code className="font-mono">{n}</code>
                      </li>
                    ))}
                  </ul>
                </section>
              )}
            </div>
          )}

          {!imported && !importing && (
            <p className="text-xs text-artha-muted">
              Pick a <code className="font-mono">.artha-bundle</code> file to verify and extract.
            </p>
          )}

          {exportStatus.startsWith('Import') && (
            <p className="text-xs text-red-400 flex items-center gap-1">
              <XCircle size={11} /> {exportStatus}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
