/**
 * ReceiptsPanel — the verified audit trail of every function call the agent has
 * made. Left: recent runs. Right: each tool call in the selected run with a
 * plain-English effect, a content hash, the governing policy tier, and status
 * (ran / failed / blocked / dry-run). This is the "agents that prove what they
 * did" surface — receipts are recorded locally and never leave the device.
 */
import { useEffect, useState } from 'react';
import {
  ReceiptText, CheckCircle2, XCircle, ShieldX, Eye, FileEdit, Info, Hash,
} from 'lucide-react';

interface RunRow {
  run_id: string;
  goal: string;
  session_id: string;
  calls: number;
  mutations: number;
  ts: number;
}

interface Receipt {
  receipt_id: string;
  run_id: string | null;
  tool_name: string;
  args_json: string;
  effect: string;
  result_hash: string;
  status: 'ok' | 'error' | 'blocked' | 'skipped';
  tier: 'auto' | 'confirm' | 'dry_run' | 'forbid';
  is_mutation: number;
  duration_ms: number;
  ts: number;
}

const STATUS_META: Record<Receipt['status'], { icon: typeof CheckCircle2; color: string; label: string }> = {
  ok:      { icon: CheckCircle2, color: 'text-artha-success', label: 'ran' },
  error:   { icon: XCircle,      color: 'text-artha-danger',  label: 'failed' },
  blocked: { icon: ShieldX,      color: 'text-artha-warn',    label: 'blocked' },
  skipped: { icon: Eye,          color: 'text-artha-accent',  label: 'dry run' },
};

function relativeTime(unixSec: number): string {
  const diff = Math.floor(Date.now() / 1000) - unixSec;
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

export default function ReceiptsPanel() {
  const [runs, setRuns] = useState<RunRow[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [receipts, setReceipts] = useState<Receipt[]>([]);

  useEffect(() => {
    window.artha.receipts.listRuns(50).then((rows) => {
      setRuns(rows as RunRow[]);
      if (rows.length && !selected) setSelected((rows[0] as RunRow).run_id);
    });
  }, []);

  useEffect(() => {
    if (!selected) return;
    window.artha.receipts.listByRun(selected).then(r => setReceipts(r as Receipt[]));
  }, [selected]);

  return (
    <div className="flex-1 flex overflow-hidden">
      {/* Left: run list */}
      <div className="w-72 border-r border-artha-border bg-artha-s2 flex flex-col">
        <div className="px-4 py-4 border-b border-artha-border flex items-center gap-2">
          <div className="w-7 h-7 rounded-lg bg-artha-accent/20 flex items-center justify-center">
            <ReceiptText size={14} className="text-artha-accent" />
          </div>
          <div>
            <h1 className="text-sm font-semibold text-artha-text">Action Receipts</h1>
            <p className="text-[10px] text-artha-muted">{runs.length} recent runs</p>
          </div>
        </div>
        <div className="flex-1 overflow-y-auto p-2 space-y-1">
          {runs.length === 0 && (
            <p className="text-xs text-artha-muted/70 text-center mt-8 px-4">
              Once the agent runs tools, each call is recorded here with proof of what it did.
            </p>
          )}
          {runs.map(r => (
            <button
              key={r.run_id}
              onClick={() => setSelected(r.run_id)}
              className={`w-full text-left px-3 py-2 rounded-lg transition-colors ${
                selected === r.run_id ? 'bg-artha-accent/20 text-artha-text' : 'text-artha-muted hover:bg-artha-text/5 hover:text-artha-text'
              }`}
            >
              <p className="text-xs font-medium truncate">{r.goal || 'Untitled run'}</p>
              <p className="text-[10px] text-artha-muted">
                {r.calls} call{r.calls === 1 ? '' : 's'}
                {r.mutations > 0 && ` · ${r.mutations} changed files`} · {relativeTime(r.ts)}
              </p>
            </button>
          ))}
        </div>
      </div>

      {/* Right: receipts for the selected run */}
      <div className="flex-1 overflow-y-auto px-8 py-6">
        {/* Guidance */}
        <div className="mb-5 rounded-xl border border-artha-accent/30 bg-artha-accent/8 p-3 flex items-start gap-2 max-w-3xl">
          <Info size={14} className="text-artha-accent shrink-0 mt-0.5" />
          <p className="text-xs text-artha-muted leading-relaxed">
            Every function call the agent makes is logged here — including calls that a
            <span className="text-artha-text"> Tool Policy</span> blocked or dry-ran. Each receipt carries the exact effect and a
            content hash so you can verify the agent did what it claims. Nothing here is ever sent off your device.
          </p>
        </div>

        {!selected || receipts.length === 0 ? (
          <div className="text-sm text-artha-muted">Select a run to see its receipts.</div>
        ) : (
          <div className="max-w-3xl space-y-2">
            {receipts.map(rc => {
              const meta = STATUS_META[rc.status];
              const Icon = meta.icon;
              return (
                <div key={rc.receipt_id} className="rounded-xl border border-artha-border bg-artha-s2 p-3">
                  <div className="flex items-center gap-2 mb-1.5">
                    <Icon size={14} className={`${meta.color} shrink-0`} />
                    <code className="text-xs font-mono text-artha-accent">{rc.tool_name}</code>
                    {rc.is_mutation === 1 && (
                      <span className="flex items-center gap-1 text-[10px] text-artha-warn bg-artha-warn/10 border border-artha-warn/30 px-1.5 py-0.5 rounded">
                        <FileEdit size={9} /> changed files
                      </span>
                    )}
                    <span className={`ml-auto text-[10px] uppercase tracking-wide ${meta.color}`}>{meta.label}</span>
                    {rc.tier !== 'auto' && (
                      <span className="text-[10px] text-artha-muted">· {rc.tier} policy</span>
                    )}
                  </div>
                  <p className="text-sm text-artha-text leading-snug">{rc.effect}</p>
                  <div className="flex items-center gap-3 mt-1.5 text-[10px] text-artha-muted">
                    {rc.result_hash && (
                      <span className="flex items-center gap-1 font-mono"><Hash size={9} />{rc.result_hash}</span>
                    )}
                    <span>{rc.duration_ms}ms</span>
                    <span>{relativeTime(rc.ts)}</span>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
