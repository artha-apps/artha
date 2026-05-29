/**
 * Onboarding — first-run guided setup. Shown as a full-screen overlay until the
 * user has a working model (or explicitly skips). Three steps:
 *   1. Detect the Ollama runtime (with install help if it's missing).
 *   2. Recommend + pull a starter model sized to the machine's RAM (live
 *      progress), or pick one already installed.
 *   3. Activate and finish — persists `onboardingComplete` so it never reappears.
 *
 * This kills the biggest first-run drop-off: a blank app that does nothing
 * because no model is configured.
 */
import { useEffect, useState } from 'react';
import { Bot, Download, CheckCircle2, RefreshCw, ExternalLink, Cpu, ArrowRight, Cloud } from 'lucide-react';

/** A model returned by `window.artha.llm.listModels()` — only fields we render. */
interface OllamaModel { name: string; size: number; }

/** Hardware snapshot from `window.artha.llm.detectHardware()`.
 *  `recommendation` is a human-readable label ("8 GB — good for 7B models");
 *  `recommendedModel` is the Ollama tag to pull (e.g. "llama3.2:3b"). */
interface HardwareInfo { gbRam: number; recommendation: string; recommendedModel: string; }

/**
 * Onboarding — full-screen first-run wizard.
 * @param onDone - Called after `onboardingComplete` is persisted to settings.
 *   App.tsx flips `showOnboarding` to false, unmounting this overlay.
 */
