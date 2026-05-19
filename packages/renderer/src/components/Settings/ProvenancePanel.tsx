/**
 * ProvenancePanel — browse every generated artifact and inspect its lineage.
 * Left: list of generated docs. Right: anchors + receipt for the selected doc.
 */
import { useEffect, useState } from 'react';
import {
  ShieldCheck, FileText, FileSpreadsheet, Presentation, File,
  Database, Wrench, Sparkles, User, ExternalLink, Copy, Check,
} from 'lucide-react';

/** One row in the left-side artifact list — matches `generated_documents`. */
interface DocRow {
  doc_id: string;
  file_path: string;
  doc_type: 'docx' | 'pptx' | 'xlsx' | 'pdf';
  title: string;
  model: string;
  content_hash: string;
  created_at: number;
}

/** One anchor (section/cell/slide) inside a doc — matches `provenance_records`. */
interface AnchorRow {
  anchor_id: string;
  source_type: 'rag' | 'tool' | 'llm' | 'user';
  source_ref: string;
  excerpt: string;
}

/** The sidecar `.artha-receipt.json` shape, mirrored from the doc generator. */
interface Receipt {
  schema: string;
  docId: string;
  filePath: string;
  docType: string;
  title: string;
  prompt: string;
  promptHash: string;
  contentHash: string;
  model: string;
  createdAt: string;
  anchors: { anchor: string; type: string; ref: string; excerpt: string }[];
}

const TYPE_ICON: Record<DocRow['doc_type'], React.ElementType> = {
  docx: FileText,
  pptx: Presentation,
  xlsx: FileSpreadsheet,
  pdf: File,
};

const SOURCE_ICON: Record<AnchorRow['source_type'], React.ElementType> = {
  rag: Database,
  tool: Wrench,
  llm: Sparkles,
  user: User,
};

const SOURCE_COLOR: Record<AnchorRow['source_type'], string> = {
  rag: 'text-blue-400 bg-blue-400/10',
  tool: 'text-violet-400 bg-violet-400/10',
  llm: 'text-amber-400 bg-amber-400/10',
  user: 'text-green-400 bg-green-400/10',
};

