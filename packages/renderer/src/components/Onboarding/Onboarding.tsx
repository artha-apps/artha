/**
 * Onboarding — first-run guided setup. Shown as a full-screen overlay until the
 * user has a working model (or explicitly skips).
 *
 * Flow:
 *   Step 0 — persona pick: Individual (B2C) vs Organization admin (B2B).
 *   Individual → execution-mode pick (Phase A commit 8):
 *     • Local models   → existing Ollama+model flow
 *     • My own API key → BYOK sub-flow (preset → key → discover → test →
 *       activate). Cloud-only users never touch Ollama here.
 *     • Configure later → exits into the honest no_model state (banner +
 *       chat deep-links take over) — never a silent localhost failure.
 *   Organization → OrgSetup sub-flow (license → start hub → provision seats).
 *
 * This kills the biggest first-run drop-off (a blank app that does nothing
 * because no model is configured) and also splits the funnel cleanly between
 * the two commercial motions without confusing either audience.
 */
import { useEffect, useState } from 'react';
import {
  Bot, Download, CheckCircle2, RefreshCw, ExternalLink, Cpu, ArrowRight,
  Cloud, User, Building2, KeyRound, Lock, HardDrive, Shield,
} from 'lucide-react';
import OrgSetup from './OrgSetup';
import MemoryImport from '../MemoryImport/MemoryImport';
import { BrandWordmark } from '../ui/BrandWordmark';

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
  // Sub-step of the individual flow: 'path' (execution-mode pick) → 'setup'
  // (local Ollama) | 'byok' (own API key) → 'byom' (Bring Your Own Memory).
  // onboardingComplete is persisted when leaving setup/byok, so closing the
  // app on the BYOM step still counts as onboarded — BYOM is a bonus, never
  // a gate.
  const [step, setStep] = useState<'path' | 'setup' | 'byok' | 'byom'>('path');

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

  // Kick off Ollama discovery only when the user picks the LOCAL path — the
  // BYOK and org-admin paths never need Ollama on this machine, so they make
  // zero localhost probes from onboarding.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { if (persona === 'individual' && step === 'setup') refresh(); }, [persona, step]);

  // Subscribe to live pull progress.
  useEffect(() => {
    const off = window.artha.llm.onPullProgress((p) => {
      if (p.error) { setError(p.error); return; }
      setProgress({ percent: p.percent, status: p.status });
    });
    return () => { off(); };
  }, []);

  /** Persist persona + model + onboardingComplete, then advance to the optional
   *  Bring-Your-Own-Memory step (instead of closing). */
  const finishWith = async (modelName: string) => {
    await window.artha.llm.setActiveModel(modelName);
    await window.artha.settings.set({ persona: 'individual', onboardingComplete: true });
    setStep('byom');
  };

  /** Individual-path "skip model setup" — still onboard, then offer BYOM. */
  const skipToByom = async () => {
    await window.artha.settings.set({ persona: 'individual', onboardingComplete: true });
    setStep('byom');
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
        <div className="w-full max-w-lg bg-artha-surface-raised border border-artha-border rounded-2xl shadow-modal p-8 animate-scale-in">
          <div className="flex flex-col items-center text-center mb-6">
            <img
              src="./logo-mark.png"
              alt=""
              width={56}
              height={56}
              draggable={false}
              className="rounded-2xl shadow-lifted ring-1 ring-artha-border-strong/50 select-none mb-3"
            />
            <p className="text-[11px] font-medium uppercase tracking-[0.18em] text-artha-subtle mb-1.5">Welcome to</p>
            <BrandWordmark size={26} />
            <p className="text-sm text-artha-muted mt-2">How are you using Artha?</p>
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

      {/* Individual flow — execution-mode pick (local / BYOK / later) */}
      {persona === 'individual' && step === 'path' && (
        <div className="w-full max-w-lg bg-artha-surface-raised border border-artha-border rounded-2xl shadow-modal p-8 animate-scale-in">
          <div className="flex items-center justify-between mb-6">
            <button onClick={() => setPersona(null)} className="text-xs text-artha-muted hover:text-artha-text transition-colors">← Back</button>
            <span className="text-[11px] uppercase tracking-wide text-artha-muted">Solo setup</span>
          </div>

          <div className="flex flex-col items-center text-center mb-6">
            <h1 className="text-2xl font-bold text-gradient-emerald mb-1 tracking-tight">Where should intelligence run?</h1>
            <p className="text-sm text-artha-muted">Your choice — and you can mix both later.</p>
          </div>

          <div className="space-y-3">
            <button onClick={() => setStep('setup')}
              className="w-full flex items-start gap-3 px-4 py-3 rounded-xl bg-artha-surface border border-artha-border hover:border-artha-accent/40 hover:bg-artha-accent/5 transition-all text-left">
              <HardDrive size={18} className="text-artha-accent shrink-0 mt-0.5" />
              <span className="flex-1">
                <span className="block text-sm font-medium text-artha-text">Run models on this computer</span>
                <span className="block text-xs text-artha-muted">Maximum privacy — everything stays on your machine. Uses Ollama; needs ~8 GB RAM for good models.</span>
              </span>
              <ArrowRight size={14} className="text-artha-muted shrink-0 mt-1" />
            </button>

            <button onClick={() => setStep('byok')}
              className="w-full flex items-start gap-3 px-4 py-3 rounded-xl bg-artha-surface border border-artha-border hover:border-artha-accent/40 hover:bg-artha-accent/5 transition-all text-left">
              <KeyRound size={18} className="text-artha-accent shrink-0 mt-0.5" />
              <span className="flex-1">
                <span className="block text-sm font-medium text-artha-text">Use my own API key</span>
                <span className="block text-xs text-artha-muted">OpenAI, Anthropic, Gemini, OpenRouter, Groq, DeepSeek and more. You pay the provider directly — often pennies a day. No powerful hardware needed.</span>
              </span>
              <ArrowRight size={14} className="text-artha-muted shrink-0 mt-1" />
            </button>

            <button onClick={skip}
              className="w-full flex items-start gap-3 px-4 py-3 rounded-xl bg-artha-surface border border-artha-border hover:border-artha-accent/40 hover:bg-artha-accent/5 transition-all text-left">
              <ArrowRight size={18} className="text-artha-muted shrink-0 mt-0.5" />
              <span className="flex-1">
                <span className="block text-sm font-medium text-artha-text">Configure later</span>
                <span className="block text-xs text-artha-muted">Look around first. Artha will show exactly where to set up a model when you're ready.</span>
              </span>
            </button>
          </div>
        </div>
      )}

      {/* Individual flow — BYOK (own API key) setup */}
      {persona === 'individual' && step === 'byok' && (
        <ByokSetup
          onBack={() => setStep('path')}
          onDone={async () => {
            await window.artha.settings.set({ persona: 'individual', onboardingComplete: true });
            setStep('byom');
          }}
        />
      )}

      {/* Individual flow — Bring Your Own Memory (optional, after model setup) */}
      {persona === 'individual' && step === 'byom' && (
        <div className="w-full max-w-lg bg-artha-surface-raised border border-artha-border rounded-2xl shadow-modal p-8 animate-scale-in">
          <div className="flex items-center justify-between mb-6">
            <span className="text-[11px] uppercase tracking-wide text-artha-muted">Solo setup · final step</span>
            <span className="text-[11px] text-artha-subtle">Optional</span>
          </div>
          <MemoryImport variant="onboarding" onDone={() => onDone()} onSkip={() => onDone()} />
        </div>
      )}

      {/* Individual flow — existing Ollama+model steps (LOCAL path) */}
      {persona === 'individual' && step === 'setup' && (
        <div className="w-full max-w-lg bg-artha-surface-raised border border-artha-border rounded-2xl shadow-modal p-8 animate-scale-in">
          <div className="flex items-center justify-between mb-6">
            <button onClick={() => setStep('path')} className="text-xs text-artha-muted hover:text-artha-text transition-colors">← Back</button>
            <span className="text-[11px] uppercase tracking-wide text-artha-muted">Solo setup</span>
          </div>

          <div className="flex flex-col items-center text-center mb-6">
            <div className="w-14 h-14 rounded-2xl bg-artha-accent/10 border border-artha-accent/30 flex items-center justify-center mb-4 shadow-glow animate-glow-pulse">
              <Bot size={26} className="text-artha-accent" />
            </div>
            <h1 className="text-2xl font-bold text-gradient-emerald mb-1 tracking-tight">Let's get you running</h1>
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
              {indivLicenseStatus === 'applied' && <p className="text-xs text-artha-success">License applied. Team features unlocked.</p>}
              {indivLicenseStatus === 'error' && <p className="text-xs text-artha-danger">{indivLicenseError}</p>}
              <button onClick={applyIndivLicense} disabled={!indivLicense.trim()}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-artha-accent hover:bg-artha-accent-hover hover:shadow-glow-sm text-xs font-medium text-artha-on-accent transition-all duration-200 active:scale-95 disabled:opacity-40">
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
                  className="flex items-center gap-1.5 px-4 py-2 rounded-lg bg-artha-accent hover:bg-artha-accent-hover hover:shadow-glow-sm text-sm font-medium text-artha-on-accent transition-all duration-200 active:scale-95 disabled:opacity-40">
                  <RefreshCw size={13} className={checking ? 'animate-spin' : ''} /> Recheck
                </button>
                <button onClick={skipToByom} className="px-4 py-2 rounded-lg text-sm text-artha-muted hover:text-artha-text hover:bg-artha-text/5 transition-colors">
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
                          <CheckCircle2 size={15} className="text-artha-success shrink-0" />
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

                  {error && <p className="text-xs text-artha-danger">{error}</p>}

                  <button onClick={skipToByom} className="w-full text-center text-xs text-artha-muted hover:text-artha-text transition-colors pt-1">
                    Skip — I'll set this up later
                  </button>
                </>
              )}
            </div>
          )}

          {/* Footer hint */}
          <button onClick={() => setStep('byok')}
            className="mt-6 pt-4 border-t border-artha-border w-full flex items-center justify-center gap-1.5 text-[11px] text-artha-muted hover:text-artha-text transition-colors">
            <Cloud size={11} /> Prefer your own API key instead? Set it up now →
          </button>
        </div>
      )}
    </div>
  );
}

