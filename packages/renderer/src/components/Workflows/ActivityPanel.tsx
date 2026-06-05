/**
 * ActivityPanel — the "Runs" section of the Workflows hub. A persistent, in-app
 * list of recent agent runs across EVERY surface (Chat, Delegate, Scheduled,
 * sub-capability) with status + receipt counts. This is the history the
 * transient "Artha is working" glow could never give you: background and
 * delegated work is visible after the fact, and each row opens the Run
 * Inspector (receipts + step trace) for that exact run.
 */
import { useEffect, useState } from 'react';
import { Activity, CheckCircle2, XCircle, Loader, Ban, RefreshCw, FileEdit, ChevronRight } from 'lucide-react';
import { useChatStore } from '../../stores/chat';

interface Run {
  run_id: string; session_id: string; goal: string; status: 'running' | 'completed' | 'failed' | 'cancelled';
  parent_run_id: string | null; created_at: number;
  session_title: string; session_origin: string; calls: number; mutations: number;
}

const STATUS_META: Record<Run['status'], { icon: typeof CheckCircle2; color: string }> = {
  running:   { icon: Loader,       color: 'text-artha-accent' },
  completed: { icon: CheckCircle2, color: 'text-artha-success' },
  failed:    { icon: XCircle,      color: 'text-artha-danger' },
  cancelled: { icon: Ban,          color: 'text-artha-muted' },
};

/** A human label for where a run came from. */
function originLabel(r: Run): string {
  if (r.parent_run_id) return 'sub-task';
  if (r.session_title.startsWith('Scheduled:')) return 'scheduled';
  if (r.session_origin === 'delegate') return 'delegate';
  return 'chat';
}

function relativeTime(unixSec: number): string {
  const diff = Math.floor(Date.now() / 1000) - unixSec;
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

export default function ActivityPanel() {
  const { setInspectorRunId, isStreaming } = useChatStore();
  const [runs, setRuns] = useState<Run[]>([]);
  const [loading, setLoading] = useState(true);

  const load = () => window.artha.runs.listRecent(80).then(r => { setRuns(r as Run[]); setLoading(false); });

  useEffect(() => { load(); }, []);
  // A run just finished (stream ended) — refresh so the new row appears without
  // a manual reload. Also catches Delegate/scheduled runs that complete while
  // this panel is open.
  useEffect(() => { if (!isStreaming) load(); }, [isStreaming]);

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-3xl mx-auto px-8 py-8">
        <div className="flex items-center gap-3 mb-1">
          <Activity size={20} className="text-artha-accent" />
          <h1 className="text-lg font-semibold text-artha-text">Runs</h1>
          <button
            onClick={load}
            className="ml-auto flex items-center gap-1.5 text-xs text-artha-muted hover:text-artha-text transition-colors"
          >
            <RefreshCw size={12} /> Refresh
          </button>
        </div>
        <p className="text-sm text-artha-muted mb-6">
          Everything Artha has run recently — chats, delegated tasks, scheduled jobs, and sub-tasks. Click a run to see exactly what it did.
        </p>

        {loading ? (
          <p className="text-sm text-artha-muted">Loading…</p>
        ) : runs.length === 0 ? (
          <p className="text-sm text-artha-muted/70">No runs yet. Ask Artha to do something and it'll show up here.</p>
        ) : (
          <div className="space-y-2">
            {runs.map(r => {
              const meta = STATUS_META[r.status];
              const Icon = meta.icon;
              return (
                <button
                  key={r.run_id}
                  onClick={() => setInspectorRunId(r.run_id)}
                  className="w-full text-left flex items-center gap-3 px-4 py-3 rounded-xl bg-artha-s2 border border-artha-border hover:border-artha-accent/50 transition-colors group"
                >
                  <Icon size={15} className={`${meta.color} shrink-0 ${r.status === 'running' ? 'animate-spin' : ''}`} />
                  <div className="min-w-0 flex-1">
                    <p className="text-sm text-artha-text truncate">{r.goal || r.session_title || 'Untitled run'}</p>
                    <p className="text-[11px] text-artha-muted">
                      <span className="uppercase tracking-wide">{originLabel(r)}</span>
                      {' · '}{r.calls} call{r.calls === 1 ? '' : 's'}
                      {r.mutations > 0 && <span className="text-artha-warn"> · <FileEdit size={9} className="inline -mt-0.5" /> {r.mutations} changed</span>}
                      {' · '}{relativeTime(r.created_at)}
                    </p>
                  </div>
                  <ChevronRight size={14} className="text-artha-subtle group-hover:text-artha-accent shrink-0 transition-colors" />
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