function relativeTime(unixSec: number): string {
  const diff = Math.floor(Date.now() / 1000) - unixSec;
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

export default function ProvenancePanel() {
  const [docs, setDocs] = useState<DocRow[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [anchors, setAnchors] = useState<AnchorRow[]>([]);
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const [copied, setCopied] = useState('');

  useEffect(() => {
    window.artha.provenance.listDocs().then((rows) => {
      setDocs(rows as DocRow[]);
      if (rows.length && !selectedId) setSelectedId((rows[0] as DocRow).doc_id);
    });
  }, []);

  useEffect(() => {
    if (!selectedId) return;
    Promise.all([
      window.artha.provenance.listAnchors(selectedId),
      window.artha.provenance.getReceipt(selectedId),
    ]).then(([a, r]) => {
      setAnchors(a as AnchorRow[]);
      setReceipt(r as Receipt | null);
    });
  }, [selectedId]);

  const copy = async (label: string, value: string) => {
    await navigator.clipboard.writeText(value);
    setCopied(label);
    setTimeout(() => setCopied(''), 1500);
  };

  return (
    <div className="flex-1 flex overflow-hidden">
      {/* Left: doc list */}
      <div className="w-72 border-r border-artha-border bg-artha-s2 flex flex-col">
        <div className="px-4 py-4 border-b border-artha-border flex items-center gap-2">
          <div className="w-7 h-7 rounded-lg bg-artha-accent/20 flex items-center justify-center">
            <ShieldCheck size={14} className="text-artha-accent" />
          </div>
          <div>
            <h1 className="text-sm font-semibold text-white">Provenance</h1>
            <p className="text-[10px] text-artha-muted">{docs.length} generated artifacts</p>
          </div>
        </div>
        <div className="flex-1 overflow-y-auto p-2 space-y-1">
          {docs.length === 0 && (
            <p className="text-xs text-artha-muted/70 text-center mt-8 px-4">
              Generated documents will appear here with their source lineage.
            </p>
          )}
          {docs.map(d => {
            const Icon = TYPE_ICON[d.doc_type];
            return (
              <button
                key={d.doc_id}
                onClick={() => setSelectedId(d.doc_id)}
                className={`w-full text-left flex items-start gap-2 px-3 py-2 rounded-lg transition-colors ${
                  selectedId === d.doc_id
                    ? 'bg-artha-accent/20 text-white'
                    : 'text-artha-muted hover:bg-white/5 hover:text-white'
                }`}
              >
                <Icon size={13} className="mt-0.5 shrink-0 opacity-70" />
                <div className="min-w-0 flex-1">
                  <p className="text-xs font-medium truncate">{d.title || 'Untitled'}</p>
                  <p className="text-[10px] text-artha-muted truncate">
                    {d.doc_type} · {relativeTime(d.created_at)}
                  </p>
                </div>
              </button>
            );
          })}
        </div>
      </div>

      {/* Right: detail */}
      <div className="flex-1 overflow-y-auto px-8 py-8">
        {!receipt && (
          <div className="h-full flex items-center justify-center text-artha-muted text-sm">
            Select an artifact to view its provenance.
          </div>
        )}

        {receipt && (
          <div className="max-w-3xl space-y-6">
            {/* Header */}
            <div>
              <h2 className="text-lg font-semibold text-white mb-1">{receipt.title || 'Untitled'}</h2>
              <p className="text-xs text-artha-muted font-mono break-all">{receipt.filePath}</p>
              <div className="flex items-center gap-2 mt-2">
                <button
                  onClick={() => window.artha.docs.openFile(receipt.filePath)}
                  className="flex items-center gap-1.5 px-2.5 py-1 rounded-md border border-artha-border text-xs text-artha-muted hover:text-white hover:bg-white/5 transition-colors"
                >
                  <ExternalLink size={11} /> Open file
                </button>
                <button
                  onClick={() => window.artha.docs.openFile(receipt.filePath + '.artha-receipt.json')}
                  className="flex items-center gap-1.5 px-2.5 py-1 rounded-md border border-artha-border text-xs text-artha-muted hover:text-white hover:bg-white/5 transition-colors"
                >
                  <ExternalLink size={11} /> Open receipt
                </button>
              </div>
            </div>

            {/* Receipt summary */}
            <section className="rounded-xl border border-artha-border bg-artha-s2 p-4 space-y-2 text-xs">
              <div className="flex items-center gap-2">
                <span className="text-artha-muted w-24 shrink-0">Model</span>
                <code className="font-mono text-artha-text">{receipt.model}</code>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-artha-muted w-24 shrink-0">Generated</span>
                <span className="text-artha-text">{new Date(receipt.createdAt).toLocaleString()}</span>
              </div>
              <div className="flex items-start gap-2">
                <span className="text-artha-muted w-24 shrink-0">Content hash</span>
                <div className="flex-1 flex items-center gap-2 min-w-0">
                  <code className="font-mono text-artha-text break-all flex-1">{receipt.contentHash}</code>
                  <button
                    onClick={() => copy('content', receipt.contentHash)}
                    className="text-artha-muted hover:text-white shrink-0"
                  >
                    {copied === 'content' ? <Check size={11} className="text-green-400" /> : <Copy size={11} />}
                  </button>
                </div>
              </div>
              <div className="flex items-start gap-2">
                <span className="text-artha-muted w-24 shrink-0">Prompt hash</span>
                <code className="font-mono text-artha-text break-all">{receipt.promptHash}</code>
              </div>
              <div className="flex items-start gap-2">
                <span className="text-artha-muted w-24 shrink-0">Prompt</span>
                <p className="text-artha-text flex-1">{receipt.prompt}</p>
              </div>
            </section>

            {/* Anchors */}
            <section>
              <div className="flex items-center gap-2 mb-3">
                <ShieldCheck size={13} className="text-artha-accent" />
                <h3 className="text-xs font-semibold text-artha-muted uppercase tracking-wide">
                  Provenance anchors
                </h3>
                <span className="text-xs text-artha-muted">({anchors.length})</span>
              </div>
              <div className="space-y-2">
                {anchors.map(a => {
                  const Icon = SOURCE_ICON[a.source_type];
                  return (
                    <div key={a.anchor_id} className="rounded-xl border border-artha-border bg-artha-s2 p-3">
                      <div className="flex items-center gap-2 mb-2">
                        <span className={`flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-medium ${SOURCE_COLOR[a.source_type]}`}>
                          <Icon size={10} /> {a.source_type}
                        </span>
                        <code className="text-[10px] font-mono text-artha-muted truncate flex-1">{a.source_ref}</code>
                        <code className="text-[10px] font-mono text-artha-muted/60 shrink-0">{a.anchor_id.slice(0, 12)}…</code>
                      </div>
                      <p className="text-xs text-artha-text leading-relaxed">{a.excerpt}</p>
                    </div>
                  );
                })}
              </div>
            </section>
          </div>
        )}
      </div>
    </div>
  );
}