/** Preset shape served by llm:listProviderPresets (see llm/providerPresets.ts). */
interface OnbPreset {
  id: string; label: string; kind: string;
  baseUrl: string; baseUrlTemplate?: string;
  keyRequired: boolean; keyHint: string; modelHint: string;
  docsUrl: string; note?: string;
}

const ONB_FALLBACK_PRESETS: OnbPreset[] = [
  { id: 'openai', label: 'OpenAI', kind: 'cloud', baseUrl: 'https://api.openai.com/v1', keyRequired: true, keyHint: 'sk-…', modelHint: 'gpt-4o-mini', docsUrl: 'https://platform.openai.com/api-keys' },
  { id: 'anthropic', label: 'Anthropic', kind: 'cloud', baseUrl: 'https://api.anthropic.com/v1', keyRequired: true, keyHint: 'sk-ant-…', modelHint: 'claude-sonnet-4-6', docsUrl: 'https://console.anthropic.com/settings/keys' },
  { id: 'custom', label: 'Custom (OpenAI-compatible)', kind: 'custom', baseUrl: '', baseUrlTemplate: 'https://{host}/v1', keyRequired: false, keyHint: 'if needed', modelHint: 'model-name', docsUrl: 'https://artha.space/docs' },
];

/**
 * BYOK onboarding sub-flow — compact version of the ModelsPanel cloud form:
 * provider → key → discover models → test → save & activate. Same IPC, same
 * credential policy (keychain-sealed persistence; session-only offer when no
 * trustworthy keychain exists; never plaintext).
 */
