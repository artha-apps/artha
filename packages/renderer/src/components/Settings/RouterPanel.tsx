/**
 * RouterPanel — Adaptive model router. Benchmark all local Ollama models on
 * 3 canonical tasks (plan / tool_args / synthesis), see latency + quality
 * scores, and optionally pin a specific model for a given task type.
 */
import { useEffect, useState } from 'react';
import {
  Route, Zap, Play, RefreshCw, Trophy, Clock, Brain,
  Wrench, Sparkles, Pin, PinOff,
} from 'lucide-react';

/** Aligned with the backend `TaskType` union and `model_profiles.task_type`. */
type TaskType = 'plan' | 'tool_args' | 'synthesis';

/** One benchmark result row — model × task. Sorted DESC by quality. */
interface Profile {
  ollama_name: string;
  task_type: TaskType;
  latency_ms: number;
  quality: number;
  benchmarked_at: number;
}

/** A user-pinned override (one allowed per task type). */
interface Override {
  task_type: TaskType;
  ollama_name: string;
}

const TASK_INFO: Record<TaskType, { icon: React.ElementType; label: string; description: string; color: string }> = {
  plan: { icon: Brain, label: 'Plan', description: 'Decomposing user requests into steps', color: 'text-violet-400 bg-violet-400/10' },
  tool_args: { icon: Wrench, label: 'Tool args', description: 'JSON tool-call argument generation', color: 'text-cyan-400 bg-cyan-400/10' },
  synthesis: { icon: Sparkles, label: 'Synthesis', description: 'Doc generation, summaries, follow-ups', color: 'text-amber-400 bg-amber-400/10' },
};

