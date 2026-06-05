/**
 * TimeTravelPanel — rewind any ReAct run, inspect each step, fork from a step
 * to replay with a different model. Left: run list. Right: step timeline.
 */
import { useEffect, useState } from 'react';
import {
  History, GitBranch, MessageSquare, Wrench, Sparkles, Brain,
  CheckCircle2, XCircle, Play, Loader2, RefreshCw,
} from 'lucide-react';

/** Mirrors `agent_runs`. `parent_run_id` non-null = this run was forked. */
interface RunRow {
  run_id: string;
  session_id: string;
  workflow_id: string;
  parent_run_id: string | null;
  forked_from_step: string | null;
  goal: string;
  model: string;
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  created_at: number;
}

/** One row from `agent_steps`. `has_snapshot=1` means a messages_snapshot
 *  was captured here — required for forking from this point. */
interface StepRow {
  step_id: string;
  idx: number;
  kind: 'system' | 'user' | 'assistant' | 'tool_call' | 'tool_result' | 'final';
  payload: string;
  ts: number;
  has_snapshot: number;
}

/** Minimal Ollama model row used to populate the "swap model on replay" dropdown. */
interface OllamaModel {
  name: string;
}

const KIND_ICON: Record<StepRow['kind'], React.ElementType> = {
  system: Brain,
  user: MessageSquare,
  assistant: Sparkles,
  tool_call: Wrench,
  tool_result: CheckCircle2,
  final: CheckCircle2,
};

const KIND_COLOR: Record<StepRow['kind'], string> = {
  system: 'text-artha-muted bg-artha-text/5',
  user: 'text-artha-success bg-artha-success/10',
  assistant: 'text-amber-400 bg-amber-400/10',
  tool_call: 'text-violet-400 bg-violet-400/10',
  tool_result: 'text-artha-accent bg-artha-accent/10',
  final: 'text-artha-accent bg-artha-accent/10',
};

