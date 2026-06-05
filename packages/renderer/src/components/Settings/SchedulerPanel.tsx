/**
 * SchedulerPanel — create, edit, and manage scheduled agent tasks.
 *
 * Supports both repeating (cron) and one-shot (fire_at) schedules.
 * Each task runs the agent with its stored prompt in a new session.
 */
import { useEffect, useState } from 'react';
import { Clock, Plus, Trash2, Play, Pause, RefreshCw, Calendar, AlertCircle, CheckCircle2 } from 'lucide-react';

interface ScheduledTask {
  task_id: string;
  name: string;
  prompt: string;
  cron: string | null;
  fire_at: number | null;
  is_enabled: number;
  last_run_at: number | null;
  last_status: string | null;
  run_count: number;
  created_at: number;
}

// Pre-built cron expressions shown as clickable pills. The empty `value` for
// "Custom…" triggers the free-text cron input below the grid.
const CRON_PRESETS = [
  { label: 'Every morning at 8 AM', value: '0 8 * * *' },
  { label: 'Every weekday at 9 AM', value: '0 9 * * 1-5' },
  { label: 'Every hour', value: '0 * * * *' },
  { label: 'Every Monday at 9 AM', value: '0 9 * * 1' },
  { label: 'Every day at noon', value: '0 12 * * *' },
  { label: 'Custom…', value: '' },
];