function relativeTime(unixSec: number): string {
  const diff = Math.floor(Date.now() / 1000) - unixSec;
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

export default function RouterPanel() {
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [overrides, setOverrides] = useState<Override[]>([]);
  const [benchmarking, setBenchmarking] = useState(false);
  const [progress, setProgress] = useState<string>('');

  const load = async () => {
    const [p, o] = await Promise.all([
      window.artha.router.listProfiles() as Promise<Profile[]>,
      window.artha.router.listOverrides() as Promise<Override[]>,
    ]);
    setProfiles(p);
    setOverrides(o);
  };

  useEffect(() => {
    load();
    const off = window.artha.router.onBenchmarkProgress(setProgress);
    return () => { off(); };
  }, []);

  /** Kick off the full per-model probe. Progress messages stream in via the
   *  `onBenchmarkProgress` IPC subscription set up in the mount effect. */
  const runBench = async () => {
    setBenchmarking(true);
    setProgress('Starting benchmark…');
    try {
      const report = await window.artha.router.benchmark() as { models: string[]; durationMs: number };
      setProgress(`Benchmarked ${report.models.length} models in ${(report.durationMs / 1000).toFixed(1)}s`);
      await load();
    } catch (err) {
      setProgress(`Failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBenchmarking(false);
    }
  };

  const setOverride = async (task: TaskType, model: string | null) => {
    await window.artha.router.setOverride(task, model);
    await load();
  };

  /** All profiles for one task type — already sorted best→worst by the backend. */
  const byTask = (task: TaskType) =>
    profiles.filter(p => p.task_type === task);

  /** The user's pinned model for `task`, or null when auto-selection is on. */
  const currentOverride = (task: TaskType) =>
    overrides.find(o => o.task_type === task)?.ollama_name ?? null;

  /** Top-ranked model the router would auto-pick for `task` (=`byTask(...)[0]`). */
  const autoBest = (task: TaskType): string | null =>
    byTask(task)[0]?.ollama_name ?? null;

  return (
    <div className="flex-1 overflow-y-auto px-8 py-8 max-w-3xl mx-auto w-full">
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg bg-artha-accent/20 flex items-center justify-center">
            <Route size={16} className="text-artha-accent" />
          </div>
          <div>
            <h1 className="text-base font-semibold text-white">Adaptive Router</h1>
            <p className="text-xs text-artha-muted">Right model for the job, not the biggest one.</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={load}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-artha-border text-artha-muted hover:text-white hover:bg-white/5 text-xs">
            <RefreshCw size={12} /> Refresh
          </button>
          <button onClick={runBench} disabled={benchmarking}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-artha-accent hover:bg-artha-accent/80 disabled:opacity-40 text-xs font-medium">
            {benchmarking ? <RefreshCw size={12} className="animate-spin" /> : <Play size={12} />}
            {benchmarking ? 'Benchmarking…' : 'Run benchmark'}
          </button>
        </div>
      </div>

      {progress && (
        <div className="mb-6 px-3 py-2 rounded-lg bg-artha-s2 border border-artha-border text-xs text-artha-text font-mono">
          {progress}
        </div>
      )}

      {profiles.length === 0 && !benchmarking && (
        <div className="text-center py-16 bg-artha-s2 border border-dashed border-artha-border rounded-xl">
          <Zap size={32} className="mx-auto mb-3 text-artha-muted opacity-30" />
          <p className="text-sm text-artha-text font-medium mb-1">No benchmark data yet</p>
          <p className="text-xs text-artha-muted">
            Run a benchmark to profile every Ollama model on planning, tool-arg generation, and synthesis.
          </p>
        </div>
      )}

      <div className="space-y-8">
        {(Object.keys(TASK_INFO) as TaskType[]).map(task => {
          const info = TASK_INFO[task];
          const Icon = info.icon;
          const rows = byTask(task);
          const override = currentOverride(task);
          const best = autoBest(task);
          if (!rows.length) return null;
          return (
            <section key={task}>
              <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-2">
                  <span className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium ${info.color}`}>
                    <Icon size={12} /> {info.label}
                  </span>
                  <p className="text-xs text-artha-muted">{info.description}</p>
                </div>
                <div className="text-[11px] text-artha-muted">
                  {override
                    ? <span className="text-artha-accent">Pinned: <code className="font-mono">{override}</code></span>
                    : <span>Auto: <code className="font-mono">{best ?? 'none'}</code></span>}
                </div>
              </div>
              <div className="rounded-xl border border-artha-border bg-artha-s2 divide-y divide-artha-border">
                {rows.map((r, i) => {
                  const pinned = override === r.ollama_name;
                  return (
                    <div key={r.ollama_name + r.task_type} className="flex items-center gap-3 px-4 py-2.5 text-xs">
                      {i === 0 && <Trophy size={12} className="text-amber-400 shrink-0" />}
                      {i !== 0 && <span className="w-3" />}
                      <code className="font-mono text-artha-text flex-1 truncate">{r.ollama_name}</code>
                      <div className="flex items-center gap-1 text-artha-muted">
                        <Clock size={10} /> {r.latency_ms}ms
                      </div>
                      <div className="w-20 h-1.5 bg-artha-surface rounded-full overflow-hidden">
                        <div
                          className="h-full bg-artha-accent"
                          style={{ width: `${Math.round(r.quality * 100)}%` }}
                        />
                      </div>
                      <span className="text-artha-muted w-10 text-right">{Math.round(r.quality * 100)}%</span>
                      <button
                        onClick={() => setOverride(task, pinned ? null : r.ollama_name)}
                        title={pinned ? 'Unpin (use auto)' : 'Pin this model for this task'}
                        className={`p-1 rounded transition-colors ${
                          pinned ? 'text-artha-accent' : 'text-artha-muted hover:text-white'
                        }`}
                      >
                        {pinned ? <PinOff size={12} /> : <Pin size={12} />}
                      </button>
                    </div>
                  );
                })}
              </div>
              {rows[0] && (
                <p className="text-[10px] text-artha-muted/70 mt-1.5 px-1">
                  Last benchmarked {relativeTime(rows[0].benchmarked_at)}
                </p>
              )}
            </section>
          );
        })}
      </div>
    </div>
  );
}
