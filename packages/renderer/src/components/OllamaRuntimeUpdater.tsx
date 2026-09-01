/**
 * OllamaRuntimeUpdater — install or update the Ollama engine THROUGH Artha.
 *
 * One component, three homes: the Models panel (engine card + "Update Ollama"
 * on a model that needs a newer server), the startup banner ("Ollama isn't
 * installed"), and onboarding's local-setup path. It drives the main-process
 * pipeline (`ollama:runtimeInstall` — pinned official release, SHA-256
 * verified, unpacked under Artha's data dir) and then the consent-gated
 * switch (`ollama:runtimeSwitch`) that makes the managed copy the server.
 *
 * Honesty rules baked in:
 *   - Never claims "updated" until the server on :11434 REPORTS the new
 *     version (the main process verifies this before returning ok).
 *   - Replacing an Ollama that Artha did not start (menubar app, Homebrew,
 *     service) requires an explicit click here, every first time; the copy
 *     says what will happen and that the preference sticks.
 *   - Every failure shows the real reason and a retry — no raw 412s, no
 *     "go download it from a website" as the primary path.
 */
import { useEffect, useRef, useState } from 'react';
import { Download, RefreshCw, CheckCircle2, AlertTriangle, ShieldCheck, X } from 'lucide-react';

type Report = Awaited<ReturnType<typeof window.artha.llm.runtimeReport>>;
type Progress = Parameters<Parameters<typeof window.artha.llm.onRuntimeProgress>[0]>[0];

type Stage =
  | { kind: 'idle' }
  | { kind: 'working'; progress: Progress }
  | { kind: 'consent'; version: string; externalVersion: string | null }
  | { kind: 'switching'; version: string }
  | { kind: 'done'; version: string }
  | { kind: 'error'; message: string; retryable: boolean };

interface Props {
  /** 'card' = full engine card with version line; 'inline' = compact button + progress. */
  variant?: 'card' | 'inline';
  /** Kick off the update as soon as the component mounts / this flips true. */
  autoStart?: boolean;
  /** Called after the managed runtime is verified running (or already current). */
  onDone?: (version: string) => void;
  /** Called whenever the runtime report is (re)loaded — lets parents gate UI. */
  onReport?: (r: Report) => void;
  className?: string;
}