function timeAgo(ts: number | null): string {
  if (!ts) return 'Never';
  const diff = Math.floor(Date.now() / 1000) - ts;
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

function fireAtLocal(ts: number): string {
  return new Date(ts * 1000).toLocaleString();
}

/** Scheduled tasks panel — create cron or one-shot tasks that run the agent. */
export default function SchedulerPanel() {
  // ── State ──────────────────────────────────────────────────────────────────
  const [tasks, setTasks] = useState<ScheduledTask[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [saving, setSaving] = useState(false);

  // ── Form state (new task) ──────────────────────────────────────────────────
  const [name, setName] = useState('');
  const [prompt, setPrompt] = useState('');
  // `scheduleType` controls which sub-form is shown: cron preset picker or datetime input.
  const [scheduleType, setScheduleType] = useState<'cron' | 'once'>('cron');
  const [cronPreset, setCronPreset] = useState(CRON_PRESETS[0].value);
  // `cronCustom` is only used when the user selects "Custom…" from the preset grid.
  const [cronCustom, setCronCustom] = useState('');
  const [fireAtInput, setFireAtInput] = useState('');

  const load = async () => {
    setLoading(true);
    try {
      const list = await (window as any).artha.scheduler.list() as ScheduledTask[];
      setTasks(list);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const resetForm = () => {
    setName(''); setPrompt('');
    setScheduleType('cron');
    setCronPreset(CRON_PRESETS[0].value);
    setCronCustom(''); setFireAtInput('');
    setShowForm(false);
  };

  /** Validate form state, build a scheduler payload, and call `scheduler:create`. */
  const handleCreate = async () => {
    if (!name.trim() || !prompt.trim()) return;
    setSaving(true);
    try {
      const cron = scheduleType === 'cron' ? (cronPreset || cronCustom) : undefined;
      // Convert the datetime-local string to a Unix epoch second for the backend.
      const fire_at = scheduleType === 'once' && fireAtInput
        ? Math.floor(new Date(fireAtInput).getTime() / 1000)
        : undefined;
      if (!cron && !fire_at) { alert('Please set a schedule.'); return; }
      await (window as any).artha.scheduler.create({ name: name.trim(), prompt: prompt.trim(), cron, fire_at });
      resetForm();
      await load();
    } finally {
      setSaving(false);
    }
  };

  const handleToggle = async (task: ScheduledTask) => {
    await (window as any).artha.scheduler.toggle(task.task_id, !task.is_enabled);
    await load();
  };

  const handleDelete = async (taskId: string) => {
    if (!confirm('Delete this scheduled task?')) return;
    await (window as any).artha.scheduler.remove(taskId);
    await load();
  };

  return (
    <div className="p-6 max-w-3xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Clock className="text-artha-accent" size={22} />
          <div>
            <h2 className="text-lg font-semibold text-artha-text">Scheduled Tasks</h2>
            <p className="text-sm text-artha-muted">Run the agent automatically on a schedule or at a specific time.</p>
          </div>
        </div>
        <button
          onClick={() => setShowForm(v => !v)}
          className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-artha-accent/10 hover:bg-artha-accent/20 text-artha-accent text-sm font-medium transition-colors"
        >
          <Plus size={15} /> New Task
        </button>
      </div>

      {/* Create form */}
      {showForm && (
        <div className="rounded-xl border border-artha-border bg-artha-text/5 p-4 space-y-4">
          <h3 className="text-sm font-semibold text-artha-text">Create Scheduled Task</h3>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <label className="text-xs text-artha-muted">Task name</label>
              <input
                value={name}
                onChange={e => setName(e.target.value)}
                placeholder="Morning briefing"
                className="w-full bg-black/30 border border-artha-border rounded-lg px-3 py-2 text-sm text-artha-text placeholder-artha-muted focus:outline-none focus:border-artha-accent/50"
              />
            </div>
            <div className="space-y-1">
              <label className="text-xs text-artha-muted">Schedule type</label>
              <div className="flex gap-2">
                {(['cron', 'once'] as const).map(t => (
                  <button
                    key={t}
                    onClick={() => setScheduleType(t)}
                    className={`flex-1 py-2 rounded-lg text-sm font-medium transition-colors ${scheduleType === t ? 'bg-artha-accent/20 text-artha-accent border border-artha-accent/30' : 'bg-black/20 text-artha-muted border border-artha-border hover:text-artha-text'}`}
                  >
                    {t === 'cron' ? 'Repeating' : 'One-time'}
                  </button>
                ))}
              </div>
            </div>
          </div>

          <div className="space-y-1">
            <label className="text-xs text-artha-muted">Prompt (what the agent will do)</label>
            <textarea
              value={prompt}
              onChange={e => setPrompt(e.target.value)}
              rows={3}
              placeholder="Research today's top AI news and write a summary to ~/Desktop/briefing.md"
              className="w-full bg-black/30 border border-artha-border rounded-lg px-3 py-2 text-sm text-artha-text placeholder-artha-muted focus:outline-none focus:border-artha-accent/50 resize-none"
            />
          </div>

          {scheduleType === 'cron' ? (
            <div className="space-y-2">
              <label className="text-xs text-artha-muted">Repeat schedule</label>
              <div className="grid grid-cols-3 gap-2">
                {CRON_PRESETS.map(p => (
                  <button
                    key={p.label}
                    onClick={() => setCronPreset(p.value)}
                    className={`px-3 py-1.5 rounded-lg text-xs text-left transition-colors ${cronPreset === p.value && p.value !== '' ? 'bg-artha-accent/20 text-artha-accent border border-artha-accent/30' : 'bg-black/20 text-artha-muted border border-artha-border hover:text-artha-text'}`}
                  >
                    {p.label}
                  </button>
                ))}
              </div>
              {(cronPreset === '' || !CRON_PRESETS.find(p => p.value === cronPreset && p.value !== '')) && (
                <input
                  value={cronCustom}
                  onChange={e => setCronCustom(e.target.value)}
                  placeholder="0 8 * * 1-5   (custom cron expression)"
                  className="w-full bg-black/30 border border-artha-border rounded-lg px-3 py-2 text-sm text-artha-text placeholder-artha-muted font-mono focus:outline-none focus:border-artha-accent/50"
                />
              )}
            </div>
          ) : (
            <div className="space-y-1">
              <label className="text-xs text-artha-muted">Run at (date & time)</label>
              <input
                type="datetime-local"
                value={fireAtInput}
                onChange={e => setFireAtInput(e.target.value)}
                className="bg-black/30 border border-artha-border rounded-lg px-3 py-2 text-sm text-artha-text focus:outline-none focus:border-artha-accent/50"
              />
            </div>
          )}

          <div className="flex gap-2 justify-end">
            <button onClick={resetForm} className="px-3 py-1.5 rounded-lg bg-artha-text/5 hover:bg-artha-text/8 text-artha-muted text-sm transition-colors">Cancel</button>
            <button
              onClick={handleCreate}
              disabled={saving || !name.trim() || !prompt.trim()}
              className="px-4 py-1.5 rounded-lg bg-artha-accent/20 hover:bg-artha-accent/30 text-artha-accent text-sm font-medium transition-colors disabled:opacity-40"
            >
              {saving ? 'Saving…' : 'Create Task'}
            </button>
          </div>
        </div>
      )}

      {/* Task list */}
      {loading ? (
        <div className="flex items-center gap-2 text-artha-muted text-sm py-4">
          <RefreshCw size={14} className="animate-spin" /> Loading…
        </div>
      ) : tasks.length === 0 ? (
        <div className="text-center py-12 text-artha-muted">
          <Clock size={40} className="mx-auto mb-3 opacity-30" />
          <p className="text-sm">No scheduled tasks yet.</p>
          <p className="text-xs mt-1">Create one to run the agent automatically.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {tasks.map(task => (
            <div key={task.task_id} className={`rounded-xl border p-4 transition-colors ${task.is_enabled ? 'border-artha-border bg-artha-text/5' : 'border-artha-border bg-artha-text/5 opacity-60'}`}>
              <div className="flex items-start justify-between gap-3">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    {task.last_status === 'ok' && <CheckCircle2 size={13} className="text-artha-success shrink-0" />}
                    {task.last_status === 'error' && <AlertCircle size={13} className="text-artha-danger shrink-0" />}
                    {task.last_status === 'running' && <RefreshCw size={13} className="text-yellow-400 animate-spin shrink-0" />}
                    <span className="text-sm font-medium text-artha-text truncate">{task.name}</span>
                  </div>
                  <p className="text-xs text-artha-muted mt-0.5 truncate">{task.prompt}</p>
                  <div className="flex items-center gap-3 mt-2 text-xs text-artha-muted">
                    {task.cron ? (
                      <span className="flex items-center gap-1"><RefreshCw size={10} /> {task.cron}</span>
                    ) : task.fire_at ? (
                      <span className="flex items-center gap-1"><Calendar size={10} /> {fireAtLocal(task.fire_at)}</span>
                    ) : null}
                    <span>Last run: {timeAgo(task.last_run_at)}</span>
                    <span>Runs: {task.run_count}</span>
                  </div>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <button
                    onClick={() => handleToggle(task)}
                    title={task.is_enabled ? 'Pause' : 'Resume'}
                    className="p-1.5 rounded-lg hover:bg-artha-text/8 text-artha-muted hover:text-artha-text transition-colors"
                  >
                    {task.is_enabled ? <Pause size={14} /> : <Play size={14} />}
                  </button>
                  <button
                    onClick={() => handleDelete(task.task_id)}
                    title="Delete"
                    className="p-1.5 rounded-lg hover:bg-artha-danger/20 text-artha-muted hover:text-artha-danger transition-colors"
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
