/**
 * SchedulerInbox — run history for scheduled tasks (automations v2).
 *
 * Shows the most recent task_executions with an unread count, a one-line
 * summary per run, "Open run" (the existing run inspector) and "Run now"
 * (fires the task through the same unattended path as a scheduled run).
 * Statuses are rendered exactly as recorded by the main process — the inbox
 * never upgrades an unverified or held run to a success.
 */
import { useCallback, useEffect, useState } from 'react';
import { Inbox, Play, ExternalLink, CheckCheck, RefreshCw } from 'lucide-react';
import { useChatStore } from '../../stores/chat';

/** One task_executions row as returned by `scheduler:executions`. */
export interface TaskExecution {
  exec_id: string;
  task_id: string;
  task_name: string | null;
  status: 'running' | 'ok' | 'error' | 'blocked' | 'unverified' | 'cancelled' | 'held';
  trigger_kind: 'schedule' | 'catchup' | 'folder' | 'webhook' | 'manual';
  started_at: number;
  ended_at: number | null;
  run_id: string | null;
  summary: string | null;
  is_read: number;
  fail_reason: string | null;
}

/** Badge label + colour per honest status. Only 'ok' is green. */
const STATUS_STYLE: Record<TaskExecution['status'], { label: string; cls: string }> = {
  ok:         { label: 'Done',          cls: 'bg-artha-success/15 text-artha-success' },
  error:      { label: 'Failed',        cls: 'bg-artha-danger/15 text-artha-danger' },
  blocked:    { label: 'Needs approval', cls: 'bg-yellow-500/15 text-yellow-400' },
  unverified: { label: 'Not verified',  cls: 'bg-yellow-500/15 text-yellow-400' },
  cancelled:  { label: 'Cancelled',     cls: 'bg-artha-text/10 text-artha-muted' },
  held:       { label: 'On hold',       cls: 'bg-orange-500/15 text-orange-400' },
  running:    { label: 'Running',       cls: 'bg-artha-accent/15 text-artha-accent' },
};

/** Short label for what started the run. */
const TRIGGER_LABEL: Record<TaskExecution['trigger_kind'], string> = {
  schedule: 'scheduled', catchup: 'ran late', folder: 'new file', webhook: 'webhook', manual: 'run now',
};

/** Recent-time formatter for row timestamps. */
function when(ts: number): string {
  return new Date(ts * 1000).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const api = () => (window as any).artha.scheduler;

/** Scheduler inbox panel; `refreshKey` lets the parent force a reload. */
export default function SchedulerInbox({ refreshKey = 0 }: { refreshKey?: number }) {
  const [rows, setRows] = useState<TaskExecution[]>([]);
  const [unread, setUnread] = useState(0);
  const [msg, setMsg] = useState<string | null>(null);
  const { setInspectorRunId } = useChatStore();

  const load = useCallback(async () => {
    try {
      const [list, n] = await Promise.all([api().executions(30), api().unreadCount()]);
      setRows(list as TaskExecution[]);
      setUnread(n as number);
    } catch { /* main process not ready — keep the last view */ }
  }, []);

  useEffect(() => { void load(); }, [load, refreshKey]);
  // Light polling while open so running → finished shows up without a click.
  useEffect(() => {
    const t = setInterval(() => { void load(); }, 15_000);
    return () => clearInterval(t);
  }, [load]);

  const openRun = async (row: TaskExecution) => {
    await api().markRead(row.exec_id);
    if (row.run_id) setInspectorRunId(row.run_id);
    void load();
  };

  const runNow = async (row: TaskExecution) => {
    const r = await api().runNow(row.task_id) as { started: boolean; reason?: string };
    setMsg(r.started ? `Started “${row.task_name ?? 'task'}”.` : r.reason ?? 'Could not start.');
    setTimeout(() => { void load(); }, 1500);
  };

  const markAll = async () => { await api().markRead(); void load(); };

  return (
    <div className="rounded-xl border border-artha-border bg-artha-text/5 p-4 space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Inbox size={16} className="text-artha-accent" />
          <h3 className="text-sm font-semibold text-artha-text">Scheduler inbox</h3>
          {unread > 0 && (
            <span className="px-1.5 py-0.5 rounded-full bg-artha-accent/20 text-artha-accent text-[10px] font-semibold">
              {unread} unread
            </span>
          )}
        </div>
        <div className="flex items-center gap-1">
          <button onClick={() => void load()} title="Refresh" className="p-1.5 rounded-lg hover:bg-artha-text/8 text-artha-muted">
            <RefreshCw size={13} />
          </button>
          {unread > 0 && (
            <button onClick={markAll} title="Mark all read" className="flex items-center gap-1 px-2 py-1 rounded-lg hover:bg-artha-text/8 text-artha-muted text-xs">
              <CheckCheck size={13} /> Mark all read
            </button>
          )}
        </div>
      </div>
      {msg && <p className="text-xs text-artha-muted">{msg}</p>}
      {rows.length === 0 ? (
        <p className="text-xs text-artha-muted py-2">No runs yet. Each scheduled or triggered run will appear here.</p>
      ) : (
        <ul className="divide-y divide-artha-border">
          {rows.map(row => {
            const st = STATUS_STYLE[row.status] ?? STATUS_STYLE.unverified;
            return (
              <li key={row.exec_id} className="py-2 flex items-start gap-3">
                <span className={`mt-1.5 h-1.5 w-1.5 rounded-full shrink-0 ${row.is_read ? 'bg-transparent' : 'bg-artha-accent'}`} />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 text-xs">
                    <span className="font-medium text-artha-text truncate">{row.task_name ?? 'Deleted task'}</span>
                    <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${st.cls}`}>{st.label}</span>
                    <span className="text-artha-muted">{TRIGGER_LABEL[row.trigger_kind] ?? row.trigger_kind} · {when(row.started_at)}</span>
                  </div>
                  <p className="text-xs text-artha-muted mt-0.5 truncate" title={row.summary ?? ''}>
                    {row.summary ?? (row.status === 'running' ? 'In progress…' : '—')}
                  </p>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  {row.run_id && (
                    <button onClick={() => void openRun(row)} title="Open run" className="p-1.5 rounded-lg hover:bg-artha-text/8 text-artha-muted hover:text-artha-text">
                      <ExternalLink size={13} />
                    </button>
                  )}
                  {row.task_name && (
                    <button onClick={() => void runNow(row)} title="Run now" className="p-1.5 rounded-lg hover:bg-artha-text/8 text-artha-muted hover:text-artha-text">
                      <Play size={13} />
                    </button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