function ByokSetup({ onDone, onBack }: { onDone: () => void | Promise<void>; onBack: () => void }) {
  const [presets, setPresets] = useState<OnbPreset[]>(ONB_FALLBACK_PRESETS);
  const [providerId, setProviderId] = useState('openai');
  const [baseUrl, setBaseUrl] = useState(ONB_FALLBACK_PRESETS[0].baseUrl);
  const [apiKey, setApiKey] = useState('');
  const [model, setModel] = useState('');
  const [discovered, setDiscovered] = useState<string[] | null>(null);
  const [busy, setBusy] = useState<'discover' | 'test' | 'save' | null>(null);
  const [testResult, setTestResult] = useState<{ ok: boolean; text: string } | null>(null);
  const [error, setError] = useState('');
  const [storagePrompt, setStoragePrompt] = useState<string | null>(null);

  useEffect(() => {
    window.artha.llm.listProviderPresets?.()
      .then(p => { if (Array.isArray(p) && p.length) setPresets(p as OnbPreset[]); })
      .catch(() => {});
  }, []);

  const preset = presets.find(p => p.id === providerId) ?? presets[presets.length - 1];

  const pick = (p: OnbPreset) => {
    setProviderId(p.id);
    setBaseUrl(p.baseUrl);
    setDiscovered(null);
    setTestResult(null);
    setError('');
  };

  const discover = async () => {
    if (!baseUrl.trim()) { setError('Enter the base URL first'); return; }
    setBusy('discover'); setError('');
    try {
      const res = await window.artha.llm.discoverModels({ baseUrl: baseUrl.trim(), apiKey: apiKey.trim() || undefined });
      if (res.ok) {
        setDiscovered(res.models);
        if (res.models.length && !model) setModel(res.models[0]);
        if (!res.models.length) setError('No models listed — type the model name manually.');
      } else {
        setError(res.error.message);
      }
    } finally { setBusy(null); }
  };

  const save = async (persistence?: 'session') => {
    if (!model.trim()) { setError('Pick or type a model name'); return; }
    if (!baseUrl.trim()) { setError('Base URL is required'); return; }
    if (preset.keyRequired && !apiKey.trim()) { setError(`${preset.label} requires an API key`); return; }
    setBusy('save'); setError('');
    try {
      // Prove the config before activating — a broken first chat is exactly
      // the deceptive failure this flow exists to prevent.
      const test = await window.artha.llm.testConnection({
        baseUrl: baseUrl.trim(), apiKey: apiKey.trim() || undefined, model: model.trim(),
      });
      if (!test.ok) { setTestResult({ ok: false, text: test.error.message }); return; }
      setTestResult({ ok: true, text: `Connected in ${test.latencyMs} ms` });
      const res = await window.artha.llm.addCloudModel({
        provider: providerId,
        label: `${preset.label}: ${model.trim()}`,
        model: model.trim(),
        baseUrl: baseUrl.trim(),
        apiKey: apiKey.trim(),
        activate: true,
        persistence,
      });
      if ('error' in res) { setStoragePrompt(res.message); return; }
      await onDone();
    } finally { setBusy(null); }
  };

  return (
    <div className="w-full max-w-lg bg-artha-surface-raised border border-artha-border rounded-2xl shadow-modal p-8 animate-scale-in max-h-[90vh] overflow-y-auto">
      <div className="flex items-center justify-between mb-6">
        <button onClick={onBack} className="text-xs text-artha-muted hover:text-artha-text transition-colors">← Back</button>
        <span className="text-[11px] uppercase tracking-wide text-artha-muted">Solo setup · your API key</span>
      </div>

      <div className="flex flex-col items-center text-center mb-5">
        <h1 className="text-2xl font-bold text-gradient-emerald mb-1 tracking-tight">Connect your provider</h1>
        <p className="text-sm text-artha-muted">Your key is encrypted on this device and sent only to the provider you choose.</p>
      </div>

      <div className="space-y-3">
        <div className="flex flex-wrap gap-1.5">
          {presets.map(p => (
            <button key={p.id} onClick={() => pick(p)}
              className={`px-2.5 py-1 rounded-lg text-[11px] font-medium transition-colors ${
                providerId === p.id
                  ? 'bg-artha-accent/20 text-artha-text border border-artha-accent/30'
                  : 'bg-artha-surface border border-artha-border text-artha-muted hover:text-artha-text'
              }`}>
              {p.label}
            </button>
          ))}
        </div>

        {(preset.note || preset.docsUrl) && (
          <p className="text-[11px] text-artha-muted leading-relaxed">
            {preset.note}{preset.note ? ' ' : ''}
            <a href={preset.docsUrl} target="_blank" rel="noreferrer" className="text-artha-accent hover:underline">Get a key ↗</a>
          </p>
        )}

        {!preset.baseUrl && (
          <input value={baseUrl} onChange={e => { setBaseUrl(e.target.value); setDiscovered(null); }}
            placeholder={preset.baseUrlTemplate ?? 'https://your-endpoint/v1'}
            className="w-full bg-artha-surface border border-artha-border rounded-lg px-3 py-2 text-sm text-artha-text placeholder-artha-muted focus:border-artha-accent/50 focus:outline-none font-mono" />
        )}

        <div className="relative">
          <Lock size={12} className="absolute left-3 top-1/2 -translate-y-1/2 text-artha-muted" />
          <input type="password" value={apiKey} onChange={e => { setApiKey(e.target.value); setTestResult(null); }}
            placeholder={`API key ${preset.keyRequired ? '' : '(optional)'} — ${preset.keyHint}`}
            className="w-full bg-artha-surface border border-artha-border rounded-lg pl-8 pr-3 py-2 text-sm text-artha-text placeholder-artha-muted focus:border-artha-accent/50 focus:outline-none font-mono" />
        </div>

        <div className="flex gap-2">
          <input value={model} list="onb-discovered-models"
            onChange={e => { setModel(e.target.value); setTestResult(null); }}
            placeholder={preset.modelHint}
            className="flex-1 bg-artha-surface border border-artha-border rounded-lg px-3 py-2 text-sm text-artha-text placeholder-artha-muted focus:border-artha-accent/50 focus:outline-none font-mono" />
          <button onClick={() => void discover()} disabled={busy !== null}
            className="px-3 py-2 rounded-lg border border-artha-border text-xs text-artha-muted hover:text-artha-text hover:bg-artha-text/5 transition-colors disabled:opacity-50 whitespace-nowrap">
            {busy === 'discover' ? <RefreshCw size={12} className="animate-spin" /> : 'Find models'}
          </button>
        </div>
        <datalist id="onb-discovered-models">
          {(discovered ?? []).map(m => <option key={m} value={m} />)}
        </datalist>

        {testResult && (
          <p className={`text-xs ${testResult.ok ? 'text-artha-success' : 'text-artha-danger'}`}>{testResult.text}</p>
        )}
        {error && <p className="text-xs text-artha-danger">{error}</p>}

        {/* No trustworthy keychain: refuse persistence, offer session-only. */}
        {storagePrompt && (
          <div className="flex items-start gap-2 text-xs bg-artha-warn/10 border border-artha-warn/30 rounded-lg px-3 py-2.5">
            <Shield size={13} className="text-artha-warn shrink-0 mt-0.5" />
            <div className="flex-1 min-w-0">
              <p className="text-artha-text font-medium">Secure key storage isn’t available on this system</p>
              <p className="text-artha-muted mt-0.5">{storagePrompt}</p>
              <div className="flex items-center gap-2 mt-2">
                <button onClick={() => { setStoragePrompt(null); void save('session'); }} disabled={busy !== null}
                  className="px-2.5 py-1 rounded-lg bg-artha-warn/15 hover:bg-artha-warn/25 text-artha-warn font-medium transition-colors disabled:opacity-50">
                  Use for this session only
                </button>
                <button onClick={() => setStoragePrompt(null)}
                  className="px-2.5 py-1 rounded-lg bg-artha-s2 hover:bg-artha-s3 text-artha-muted transition-colors">
                  Cancel
                </button>
              </div>
            </div>
          </div>
        )}

        <button onClick={() => void save()} disabled={busy !== null}
          className="w-full flex items-center justify-center gap-1.5 px-4 py-2.5 rounded-lg bg-artha-accent hover:bg-artha-accent-hover hover:shadow-glow-sm text-sm font-medium text-artha-on-accent transition-all duration-200 active:scale-95 disabled:opacity-40">
          {busy === 'save' ? <RefreshCw size={13} className="animate-spin" /> : <CheckCircle2 size={13} />}
          Test &amp; start with {model.trim() || 'this model'}
        </button>
      </div>
    </div>
  );
}
