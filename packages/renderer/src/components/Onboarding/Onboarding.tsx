/**
 * Onboarding — first-run guided setup. Shown as a full-screen overlay until the
 * user has a working model (or explicitly skips).
 *
 * Forked flow (added with the licensing/team SKUs):
 *   Step 0 — persona pick: Individual (B2C) vs Organization admin (B2B).
 *     • Individual → existing Ollama+model flow, with an optional Pro license
 *       paste at the top.
 *     • Organization → OrgSetup sub-flow (license → start hub → provision seats).
 *
 * This kills the biggest first-run drop-off (a blank app that does nothing
 * because no model is configured) and also splits the funnel cleanly between
 * the two commercial motions without confusing either audience.
 */
import { useEffect, useState } from 'react';
import {
  Bot, Download, CheckCircle2, RefreshCw, ExternalLink, Cpu, ArrowRight,
  Cloud, User, Building2, KeyRound,
} from 'lucide-react';
import OrgSetup from './OrgSetup';

/** A model returned by `window.artha.llm.listModels()` — only fields we render. */
interface OllamaModel { name: string; size: number; }

/** Hardware snapshot from `window.artha.llm.detectHardware()`.
 *  `recommendation` is a human-readable label ("8 GB — good for 7B models");
 *  `recommendedModel` is the Ollama tag to pull (e.g. "llama3.2:3b"). */
interface HardwareInfo { gbRam: number; recommendation: string; recommendedModel: string; }

type Persona = 'individual' | 'org_admin' | null;

/**
 * Onboarding — full-screen first-run wizard.
 * @param onDone - Called after `onboardingComplete` is persisted to settings.
 *   App.tsx flips `showOnboarding` to false, unmounting this overlay.
 */