function fmtBytes(n?: number): string {
  if (!n || n <= 0) return '';
  const mb = n / (1024 * 1024);
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`;
}

export default function OllamaRuntimeUpdater({ variant = 'card', autoStart = false, onDone, onReport, className = '' }: Props) {
  const [report, setReport] = useState<Report | null>(null);
  const [stage, setStage] = useState<Stage>({ kind: 'idle' });
  const started = useRef(false);

  const loadReport = async () => {
    try {
      const r = await window.artha.llm.runtimeReport();
      setReport(r);
      onReport?.(r);
      return r;
    } catch {
      return null;
    }
  };

  useEffect(() => { void loadReport(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const off = window.artha.llm.onRuntimeProgress((p) => {
      if (p.phase === 'error' || p.phase === 'cancelled' || p.phase === 'installed') return; // terminal states come from the invoke result
      setStage({ kind: 'working', progress: p });
    });
    return () => { off(); };
  }, []);

  /** Step 2 — make the managed copy the running server. */
  const activate = async (allowStopExternal: boolean, version: string) => {
    setStage({ kind: 'switching', version });
    const res = await window.artha.llm.runtimeSwitch({ allowStopExternal });
    if (res.ok) {
      setStage({ kind: 'done', version: res.version });
      await loadReport();
      onDone?.(res.version);
      return;
    }
    if (res.reason === 'external_running') {
      const r = await loadReport();
      setStage({ kind: 'consent', version, externalVersion: r?.serverVersion ?? null });
      return;
    }
    setStage({ kind: 'error', message: res.detail, retryable: true });
  };

  /** Step 1 — download + verify + unpack, then try to activate. */
  const start = async () => {
    setStage({ kind: 'working', progress: { phase: 'resolving' } });
    const res = await window.artha.llm.runtimeInstall();
    if (!res.ok) {
      setStage(res.cancelled ? { kind: 'idle' } : { kind: 'error', message: res.error, retryable: true });
      return;
    }
    // Try without stopping anything first; the consent step appears only if
    // an Ollama Artha did not start is holding the port.
    await activate(false, res.version);
  };

  useEffect(() => {
    if (autoStart && !started.current) { started.current = true; void start(); }
  }, [autoStart]); // eslint-disable-line react-hooks/exhaustive-deps

  const cancel = () => { void window.artha.llm.runtimeCancel(); };

  // ── Render pieces ────────────────────────────────────────────────────────
  const serverLine = report
    ? report.serverReachable
      ? `Ollama ${report.serverVersion ?? '(version unknown)'}${report.serverIsManaged ? ' · managed by Artha' : report.externalServerRunning ? ' · started outside Artha' : ''}`
      : report.managed ? `Ollama ${report.managed.version} installed by Artha (not running)` : 'Ollama is not installed'
    : 'Checking Ollama…';

  const primaryLabel = report && !report.serverReachable && !report.managed
    ? 'Install Ollama through Artha'
    : `Update to Ollama ${report?.pinned.version ?? ''}`.trim();

  const body = (() => {
    switch (stage.kind) {
      case 'working': {
        const p = stage.progress;
        const label =
          p.phase === 'resolving' ? 'Checking the latest tested release…' :
          p.phase === 'downloading' ? `Downloading Ollama ${p.version ?? ''} — ${fmtBytes(p.receivedBytes)}${p.totalBytes ? ` of ${fmtBytes(p.totalBytes)}` : ''}` :
          p.phase === 'verifying' ? 'Verifying the download (SHA-256)…' :
          p.phase === 'extracting' ? 'Unpacking…' : 'Working…';
        return (
          <div className="mt-2 space-y-1.5">
            <div className="flex items-center gap-2 text-xs text-artha-muted">
              <RefreshCw size={11} className="animate-spin shrink-0" />
              <span className="truncate">{label}</span>
              {p.phase === 'downloading' && (
                <button onClick={cancel} className="ml-auto inline-flex items-center gap-1 text-[11px] text-artha-muted hover:text-artha-text">
                  <X size={10} /> Cancel
                </button>
              )}
            </div>
            {typeof p.percent === 'number' && (
              <div className="h-1 rounded-full bg-artha-text/8">
                <div className="h-1 rounded-full bg-artha-accent transition-all" style={{ width: `${p.percent}%` }} />
              </div>
            )}
          </div>
        );
      }
      case 'consent':
        return (
          <div className="mt-2 rounded-lg border border-amber-500/25 bg-amber-500/10 p-3 space-y-2">
            <p className="text-xs text-artha-text leading-relaxed">
              Ollama {stage.version} is downloaded and verified. An older Ollama{stage.externalVersion ? ` (${stage.externalVersion})` : ''} is
              running on this machine that Artha didn't start — usually the Ollama menubar app.
            </p>
            <p className="text-xs text-artha-muted leading-relaxed">
              Switch now and Artha will quit it and run its own copy, and keep doing so if the old one comes back at login.
              Your models stay where they are; nothing is uninstalled.
            </p>
            <div className="flex items-center gap-2">
              <button onClick={() => activate(true, stage.version)}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-artha-accent hover:bg-artha-accent-hover text-xs font-medium text-artha-on-accent transition-colors">
                <ShieldCheck size={12} /> Switch to Ollama {stage.version}
              </button>
              <button onClick={() => setStage({ kind: 'idle' })}
                className="px-3 py-1.5 rounded-lg border border-artha-border text-xs text-artha-muted hover:text-artha-text transition-colors">
                Not now
              </button>
            </div>
          </div>
        );
      case 'switching':
        return (
          <p className="mt-2 flex items-center gap-2 text-xs text-artha-muted">
            <RefreshCw size={11} className="animate-spin" /> Starting Ollama {stage.version}…
          </p>
        );
      case 'done':
        return (
          <p className="mt-2 flex items-center gap-1.5 text-xs text-artha-success">
            <CheckCircle2 size={13} /> Ollama {stage.version} is running — managed by Artha.
          </p>
        );
      case 'error':
        return (
          <div className="mt-2 space-y-1.5">
            <p className="flex items-start gap-1.5 text-xs text-artha-danger leading-relaxed">
              <AlertTriangle size={13} className="shrink-0 mt-0.5" /> <span>{stage.message}</span>
            </p>
            {stage.retryable && (
              <button onClick={start} className="inline-flex items-center gap-1.5 text-xs text-artha-accent hover:underline">
                <RefreshCw size={11} /> Try again
              </button>
            )}
          </div>
        );
      default: {
        if (!report) return null;
        const canOffer = report.platformSupported && (report.updateAvailable || (!report.serverReachable && !!report.managed));
        if (!canOffer) {
          return report.platformSupported
            ? <p className="mt-1 flex items-center gap-1.5 text-xs text-artha-success"><CheckCircle2 size={12} /> Up to date (latest tested release {report.pinned.version}).</p>
            : <p className="mt-1 text-xs text-artha-muted">Artha can't install Ollama automatically on this platform yet — install it from ollama.com and Artha will use it.</p>;
        }
        const restart = !report.serverReachable && !!report.managed && !report.updateAvailable;
        return (
          <button onClick={restart ? () => activate(true, report.managed!.version) : start}
            className="mt-2 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-artha-accent/15 hover:bg-artha-accent/25 text-artha-accent text-xs font-medium transition-colors">
            <Download size={12} /> {restart ? `Start Ollama ${report.managed!.version}` : primaryLabel}
          </button>
        );
      }
    }
  })();

  if (variant === 'inline') return <div className={className}>{body}</div>;

  return (
    <div className={`rounded-xl border border-artha-border bg-artha-s2 p-4 ${className}`}>
      <div className="flex items-center gap-2">
        <ShieldCheck size={14} className="text-artha-accent shrink-0" />
        <p className="text-sm font-medium text-artha-text">Ollama engine</p>
      </div>
      <p className="text-xs text-artha-muted mt-1">{serverLine}</p>
      {body}
    </div>
  );
}
