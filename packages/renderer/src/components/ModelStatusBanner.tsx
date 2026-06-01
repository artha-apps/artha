/**
 * ModelStatusBanner — non-blocking startup status for the local model.
 *
 * Artha auto-starts Ollama and pre-warms the active model on launch (see the
 * main-process `ensureModelReady`). This surfaces that work as a small, quiet
 * bottom-left card so the user knows the first message will be fast — and never
 * has to run a terminal command themselves. It auto-dismisses once ready; only
 * the "not installed" and "error" states are persistent (they need action).
 */
import { useEffect, useRef, useState } from 'react';
import { Loader2, CheckCircle2, AlertTriangle, ExternalLink, RefreshCw } from 'lucide-react';

type Phase = 'checking' | 'starting' | 'warming' | 'ready' | 'not_installed' | 'error';
interface ModelStatus { phase: Phase; model?: string; detail?: string }

export default function ModelStatusBanner() {
  const [status, setStatus] = useState<ModelStatus | null>(null);
  const [visible, setVisible] = useState(false);
  const [retrying, setRetrying] = useState(false);
  // True once the user has seen active work — lets us flash a brief "ready"
  // confirmation only when we actually showed a "starting/warming" state.
  const showedWork = useRef(false);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const apply = (s: ModelStatus) => {
      setStatus(s);
      if (hideTimer.current) { clearTimeout(hideTimer.current); hideTimer.current = null; }
      if (s.phase === 'starting' || s.phase === 'warming') {
        showedWork.current = true;
        setVisible(true);
      } else if (s.phase === 'not_installed' || s.phase === 'error') {
        setVisible(true);
      } else if (s.phase === 'ready') {
        // Only confirm if we showed work; otherwise stay silent (already warm).
        if (showedWork.current) {
          setVisible(true);
          hideTimer.current = setTimeout(() => setVisible(false), 2200);
        } else {
          setVisible(false);
        }
      } else {
        // 'checking' is transient — don't flash a banner for it.
        setVisible(false);
      }
    };
    window.artha.llm.getModelStatus().then(apply).catch(() => { /* ignore */ });
    const off = window.artha.llm.onModelStatus(apply);
    return () => { off(); if (hideTimer.current) clearTimeout(hideTimer.current); };
  }, []);

  if (!visible || !status) return null;

  const retry = async () => {
    setRetrying(true);
    try { await window.artha.llm.ensureModel(); } catch { /* status will update via event */ }
    setRetrying(false);
  };

  const { phase, model, detail } = status;

  // Persistent: Ollama not installed → guide to download (can't auto-install).
  if (phase === 'not_installed') {
    return (
      <Card tone="warn" icon={<AlertTriangle size={16} className="text-artha-warn" />}>
        <p className="text-sm font-medium text-artha-text">Ollama isn't installed</p>
        <p className="text-xs text-artha-muted mt-0.5 leading-relaxed">
          Artha runs models locally via Ollama. Install it once, then Artha starts it for you.
        </p>
        <a href="https://ollama.com/download" target="_blank" rel="noreferrer"
          className="mt-2 inline-flex items-center gap-1.5 text-xs text-artha-accent hover:underline">
          Download Ollama <ExternalLink size={11} />
        </a>
      </Card>
    );
  }

  if (phase === 'error') {
    return (
      <Card tone="warn" icon={<AlertTriangle size={16} className="text-artha-warn" />}>
        <p className="text-sm font-medium text-artha-text">Couldn't start the local model</p>
        <p className="text-xs text-artha-muted mt-0.5 leading-relaxed">{detail ?? 'Something went wrong starting Ollama.'}</p>
        <button onClick={retry} disabled={retrying}
          className="mt-2 inline-flex items-center gap-1.5 text-xs text-artha-accent hover:underline disabled:opacity-50">
          <RefreshCw size={11} className={retrying ? 'animate-spin' : ''} /> Try again
        </button>
      </Card>
    );
  }

  if (phase === 'ready') {
    return (
      <Card tone="ok" icon={<CheckCircle2 size={16} className="text-artha-success" />}>
        <p className="text-sm text-artha-text">Local model ready{model ? ` · ${model}` : ''}</p>
      </Card>
    );
  }

  // starting | warming
  const label = phase === 'starting' ? 'Starting your local model…' : `Warming up${model ? ` ${model}` : ''}…`;
  return (
    <Card tone="info" icon={<Loader2 size={16} className="text-artha-accent animate-spin" />}>
      <p className="text-sm text-artha-text">{label}</p>
      <p className="text-xs text-artha-muted mt-0.5">This only takes a few seconds — no setup needed.</p>
    </Card>
  );
}

/** Shared shell: quiet, non-blocking bottom-left card (matches the app's other
 *  ambient notices). */
function Card({ icon, children }: { icon: React.ReactNode; tone: 'info' | 'ok' | 'warn'; children: React.ReactNode }) {
  return (
    <div className="fixed bottom-4 left-4 z-[55] max-w-xs flex items-start gap-3 px-4 py-3 rounded-xl bg-artha-surface border border-artha-border shadow-lifted">
      <span className="mt-0.5 shrink-0">{icon}</span>
      <div className="flex-1 min-w-0">{children}</div>
    </div>
  );
}