export default function Onboarding({ onDone }: { onDone: () => void }) {
  const [persona, setPersona] = useState<Persona>(null);

  // Individual-path state (existing flow).
  const [ollamaOnline, setOllamaOnline] = useState<boolean | null>(null);
  const [checking, setChecking] = useState(false);
  const [hardware, setHardware] = useState<HardwareInfo | null>(null);
  const [models, setModels] = useState<OllamaModel[]>([]);
  const [pulling, setPulling] = useState(false);
  const [progress, setProgress] = useState<{ percent?: number; status: string } | null>(null);
  const [error, setError] = useState('');
  // True only when Ollama isn't installed at all — the one case Artha can't fix
  // itself (we can't silently install a system dependency).
  const [notInstalled, setNotInstalled] = useState(false);

  // Optional individual-tier license: paste here OR ignore to stay Free.
  const [indivLicense, setIndivLicense] = useState('');
  const [indivLicenseStatus, setIndivLicenseStatus] = useState<'idle' | 'applied' | 'error'>('idle');
  const [indivLicenseError, setIndivLicenseError] = useState('');

  const refresh = async () => {
    setChecking(true);
    try {
      let online = await window.artha.llm.checkOllama();
      if (!online) {
        // Artha starts Ollama itself — the user is never told to run a command.
        // `not_installed` is the only case we can't fix automatically.
        const st = await window.artha.llm.ensureModel();
        setNotInstalled(st.phase === 'not_installed');
        online = await window.artha.llm.checkOllama();
      } else {
        setNotInstalled(false);
      }
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

  // Only kick off Ollama discovery once the user picks Individual — the org
  // admin path doesn't need a local model on the admin's machine (the hub
  // host does, but that's a separate machine in the canonical deployment).
  useEffect(() => { if (persona === 'individual') refresh(); }, [persona]);

  // Subscribe to live pull progress.
  useEffect(() => {
    const off = window.artha.llm.onPullProgress((p) => {
      if (p.error) { setError(p.error); return; }
      setProgress({ percent: p.percent, status: p.status });
    });
    return () => { off(); };
  }, []);

  /** Persist persona + model + onboardingComplete and close the overlay. */
  const finishWith = async (modelName: string) => {
    await window.artha.llm.setActiveModel(modelName);
    await window.artha.settings.set({ persona: 'individual', onboardingComplete: true });
    onDone();
  };

  const applyIndivLicense = async () => {
    setIndivLicenseStatus('idle'); setIndivLicenseError('');
    const res = await window.artha.license.apply(indivLicense.trim());
    if (!res.ok) {
      setIndivLicenseStatus('error');
      setIndivLicenseError(res.error);
    } else {
      setIndivLicenseStatus('applied');
      setIndivLicense('');
    }
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
    await window.artha.settings.set({ persona: persona ?? 'individual', onboardingComplete: true });
    onDone();
  };

  return (
    <div className="fixed inset-0 z-[100] bg-artha-surface/95 backdrop-blur-sm flex items-center justify-center px-6">
      {/* Step 0 — persona picker */}
      {persona === null && (
        <div className="w-full max-w-lg bg-artha-s2 border border-artha-border rounded-2xl shadow-2xl p-8">
          <div className="flex flex-col items-center text-center mb-6">
            <div className="w-14 h-14 rounded-2xl bg-artha-accent/20 border border-artha-accent/20 flex items-center justify-center mb-4">
              <Bot size={26} className="text-artha-accent" />
            </div>
            <h1 className="text-xl font-semibold text-artha-text mb-1">Welcome to Artha</h1>
            <p className="text-sm text-artha-muted">How are you using Artha?</p>
          </div>

          <div className="space-y-3">
            <button onClick={() => setPersona('individual')}
              className="w-full flex items-start gap-3 px-4 py-3 rounded-xl bg-artha-surface border border-artha-border hover:border-artha-accent/40 hover:bg-artha-accent/5 transition-all text-left">
              <User size={18} className="text-artha-accent shrink-0 mt-0.5" />
              <span className="flex-1">
                <span className="block text-sm font-medium text-artha-text">Just me</span>
                <span className="block text-xs text-artha-muted">Local-first solo setup. Pick a model and go. Optional Pro license unlocks team features later.</span>
              </span>
              <ArrowRight size={14} className="text-artha-muted shrink-0 mt-1" />
            </button>

            <button onClick={() => setPersona('org_admin')}
              className="w-full flex items-start gap-3 px-4 py-3 rounded-xl bg-artha-surface border border-artha-border hover:border-artha-accent/40 hover:bg-artha-accent/5 transition-all text-left">
              <Building2 size={18} className="text-artha-accent shrink-0 mt-0.5" />
              <span className="flex-1">
                <span className="block text-sm font-medium text-artha-text">Setting up for my organization</span>
                <span className="block text-xs text-artha-muted">Enterprise hub on this machine. Apply org license, start the hub, provision seats for teammates.</span>
              </span>
              <ArrowRight size={14} className="text-artha-muted shrink-0 mt-1" />
            </button>
          </div>

          <div className="mt-6 pt-4 border-t border-artha-border text-center">
            <button onClick={skip} className="text-[11px] text-artha-muted hover:text-artha-text transition-colors">
              Skip setup — I'll configure later
            </button>
          </div>
        </div>
      )}

      {/* Organization admin sub-flow */}
      {persona === 'org_admin' && (
        <OrgSetup onDone={onDone} onBack={() => setPersona(null)} />
      )}

      {/* Individual flow — existing Ollama+model steps */}
      {persona === 'individual' && (
        <div className="w-full max-w-lg bg-artha-s2 border border-artha-border rounded-2xl shadow-2xl p-8">
          <div className="flex items-center justify-between mb-6">
            <button onClick={() => setPersona(null)} className="text-xs text-artha-muted hover:text-artha-text transition-colors">← Back</button>
            <span className="text-[11px] uppercase tracking-wide text-artha-muted">Solo setup</span>
          </div>

          <div className="flex flex-col items-center text-center mb-6">
            <div className="w-14 h-14 rounded-2xl bg-artha-accent/20 border border-artha-accent/20 flex items-center justify-center mb-4">
              <Bot size={26} className="text-artha-accent" />
            </div>
            <h1 className="text-xl font-semibold text-artha-text mb-1">Let's get you running</h1>
            <p className="text-sm text-artha-muted">Pick a local model. This stays 100% on your machine.</p>
          </div>

          {/* Optional Pro license (collapsible — quiet by default) */}
          <details className="mb-4 rounded-xl bg-artha-surface border border-artha-border">
            <summary className="cursor-pointer px-4 py-2 text-xs text-artha-muted hover:text-artha-text flex items-center gap-1.5">
              <KeyRound size={12} /> Have a license key? (optional)
            </summary>
            <div className="px-4 pb-3 space-y-2">
              <input
                value={indivLicense}
                onChange={e => setIndivLicense(e.target.value)}
                placeholder="Paste your Pro license token"
                className="w-full font-mono text-xs px-3 py-2 rounded-lg bg-artha-s2 border border-artha-border focus:border-artha-accent focus:outline-none text-artha-text"
              />
              {indivLicenseStatus === 'applied' && <p className="text-xs text-green-400">License applied. Team features unlocked.</p>}
              {indivLicenseStatus === 'error' && <p className="text-xs text-red-400">{indivLicenseError}</p>}
              <button onClick={applyIndivLicense} disabled={!indivLicense.trim()}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-artha-accent hover:bg-artha-accent/80 text-xs font-medium text-white transition-colors disabled:opacity-40">
                Apply
              </button>
            </div>
          </details>

          {/* Step 1: Ollama. Artha starts it for the user automatically — the
              only manual step is a one-time install if Ollama is missing. */}
          {ollamaOnline === false && (
            <div className="space-y-4">
              {notInstalled ? (
                <div className="bg-amber-500/10 border border-amber-500/20 rounded-xl p-4">
                  <p className="text-sm text-artha-text font-medium mb-1">Install Ollama to run models locally</p>
                  <p className="text-xs text-artha-muted leading-relaxed mb-3">
                    Artha uses <span className="text-artha-text">Ollama</span> to run models on your machine. Install it once —
                    after that, Artha starts it for you automatically.
                  </p>
                  <a href="https://ollama.com/download" target="_blank" rel="noreferrer"
                    className="inline-flex items-center gap-1.5 text-xs text-artha-accent hover:underline">
                    Download Ollama <ExternalLink size={11} />
                  </a>
                </div>
              ) : (
                <div className="bg-artha-surface border border-artha-border rounded-xl p-4 flex items-start gap-2.5">
                  <RefreshCw size={14} className="text-artha-accent animate-spin mt-0.5 shrink-0" />
                  <div>
                    <p className="text-sm text-artha-text font-medium">Starting your local model…</p>
                    <p className="text-xs text-artha-muted leading-relaxed">Artha is turning Ollama on for you — this only takes a few seconds.</p>
                  </div>
                </div>
              )}
              <div className="flex gap-2">
                <button onClick={refresh} disabled={checking}
                  className="flex items-center gap-1.5 px-4 py-2 rounded-lg bg-artha-accent hover:bg-artha-accent/80 text-sm font-medium text-white transition-colors disabled:opacity-40">
                  <RefreshCw size={13} className={checking ? 'animate-spin' : ''} /> Recheck
                </button>
                <button onClick={skip} className="px-4 py-2 rounded-lg text-sm text-artha-muted hover:text-artha-text hover:bg-white/5 transition-colors">
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
                    <span className="text-sm text-artha-text">Downloading {hardware.recommendedModel}…</span>
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
                          <span className="text-sm text-artha-text flex-1 truncate">{m.name}</span>
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
                        <span className="block text-sm font-medium text-artha-text truncate">{hardware.recommendedModel}</span>
                        <span className="block text-xs text-artha-muted">Best fit for your hardware · downloads once</span>
                      </span>
                    </button>
                  </div>

                  {error && <p className="text-xs text-red-400">{error}</p>}

                  <button onClick={skip} className="w-full text-center text-xs text-artha-muted hover:text-artha-text transition-colors pt-1">
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
      )}
    </div>
  );
}