export default function Onboarding({ onDone }: { onDone: () => void }) {
  const [ollamaOnline, setOllamaOnline] = useState<boolean | null>(null);
  const [checking, setChecking] = useState(false);
  const [hardware, setHardware] = useState<HardwareInfo | null>(null);
  const [models, setModels] = useState<OllamaModel[]>([]);
  const [pulling, setPulling] = useState(false);
  const [progress, setProgress] = useState<{ percent?: number; status: string } | null>(null);
  const [error, setError] = useState('');

  const refresh = async () => {
    setChecking(true);
    try {
      const online = await window.artha.llm.checkOllama();
      setOllamaOnline(online);
      if (online) {
        const [hw, list] = await Promise.all([
          window.artha.llm.detectHardware() as Promise<HardwareInfo>,
          window.artha.llm.listModels() as Promise<OllamaModel[]>,
        ]);
        setHardware(hw);
        setModels(list);
      }
    } finally {
      setChecking(false);
    }
  };

  useEffect(() => { refresh(); }, []);

  // Subscribe to live pull progress.
  useEffect(() => {
    const off = window.artha.llm.onPullProgress((p) => {
      if (p.error) { setError(p.error); return; }
      setProgress({ percent: p.percent, status: p.status });
    });
    return () => { off(); };
  }, []);

  /** Persist the chosen model as the active model, mark onboarding done, and
   *  close the overlay. The flag prevents the overlay from showing on next launch. */
  const finishWith = async (modelName: string) => {
    await window.artha.llm.setActiveModel(modelName);
    await window.artha.settings.set({ onboardingComplete: true });
    onDone();
  };

  /** Pull the hardware-recommended model. Progress is streamed via the
   *  `llm:pullProgress` IPC channel (subscribed above) and reflected in
   *  `progress` state. On success, immediately activates and finishes. */
  const pullRecommended = async () => {
    if (!hardware) return;
    const model = hardware.recommendedModel;
    setPulling(true);
    setError('');
    setProgress({ status: 'starting', percent: 0 });
    try {
      const ok = await window.artha.llm.pullModelStream(model);
      if (ok) {
        await finishWith(model);
      } else if (!error) {
        setError('Download failed. Check your connection and try again.');
      }
    } finally {
      setPulling(false);
    }
  };

  const skip = async () => {
    await window.artha.settings.set({ onboardingComplete: true });
    onDone();
  };

  return (
    <div className="fixed inset-0 z-[100] bg-artha-surface/95 backdrop-blur-sm flex items-center justify-center px-6">
      <div className="w-full max-w-lg bg-artha-s2 border border-artha-border rounded-2xl shadow-2xl p-8">
        {/* Header */}
        <div className="flex flex-col items-center text-center mb-6">
          <div className="w-14 h-14 rounded-2xl bg-artha-accent/20 border border-artha-accent/20 flex items-center justify-center mb-4">
            <Bot size={26} className="text-artha-accent" />
          </div>
          <h1 className="text-xl font-semibold text-white mb-1">Welcome to Artha</h1>
          <p className="text-sm text-artha-muted">Let's get a local AI model running. This stays 100% on your machine.</p>
        </div>

        {/* Step 1: Ollama check */}
        {ollamaOnline === false && (
          <div className="space-y-4">
            <div className="bg-amber-500/10 border border-amber-500/20 rounded-xl p-4">
              <p className="text-sm text-white font-medium mb-1">Ollama isn't running</p>
              <p className="text-xs text-artha-muted leading-relaxed mb-3">
                Artha uses <span className="text-white">Ollama</span> to run models locally. Install it, then start it
                with <code className="bg-black/30 px-1.5 py-0.5 rounded font-mono">ollama serve</code>.
              </p>
              <a href="https://ollama.com/download" target="_blank" rel="noreferrer"
                className="inline-flex items-center gap-1.5 text-xs text-artha-accent hover:underline">
                Download Ollama <ExternalLink size={11} />
              </a>
            </div>
            <div className="flex gap-2">
              <button onClick={refresh} disabled={checking}
                className="flex items-center gap-1.5 px-4 py-2 rounded-lg bg-artha-accent hover:bg-artha-accent/80 text-sm font-medium transition-colors disabled:opacity-40">
                <RefreshCw size={13} className={checking ? 'animate-spin' : ''} /> Recheck
              </button>
              <button onClick={skip} className="px-4 py-2 rounded-lg text-sm text-artha-muted hover:text-white hover:bg-white/5 transition-colors">
                Skip for now
              </button>
            </div>
          </div>
        )}

        {ollamaOnline === null && (
          <div className="flex items-center justify-center py-8 text-artha-muted text-sm gap-2">
            <RefreshCw size={14} className="animate-spin" /> Checking for Ollama…
          </div>
        )}

        {/* Step 2: model setup */}
        {ollamaOnline === true && hardware && (
          <div className="space-y-4">
            <div className="flex items-center gap-2 text-xs text-artha-muted bg-artha-surface border border-artha-border rounded-lg px-3 py-2">
              <Cpu size={13} className="text-artha-accent" /> {hardware.gbRam} GB RAM detected · {hardware.recommendation}
            </div>

            {pulling ? (
              <div className="bg-artha-surface border border-artha-border rounded-xl p-4">
                <div className="flex items-center gap-2 mb-2">
                  <Download size={14} className="text-artha-accent" />
                  <span className="text-sm text-white">Downloading {hardware.recommendedModel}…</span>
                </div>
                <div className="h-2 bg-black/30 rounded-full overflow-hidden">
                  <div className="h-full bg-artha-accent transition-all"
                    style={{ width: `${progress?.percent ?? 5}%` }} />
                </div>
                <p className="text-xs text-artha-muted mt-2 capitalize">
                  {progress?.status ?? 'starting'}{progress?.percent != null ? ` · ${progress.percent}%` : ''}
                </p>
              </div>
            ) : (
              <>
                {/* Already-installed models */}
                {models.length > 0 && (
                  <div className="space-y-2">
                    <p className="text-xs font-medium text-artha-muted uppercase tracking-wide">Use an installed model</p>
                    {models.slice(0, 4).map(m => (
                      <button key={m.name} onClick={() => finishWith(m.name)}
                        className="w-full flex items-center gap-3 px-4 py-3 rounded-xl bg-artha-surface border border-artha-border hover:border-artha-accent/40 hover:bg-artha-accent/5 transition-all text-left">
                        <CheckCircle2 size={15} className="text-green-400 shrink-0" />
                        <span className="text-sm text-white flex-1 truncate">{m.name}</span>
                        <ArrowRight size={14} className="text-artha-muted shrink-0" />
                      </button>
                    ))}
                  </div>
                )}

                {/* Recommended pull */}
                <div className="pt-1">
                  {models.length > 0 && (
                    <p className="text-xs font-medium text-artha-muted uppercase tracking-wide mb-2">Or download the recommended model</p>
                  )}
                  <button onClick={pullRecommended}
                    className="w-full flex items-center gap-3 px-4 py-3 rounded-xl bg-artha-accent/15 border border-artha-accent/30 hover:bg-artha-accent/25 transition-all text-left">
                    <Download size={16} className="text-artha-accent shrink-0" />
                    <span className="flex-1 min-w-0">
                      <span className="block text-sm font-medium text-white truncate">{hardware.recommendedModel}</span>
                      <span className="block text-xs text-artha-muted">Best fit for your hardware · downloads once</span>
                    </span>
                  </button>
                </div>

                {error && <p className="text-xs text-red-400">{error}</p>}

                <button onClick={skip} className="w-full text-center text-xs text-artha-muted hover:text-white transition-colors pt-1">
                  Skip — I'll set this up later
                </button>
              </>
            )}
          </div>
        )}

        {/* Footer hint */}
        <div className="mt-6 pt-4 border-t border-artha-border flex items-center justify-center gap-1.5 text-[11px] text-artha-muted">
          <Cloud size={11} /> Prefer a cloud model? Add one anytime in Settings → Models.
        </div>
      </div>
    </div>
  );
}