function relativeTime(unixSec: number): string {
  const diff = Math.floor(Date.now() / 1000) - unixSec;
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

/** Render a one-line preview of a step for the timeline. Tries to surface
 *  the most actionable bit (tool name + args, assistant content, etc.) and
 *  falls back to raw JSON when the payload doesn't match any known shape. */
function summariseStep(step: StepRow): string {
  try {
    const p = JSON.parse(step.payload);
    if (step.kind === 'tool_call') return `${p.name}(${(p.args ?? '').slice(0, 80)})`;
    if (step.kind === 'tool_result') return `${p.name} → ${(p.result ?? '').slice(0, 80)}`;
    if (step.kind === 'assistant') {
      if (p.tool_calls?.length) return `→ ${p.tool_calls.length} tool call(s)`;
      return (p.content ?? '').slice(0, 120);
    }
    if (step.kind === 'final') return (p.content ?? p.reason ?? p.error ?? '').slice(0, 120);
    if (step.kind === 'system') return p.note ?? '';
    return JSON.stringify(p).slice(0, 100);
  } catch { return step.payload.slice(0, 100); }
}

/**
 * Time Travel panel — master-detail view of past agent runs.
 * Left sidebar lists `agent_runs` (newest first). Right panel shows the step-by-step
 * ReAct trace and allows forking from any snapshot step to replay with a different model.
 */
export default function TimeTravelPanel() {
  // ── State ──────────────────────────────────────────────────────────────────
  const [runs, setRuns] = useState<RunRow[]>([]);
  // `selectedRun` drives the step timeline; auto-set to the newest run on mount.
  const [selectedRun, setSelectedRun] = useState<string | null>(null);
  const [steps, setSteps] = useState<StepRow[]>([]);
  // Model list for the "swap model on fork" dropdown.
  const [models, setModels] = useState<string[]>([]);
  // `forkingFrom` is the step_id with the inline Fork UI expanded.
  const [forkingFrom, setForkingFrom] = useState<string | null>(null);
  // Optional model override for the forked run; empty string = keep active model.
  const [forkModel, setForkModel] = useState('');
  const [loading, setLoading] = useState(false);

  // ── Effects ────────────────────────────────────────────────────────────────

  /** Load runs and available models in parallel; auto-select the most recent run. */
  const load = async () => {
    setLoading(true);
    try {
      const [r, m] = await Promise.all([
        window.artha.timetravel.listRuns() as Promise<RunRow[]>,
        window.artha.llm.listModels() as Promise<OllamaModel[]>,
      ]);
      setRuns(r);
      setModels(m.map(x => x.name));
      if (r.length && !selectedRun) setSelectedRun(r[0].run_id);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  // Fetch steps whenever the user selects a different run in the sidebar.
  useEffect(() => {
    if (!selectedRun) return;
    window.artha.timetravel.getSteps(selectedRun).then(s => setSteps(s as StepRow[]));
  }, [selectedRun]);

  /** Replay the run from a captured-snapshot step. The orchestrator returns the
   *  new run id which we auto-select so the user sees the fresh trace. */
  const fork = async (stepId: string) => {
    const newRun = await window.artha.timetravel.fork(stepId, forkModel || undefined);
    setForkingFrom(null);
    setForkModel('');
    await load();
    if (newRun) setSelectedRun(newRun as string);
  };

  const selected = runs.find(r => r.run_id === selectedRun);

  return (
    <div className="flex-1 flex overflow-hidden">
      {/* Left: run list */}
      <div className="w-80 border-r border-artha-border bg-artha-s2 flex flex-col">
        <div className="px-4 py-4 border-b border-artha-border flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="w-7 h-7 rounded-lg bg-artha-accent/20 flex items-center justify-center">
              <History size={14} className="text-artha-accent" />
            </div>
            <div>
              <h1 className="text-sm font-semibold text-artha-text">Time Travel</h1>
              <p className="text-[10px] text-artha-muted">{runs.length} agent runs</p>
            </div>
          </div>
          <button onClick={load} disabled={loading} className="text-artha-muted hover:text-artha-text">
            <RefreshCw size={12} className={loading ? 'animate-spin' : ''} />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-2 space-y-1">
          {runs.length === 0 && (
            <p className="text-xs text-artha-muted/70 text-center mt-8 px-4">
              Agent runs will appear here. Send a message in chat to create one.
            </p>
          )}
          {runs.map(r => (
            <button
              key={r.run_id}
              onClick={() => setSelectedRun(r.run_id)}
              className={`w-full text-left flex items-start gap-2 px-3 py-2 rounded-lg transition-colors ${
                selectedRun === r.run_id
                  ? 'bg-artha-accent/20 text-artha-text'
                  : 'text-artha-muted hover:bg-artha-text/5 hover:text-artha-text'
              }`}
            >
              {r.parent_run_id
                ? <GitBranch size={13} className="mt-0.5 shrink-0 text-violet-400" />
                : <MessageSquare size={13} className="mt-0.5 shrink-0 opacity-70" />}
              <div className="min-w-0 flex-1">
                <p className="text-xs font-medium truncate">{r.goal || 'No goal'}</p>
                <div className="flex items-center gap-2 text-[10px] text-artha-muted mt-0.5">
                  <span>{relativeTime(r.created_at)}</span>
                  <span className="opacity-50">·</span>
                  <span className="truncate">{r.model}</span>
                  {r.status === 'failed' && <XCircle size={9} className="text-artha-danger" />}
                  {r.status === 'cancelled' && <XCircle size={9} className="text-amber-400" />}
                </div>
              </div>
            </button>
          ))}
        </div>
      </div>

      {/* Right: steps timeline */}
      <div className="flex-1 overflow-y-auto px-8 py-8">
        {!selected && (
          <div className="h-full flex items-center justify-center text-artha-muted text-sm">
            Select a run to inspect its steps.
          </div>
        )}

        {selected && (
          <div className="max-w-4xl">
            <div className="mb-6">
              <h2 className="text-lg font-semibold text-artha-text mb-1">{selected.goal}</h2>
              <div className="flex items-center gap-3 text-xs text-artha-muted">
                <code className="font-mono">{selected.model}</code>
                <span>·</span>
                <span>{steps.length} steps</span>
                {selected.parent_run_id && (
                  <>
                    <span>·</span>
                    <span className="flex items-center gap-1 text-violet-400">
                      <GitBranch size={10} /> forked
                    </span>
                  </>
                )}
              </div>
            </div>

            <div className="space-y-2">
              {steps.map(step => {
                const Icon = KIND_ICON[step.kind];
                const isForking = forkingFrom === step.step_id;
                return (
                  <div key={step.step_id} className="rounded-xl border border-artha-border bg-artha-s2">
                    <div className="flex items-start gap-3 px-4 py-3">
                      <div className={`mt-0.5 px-1.5 py-0.5 rounded text-[10px] font-mono font-semibold ${KIND_COLOR[step.kind]}`}>
                        <Icon size={10} className="inline mr-0.5" /> {step.kind}
                      </div>
                      <code className="text-[10px] font-mono text-artha-muted/60 mt-1 shrink-0">#{step.idx}</code>
                      <p className="flex-1 text-xs text-artha-text leading-relaxed font-mono break-all">
                        {summariseStep(step)}
                      </p>
                      {step.has_snapshot === 1 && (
                        <button
                          onClick={() => setForkingFrom(step.step_id)}
                          className="shrink-0 flex items-center gap-1 px-2 py-1 rounded-md border border-artha-border text-[10px] text-artha-muted hover:text-violet-400 hover:border-violet-400/40 transition-colors"
                          title="Fork from this step"
                        >
                          <GitBranch size={10} /> Fork
                        </button>
                      )}
                    </div>
                    {isForking && (
                      <div className="px-4 pb-4 border-t border-artha-border/40 pt-3 space-y-2">
                        <p className="text-[11px] text-artha-muted">
                          Replay from this step. Optionally swap the model:
                        </p>
                        <select
                          value={forkModel}
                          onChange={e => setForkModel(e.target.value)}
                          className="w-full bg-artha-surface border border-artha-border rounded-lg px-2 py-1.5 text-xs text-artha-text focus:border-artha-accent/50 focus:outline-none"
                        >
                          <option value="">Use active model</option>
                          {models.map(m => <option key={m} value={m}>{m}</option>)}
                        </select>
                        <div className="flex gap-2">
                          <button
                            onClick={() => fork(step.step_id)}
                            className="flex items-center gap-1 px-3 py-1.5 rounded-lg bg-artha-accent hover:bg-artha-accent/80 text-xs font-medium"
                          >
                            <Play size={11} /> Replay
                          </button>
                          <button
                            onClick={() => { setForkingFrom(null); setForkModel(''); }}
                            className="px-3 py-1.5 rounded-lg text-xs text-artha-muted hover:text-artha-text hover:bg-artha-text/5"
                          >
                            Cancel
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
              {steps.length === 0 && (
                <div className="text-xs text-artha-muted py-8 text-center">
                  <Loader2 size={18} className="mx-auto mb-2 animate-spin opacity-50" />
                  Loading steps…
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
