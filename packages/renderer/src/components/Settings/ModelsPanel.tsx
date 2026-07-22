/**
 * ModelsPanel — browse available Ollama models, see hardware info,
 * and set the active model with one click. Includes a curated catalog
 * so users can pull new models directly from the UI.
 */
import { useEffect, useState } from 'react';
import {
  Cpu, CheckCircle2, RefreshCw, HardDrive,
  ChevronRight, Cloud, Plus, Trash2, Lock, Shield, Download, Zap, Star,
} from 'lucide-react';

/** Subset of Ollama's /api/tags model entry we actually render. */
interface OllamaModel {
  name: string;
  size: number; // bytes
  modified_at?: string;
  details?: { parameter_size?: string; quantization_level?: string; family?: string };
}

/** A saved model row (local or cloud) from `llm_models`. */
interface ConfiguredModel {
  model_id: string;
  name: string;
  ollama_name: string;
  base_url: string;
  provider: string;
  context_window: number;
  is_active: number;
}

/** Provider presets for the BYOK form. base_url is OpenAI-compatible for all. */
const CLOUD_PROVIDERS: Record<string, { label: string; baseUrl: string; modelHint: string }> = {
  openai: { label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', modelHint: 'gpt-4o-mini' },
  anthropic: { label: 'Anthropic', baseUrl: 'https://api.anthropic.com/v1', modelHint: 'claude-sonnet-4-6' },
  custom: { label: 'Custom (OpenAI-compatible)', baseUrl: '', modelHint: 'model-name' },
};

/** Result of `llm:detectHardware` — feeds the "Recommended" hint. */
interface HardwareInfo {
  gbRam: number;
  recommendation: string;
  recommendedModel?: string;
  gpuName: string | null;
  vramGb: number | null;
}

interface PullProgress {
  name: string;
  status: string;
  percent?: number;
  error?: string;
}

/** One benchmark row from `model_profiles` (see router/benchmark.ts). */
interface RouterProfile {
  ollama_name: string;
  task_type: 'plan' | 'tool_args' | 'synthesis';
  latency_ms: number;
  quality: number;
  benchmarked_at: number;
}

/** Per-model digest of its benchmark rows — drives the Model Fit line. */
interface ModelFit {
  planMs: number | null;
  toolQuality: number | null;
  synthMs: number | null;
  avgQuality: number;
}

/** Aggregate a model's profile rows into a ModelFit; null = not benchmarked. */
function fitFrom(profiles: RouterProfile[], name: string): ModelFit | null {
  const rows = profiles.filter(p => p.ollama_name === name);
  if (!rows.length) return null;
  const by = (t: RouterProfile['task_type']) => rows.find(r => r.task_type === t);
  const qualities = rows.map(r => r.quality);
  return {
    planMs: by('plan')?.latency_ms ?? null,
    toolQuality: by('tool_args')?.quality ?? null,
    synthMs: by('synthesis')?.latency_ms ?? null,
    avgQuality: qualities.reduce((a, b) => a + b, 0) / qualities.length,
  };
}

/** Plain-language capability label for a fit. Honest, measured-here numbers —
 *  the benchmark scores JSON shape + prose coherence, not general smarts. */
function fitLabel(fit: ModelFit): { label: string; tone: 'good' | 'ok' | 'warn' } {
  const fast = (fit.synthMs ?? Infinity) <= 5_000;
  if (fit.avgQuality < 0.5) return { label: 'Struggles with structured tasks here', tone: 'warn' };
  if (fast && fit.avgQuality >= 0.8) return { label: 'Fast all-rounder — great default', tone: 'good' };
  if (fast) return { label: 'Quick — fine for simple tasks', tone: 'ok' };
  if (fit.avgQuality >= 0.8) return { label: 'High quality but slow — deep work', tone: 'ok' };
  return { label: 'Balanced', tone: 'ok' };
}

/** ✓ / ~ / ✗ for a 0..1 quality score. */
function qMark(q: number | null): string {
  if (q === null) return '?';
  return q >= 0.8 ? '✓' : q >= 0.4 ? '~' : '✗';
}

/** Curated catalog of popular Ollama models users can pull in one click. */
const MODEL_CATALOG = [
  {
    tag: 'llama3.2:3b',
    label: 'Llama 3.2 3B',
    family: 'Llama',
    size: '~2 GB',
    ramRequired: 4,
    speed: 'Fast',
    description: 'Meta\'s lightweight model. Great for quick tasks on any Mac.',
    badge: 'Recommended for most',
  },
  {
    tag: 'llama3.2:1b',
    label: 'Llama 3.2 1B',
    family: 'Llama',
    size: '~0.8 GB',
    ramRequired: 2,
    speed: 'Very fast',
    description: 'Ultra-lightweight. Instant responses, ideal for low-RAM machines.',
    badge: null,
  },
  {
    tag: 'qwen2.5:7b',
    label: 'Qwen 2.5 7B',
    family: 'Qwen',
    size: '~4.7 GB',
    ramRequired: 8,
    speed: 'Medium',
    description: 'Best tool-calling accuracy. The default Artha model for agentic tasks.',
    badge: 'Best for agents',
  },
  {
    tag: 'qwen2.5:14b',
    label: 'Qwen 2.5 14B',
    family: 'Qwen',
    size: '~9 GB',
    ramRequired: 16,
    speed: 'Medium',
    description: 'Stronger reasoning and tool use. Needs 16 GB+ RAM.',
    badge: null,
  },
  {
    tag: 'qwen2.5:72b',
    label: 'Qwen 2.5 72B',
    family: 'Qwen',
    size: '~47 GB',
    ramRequired: 64,
    speed: 'Slow',
    description: 'Flagship Qwen — top-tier tool-calling and reasoning. Best agentic accuracy. Needs a 64 GB+ machine.',
    badge: 'Most capable',
  },
  {
    tag: 'llama3.3:70b',
    label: 'Llama 3.3 70B',
    family: 'Llama',
    size: '~43 GB',
    ramRequired: 48,
    speed: 'Slow',
    description: 'Meta\'s latest 70B — excellent reasoning and solid tool use. Needs 48 GB+ RAM.',
    badge: null,
  },
  {
    tag: 'mistral:7b',
    label: 'Mistral 7B',
    family: 'Mistral',
    size: '~4.1 GB',
    ramRequired: 8,
    speed: 'Medium',
    description: 'Strong general-purpose European model. Great instruction following.',
    badge: null,
  },
  {
    tag: 'gemma3:4b',
    label: 'Gemma 3 4B',
    family: 'Gemma',
    size: '~3.3 GB',
    ramRequired: 6,
    speed: 'Fast',
    description: 'Google\'s efficient model. Good balance of speed and capability.',
    badge: null,
  },
  {
    tag: 'phi4:14b',
    label: 'Phi 4 14B',
    family: 'Phi',
    size: '~8.9 GB',
    ramRequired: 16,
    speed: 'Medium',
    description: 'Microsoft\'s reasoning-focused model. Excellent at structured tasks.',
    badge: null,
  },
  {
    tag: 'deepseek-r1:7b',
    label: 'DeepSeek R1 7B',
    family: 'DeepSeek',
    size: '~4.7 GB',
    ramRequired: 8,
    speed: 'Medium',
    description: 'Chain-of-thought reasoning model. Shows its thinking process.',
    badge: null,
  },
  {
    tag: 'codellama:7b',
    label: 'CodeLlama 7B',
    family: 'CodeLlama',
    size: '~3.8 GB',
    ramRequired: 8,
    speed: 'Medium',
    description: 'Specialized for coding tasks. Use for programming workflows.',
    badge: null,
  },
  {
    tag: 'nomic-embed-text',
    label: 'Nomic Embed Text',
    family: 'Nomic',
    size: '~0.3 GB',
    ramRequired: 2,
    speed: 'Very fast',
    description: 'Embedding model for RAG and semantic search. Not a chat model.',
    badge: 'For RAG',
  },
];

/** Bytes → human-readable size for the model card. */
// ── Helpers ───────────────────────────────────────────────────────────────────

/** Bytes → human-readable size for the model card. */
function formatSize(bytes: number): string {
  const gb = bytes / 1024 / 1024 / 1024;
  return gb >= 1 ? `${gb.toFixed(1)} GB` : `${(bytes / 1024 / 1024).toFixed(0)} MB`;
}

/** Derive the family label from the raw Ollama model name for the colored badge. */
function modelFamily(name: string): string {
  const n = name.toLowerCase();
  if (n.includes('qwen')) return 'Qwen';
  if (n.includes('llama')) return 'Llama';
  if (n.includes('mistral')) return 'Mistral';
  if (n.includes('gemma')) return 'Gemma';
  if (n.includes('phi')) return 'Phi';
  if (n.includes('deepseek')) return 'DeepSeek';
  if (n.includes('nomic')) return 'Nomic';
  if (n.includes('codellama')) return 'CodeLlama';
  return 'Model';
}

/** Map a family name to a Tailwind color class pair for the inline badge. */
function familyColor(family: string): string {
  const map: Record<string, string> = {
    Qwen: 'text-blue-400 bg-blue-400/10',
    Llama: 'text-orange-400 bg-orange-400/10',
    Mistral: 'text-violet-400 bg-violet-400/10',
    Gemma: 'text-teal-400 bg-teal-400/10',
    Phi: 'text-pink-400 bg-pink-400/10',
    DeepSeek: 'text-artha-accent bg-artha-accent/10',
    CodeLlama: 'text-yellow-400 bg-yellow-400/10',
    Nomic: 'text-artha-success bg-artha-success/10',
  };
  return map[family] ?? 'text-artha-muted bg-artha-text/5';
}

/** Models panel — Ollama model management + BYOK cloud model configuration. */
export default function ModelsPanel() {
  // ── State ──────────────────────────────────────────────────────────────────
  const [models, setModels] = useState<OllamaModel[]>([]);
  const [activeModel, setActiveModelState] = useState<string | null>(null);
  const [hardware, setHardware] = useState<HardwareInfo | null>(null);
  const [loading, setLoading] = useState(true);
  // `switching` holds the name being activated so we can show a spinner on that row only.
  const [switching, setSwitching] = useState<string | null>(null);
  // Uninstall flow: `confirmDelete` is the row awaiting confirmation, `deleting`
  // the row whose blobs are being removed (spinner), `deleteError` any failure.
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [ollamaOnline, setOllamaOnline] = useState(true);

  // Pull progress — keyed by model tag so multiple concurrent pulls can coexist.
  const [pulling, setPulling] = useState<Record<string, PullProgress>>({});

  // Context-window slider state — mirrors `llm_models.context_window` for the active model.
  const [ctxWindow, setCtxWindow] = useState<number>(4096);
  const [ctxSaving, setCtxSaving] = useState(false);

  // Model Fit — benchmark rows (model_profiles) measured on this machine, and
  // which model a single-model probe is currently running for.
  const [profiles, setProfiles] = useState<RouterProfile[]>([]);
  const [benching, setBenching] = useState<string | null>(null);

  // BYOK cloud state — form fields + saved rows from `llm_models`.
  const [configured, setConfigured] = useState<ConfiguredModel[]>([]);
  const [showCloudForm, setShowCloudForm] = useState(false);
  const [cloudProvider, setCloudProvider] = useState<keyof typeof CLOUD_PROVIDERS>('openai');
  const [cloudModel, setCloudModel] = useState('');
  const [cloudBaseUrl, setCloudBaseUrl] = useState(CLOUD_PROVIDERS.openai.baseUrl);
  const [cloudKey, setCloudKey] = useState('');
  const [savingCloud, setSavingCloud] = useState(false);
  const [cloudError, setCloudError] = useState('');
  // Honest at-rest state: false when the OS keychain is unavailable, so the
  // saved key is only base64-obfuscated on disk. Never hide this from the user.
  const [keyNotEncrypted, setKeyNotEncrypted] = useState(false);

  // Tab controls which list is shown: models already on disk vs the pull catalog.
  const [tab, setTab] = useState<'installed' | 'browse'>('installed');

  /** Pull model list + hardware info + active model.
   *  Ollama reachability is checked independently so a hardware-detection
   *  failure never falsely shows the "Ollama not running" banner. */
  const load = async () => {
    setLoading(true);

    // 1. Ollama reachability — checked on its own
    try {
      const online = await (window.artha.llm.checkOllama() as Promise<boolean>);
      setOllamaOnline(online);
    } catch {
      setOllamaOnline(false);
    }

    // Model Fit data — benchmark rows measured on THIS machine. Best-effort.
    window.artha.router.listProfiles().then(setProfiles).catch(() => setProfiles([]));

    // 2. Configured (saved) models — cloud BYOK must show even when Ollama is offline
    window.artha.llm.listConfigured().then(c => {
      const list = c as ConfiguredModel[];
      setConfigured(list);
      const activeRow = list.find(m => m.is_active);
      if (activeRow) setCtxWindow(activeRow.context_window ?? 4096);
    }).catch(() => {});

    // 3. Model list + hardware + active model
    try {
      const [modelList, hw, active] = await Promise.all([
        window.artha.llm.listModels() as Promise<OllamaModel[]>,
        window.artha.llm.detectHardware() as Promise<HardwareInfo>,
        window.artha.llm.getActiveModel() as Promise<string | null>,
      ]);
      setModels(modelList);
      setHardware(hw);
      if (!active && modelList.length > 0) {
        const preferred = modelList.find(m => m.name.startsWith('qwen2.5')) ?? modelList[0];
        setActiveModelState(preferred.name);
      } else {
        setActiveModelState(active);
      }
      // Auto-switch to browse tab when no models installed
      if (modelList.length === 0) setTab('browse');
    } catch {
      // Silent — banner is driven by checkOllama only
    } finally {
      setLoading(false);
    }
  };

  // ── Effects ────────────────────────────────────────────────────────────────

  // Subscribe to streaming pull-progress events from the main process.
  useEffect(() => {
    const unsub = window.artha.llm.onPullProgress((p: PullProgress) => {
      setPulling(prev => ({ ...prev, [p.name]: p }));
      // On success, refresh the installed list, clear progress, and switch to
      // Installed tab — then benchmark the new model in the background so its
      // Model Fit card fills in without the user asking (~3 quick probes).
      if (p.status === 'success') {
        setTimeout(() => {
          setPulling(prev => { const n = { ...prev }; delete n[p.name]; return n; });
          setTab('installed');
          load();
          setBenching(p.name);
          window.artha.router.benchmarkModel(p.name)
            .then(() => window.artha.router.listProfiles())
            .then(setProfiles)
            .catch(() => { /* fit card stays "Not benchmarked" */ })
            .finally(() => setBenching(null));
        }, 1200);
      }
    });
    // Wrap in a void arrow — the preload unsub returns IpcRenderer, which is not
    // a valid useEffect destructor (must return void).
    return () => { unsub(); };
  }, []);

  // Initial data load on mount.
  useEffect(() => { load(); }, []);

  // ── Derived ────────────────────────────────────────────────────────────────

  // Separate cloud rows from local Ollama rows — cloud models point at non-localhost URLs.
  const cloudModels = configured.filter(
    m => !m.base_url.includes('localhost') && !m.base_url.includes('127.0.0.1')
  );

  // Used by the Browse tab to mark already-pulled catalog entries as installed.
  const installedTags = new Set(models.map(m => m.name));

  // The measured-best installed model: highest quality, speed as tiebreak
  // (score = quality − minutes of synthesis latency). Only models that hit a
  // usable quality bar are eligible — a fast-but-broken model never wins.
  const recommendedModel = (() => {
    let best: { name: string; score: number } | null = null;
    for (const m of models) {
      const fit = fitFrom(profiles, m.name);
      if (!fit || fit.avgQuality < 0.7) continue;
      const score = fit.avgQuality - (fit.synthMs ?? 60_000) / 60_000;
      if (!best || score > best.score) best = { name: m.name, score };
    }
    return best?.name ?? null;
  })();

  /** Probe one model on demand (fit-card "Benchmark" button / post-install). */
  const benchOne = async (name: string) => {
    if (benching) return;
    setBenching(name);
    try {
      await window.artha.router.benchmarkModel(name);
      setProfiles(await window.artha.router.listProfiles());
    } catch { /* Ollama down — card stays "Not benchmarked" */ }
    finally { setBenching(null); }
  };

  /** Pull a model from the catalog using the streaming endpoint. */
  const pullModel = async (tag: string) => {
    setPulling(prev => ({ ...prev, [tag]: { name: tag, status: 'starting', percent: 0 } }));
    try {
      await window.artha.llm.pullModelStream(tag);
    } catch (err) {
      setPulling(prev => ({
        ...prev,
        [tag]: { name: tag, status: 'error', error: err instanceof Error ? err.message : 'Pull failed' },
      }));
    }
  };

  const pickProvider = (p: keyof typeof CLOUD_PROVIDERS) => {
    setCloudProvider(p);
    setCloudBaseUrl(CLOUD_PROVIDERS[p].baseUrl);
  };

  const saveCloudModel = async () => {
    if (!cloudModel.trim()) { setCloudError('Model name is required'); return; }
    if (!cloudBaseUrl.trim()) { setCloudError('Base URL is required'); return; }
    if (!cloudKey.trim()) { setCloudError('API key is required'); return; }
    setSavingCloud(true);
    setCloudError('');
    try {
      const res = await window.artha.llm.addCloudModel({
        provider: cloudProvider,
        label: `${CLOUD_PROVIDERS[cloudProvider].label}: ${cloudModel.trim()}`,
        model: cloudModel.trim(),
        baseUrl: cloudBaseUrl.trim(),
        apiKey: cloudKey.trim(),
        activate: true,
      }) as { model_id: string; atRestEncrypted?: boolean };
      setKeyNotEncrypted(res?.atRestEncrypted === false);
      setShowCloudForm(false);
      setCloudModel(''); setCloudKey('');
      setActiveModelState(cloudModel.trim());
      await load();
    } catch (err) {
      setCloudError(err instanceof Error ? err.message : 'Failed to save cloud model');
    } finally {
      setSavingCloud(false);
    }
  };

  const activateCloud = async (m: ConfiguredModel) => {
    await window.artha.llm.setActiveModelById(m.model_id);
    setActiveModelState(m.ollama_name);
    setCtxWindow(m.context_window ?? 4096);
    await load();
  };

  /** Persist the context window for the active model, clamping to [512, 128 000]. */
  const saveContextWindow = async () => {
    const active = configured.find(m => m.is_active);
    if (!active) return;
    // Clamp before write so the slider can overshoot without causing an invalid DB value.
    const clamped = Math.max(512, Math.min(128_000, Math.round(ctxWindow)));
    setCtxSaving(true);
    try {
      await window.artha.llm.setContextWindow(active.model_id, clamped);
      setCtxWindow(clamped);
    } finally {
      setCtxSaving(false);
    }
  };

  const removeCloud = async (m: ConfiguredModel) => {
    await window.artha.llm.removeModel(m.model_id);
    await load();
  };

  /** Uninstall a local Ollama model — frees disk space and removes it from the app. */
  const deleteModel = async (name: string) => {
    setDeleting(name);
    setDeleteError(null);
    try {
      const res = await window.artha.llm.deleteModel(name);
      if (!res.ok) {
        setDeleteError(res.error ?? 'Could not delete this model.');
        return;
      }
      setConfirmDelete(null);
      // If we just removed the active model, clear it so load() re-picks a default.
      if (name === activeModel) setActiveModelState(null);
      await load();
    } finally {
      setDeleting(null);
    }
  };

  const switchModel = async (name: string) => {
    if (switching) return;
    setSwitching(name);
    try {
      await window.artha.llm.setActiveModel(name);
      setActiveModelState(name);
      const list = await window.artha.llm.listConfigured() as ConfiguredModel[];
      setConfigured(list);
      const nowActive = list.find(m => m.is_active);
      if (nowActive) setCtxWindow(nowActive.context_window ?? 4096);
    } finally {
      setSwitching(null);
    }
  };

  return (
    <div className="flex-1 overflow-y-auto px-8 py-8 max-w-3xl mx-auto w-full">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg bg-artha-accent/20 flex items-center justify-center">
            <Cpu size={16} className="text-artha-accent" />
          </div>
          <div>
            <h1 className="text-base font-semibold text-artha-text">Models</h1>
            <p className="text-xs text-artha-muted">Local Ollama models + cloud API keys</p>
          </div>
        </div>
        <button onClick={load} disabled={loading}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-artha-border text-artha-muted hover:text-artha-text hover:bg-artha-text/5 text-xs transition-colors disabled:opacity-40">
          <RefreshCw size={12} className={loading ? 'animate-spin' : ''} /> Refresh
        </button>
      </div>

      {/* Hardware card */}
      {hardware && (
        <div className="bg-artha-s2 border border-artha-border rounded-xl p-4 mb-6">
          {/* GPU · RAM summary line */}
          <div className="flex items-center gap-2 flex-wrap">
            <Cpu size={15} className="text-artha-accent shrink-0" />
            <span className="text-sm font-medium text-artha-text">
              {hardware.gpuName && <>{hardware.gpuName} · </>}
              {hardware.gbRam} GB RAM
              {hardware.vramGb ? <> · {hardware.vramGb} GB VRAM</> : null}
            </span>
          </div>
          {/* Recommendation */}
          <div className="flex items-start gap-2 mt-2">
            <HardDrive size={15} className="text-artha-muted mt-0.5 shrink-0" />
            <p className="text-xs text-artha-muted leading-relaxed">
              Recommended: <span className="text-artha-text">{hardware.recommendation}</span>
            </p>
          </div>
        </div>
      )}

      {/* Ollama offline warning */}
      {!ollamaOnline && (
        <div className="bg-artha-danger/10 border border-artha-danger/20 rounded-xl p-4 mb-6 text-sm text-artha-danger">
          Ollama is not running. Start it with{' '}
          <code className="bg-artha-danger/10 px-1.5 py-0.5 rounded font-mono text-xs">ollama serve</code>{' '}
          then refresh. Or use a cloud model below.
        </div>
      )}

      {/* Active model badge + context window */}
      {activeModel && (
        <div className="mb-5 rounded-xl border border-artha-border bg-artha-text/5 p-4 space-y-3">
          <div className="flex items-center gap-2">
            <CheckCircle2 size={14} className="text-artha-success shrink-0" />
            <span className="text-xs text-artha-muted">Active model: </span>
            <code className="text-xs text-artha-success font-mono truncate">{activeModel}</code>
          </div>
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <label className="text-xs text-artha-muted">Context window</label>
              <div className="flex items-center gap-2">
                <input
                  type="number"
                  value={ctxWindow}
                  min={512}
                  max={128000}
                  step={512}
                  onChange={e => setCtxWindow(Number(e.target.value))}
                  onBlur={saveContextWindow}
                  onKeyDown={e => { if (e.key === 'Enter') saveContextWindow(); }}
                  className="w-24 bg-black/30 border border-artha-border rounded-lg px-2 py-1 text-xs text-artha-text text-right font-mono focus:outline-none focus:border-artha-accent/50"
                />
                <span className="text-xs text-artha-muted">tokens</span>
                {ctxSaving && <RefreshCw size={11} className="text-artha-muted animate-spin" />}
              </div>
            </div>
            <input
              type="range" min={512} max={128000} step={512} value={ctxWindow}
              onChange={e => setCtxWindow(Number(e.target.value))}
              onMouseUp={saveContextWindow} onTouchEnd={saveContextWindow}
              className="w-full h-1 rounded-full bg-artha-text/8 accent-artha-accent cursor-pointer"
            />
            <div className="flex justify-between text-[10px] text-artha-muted/60">
              <span>512</span><span>8 k</span><span>32 k</span><span>128 k</span>
            </div>
          </div>
        </div>
      )}

      {/* ── Tab bar: Installed / Browse ── */}
      <div className="flex gap-1 mb-4 p-1 bg-artha-s2 border border-artha-border rounded-xl">
        <button
          onClick={() => setTab('installed')}
          className={`flex-1 flex items-center justify-center gap-1.5 py-1.5 rounded-lg text-xs font-medium transition-colors ${
            tab === 'installed' ? 'bg-artha-accent/20 text-artha-text' : 'text-artha-muted hover:text-artha-text'
          }`}
        >
          <CheckCircle2 size={12} />
          Installed
          {models.length > 0 && (
            <span className="ml-1 px-1.5 py-0.5 rounded-full bg-artha-accent/20 text-artha-accent text-[10px] font-semibold">
              {models.length}
            </span>
          )}
        </button>
        <button
          onClick={() => setTab('browse')}
          className={`flex-1 flex items-center justify-center gap-1.5 py-1.5 rounded-lg text-xs font-medium transition-colors ${
            tab === 'browse' ? 'bg-artha-accent/20 text-artha-text' : 'text-artha-muted hover:text-artha-text'
          }`}
        >
          <Download size={12} />
          Browse &amp; Install
        </button>
      </div>

      {/* ── Installed models ── */}
      {tab === 'installed' && (
        loading ? (
          <div className="space-y-3">
            {[1, 2, 3].map(i => (
              <div key={i} className="h-16 bg-artha-s2 border border-artha-border rounded-xl animate-pulse" />
            ))}
          </div>
        ) : models.length === 0 ? (
          <div className="text-center py-12 text-artha-muted">
            <Cpu size={32} className="mx-auto mb-3 opacity-30" />
            <p className="text-sm font-medium text-artha-text mb-1">No models installed yet</p>
            <p className="text-xs mb-4">Switch to the Browse tab to pull your first model.</p>
            <button
              onClick={() => setTab('browse')}
              className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-artha-accent/20 hover:bg-artha-accent/30 text-artha-accent text-xs font-medium transition-colors"
            >
              <Download size={13} /> Browse models
            </button>
          </div>
        ) : (
          <div className="space-y-2">
            {models.map((model) => {
              const family = modelFamily(model.name);
              const isActive = model.name === activeModel;
              const isLoading = switching === model.name;
              const isConfirming = confirmDelete === model.name;
              const isDeleting = deleting === model.name;
              return (
                <div
                  key={model.name}
                  className={`rounded-xl border transition-all
                    ${isActive
                      ? 'bg-artha-accent/10 border-artha-accent/40'
                      : 'bg-artha-s2 border-artha-border hover:border-artha-accent/30'
                    }`}
                >
                  <div className="flex items-center gap-3 px-4 py-3.5">
                    <button
                      onClick={() => switchModel(model.name)}
                      disabled={isActive || !!switching || isDeleting}
                      className="flex-1 flex items-center gap-4 text-left min-w-0 disabled:cursor-default enabled:hover:opacity-90 transition-opacity disabled:opacity-100"
                    >
                      <span className={`shrink-0 text-xs font-semibold px-2 py-0.5 rounded-md ${familyColor(family)}`}>
                        {family}
                      </span>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium text-artha-text truncate flex items-center gap-1.5">
                          {model.name}
                          {model.name === recommendedModel && (
                            <span className="shrink-0 inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-full bg-artha-accent/15 text-artha-accent text-[10px] font-semibold" title="Best measured quality + speed on this machine">
                              <Star size={9} /> Recommended
                            </span>
                          )}
                        </p>
                        {model.details?.parameter_size && (
                          <p className="text-xs text-artha-muted mt-0.5">
                            {model.details.parameter_size}
                            {model.details.quantization_level && ` · ${model.details.quantization_level}`}
                          </p>
                        )}
                        {/* Model Fit — measured on THIS machine (router benchmark). */}
                        {(() => {
                          const fit = fitFrom(profiles, model.name);
                          if (benching === model.name) {
                            return <p className="text-[11px] text-artha-muted mt-1 flex items-center gap-1"><RefreshCw size={9} className="animate-spin" /> Benchmarking on this machine…</p>;
                          }
                          if (!fit) {
                            return (
                              <p className="text-[11px] text-artha-subtle mt-1">
                                Not benchmarked ·{' '}
                                <span
                                  role="button"
                                  onClick={(e) => { e.stopPropagation(); void benchOne(model.name); }}
                                  className="text-artha-accent hover:underline cursor-pointer"
                                >
                                  measure speed &amp; fit
                                </span>
                              </p>
                            );
                          }
                          const { label, tone } = fitLabel(fit);
                          return (
                            <p className="text-[11px] mt-1 flex items-center gap-2 flex-wrap">
                              <span className={tone === 'good' ? 'text-artha-success' : tone === 'warn' ? 'text-artha-warn' : 'text-artha-muted'}>
                                {label}
                              </span>
                              <span className="text-artha-subtle" title="Measured here: paragraph-response time · planning time · tool-call JSON reliability">
                                ⚡ {fit.synthMs !== null ? `~${Math.max(1, Math.round(fit.synthMs / 1000))}s response` : '—'}
                                {fit.planMs !== null && ` · plan ~${Math.max(1, Math.round(fit.planMs / 1000))}s`}
                                {` · tools ${qMark(fit.toolQuality)}`}
                              </span>
                            </p>
                          );
                        })()}
                      </div>
                      <span className="text-xs text-artha-muted shrink-0">{formatSize(model.size)}</span>
                      <div className="shrink-0 w-5 flex items-center justify-center">
                        {isActive ? (
                          <CheckCircle2 size={16} className="text-artha-accent" />
                        ) : isLoading ? (
                          <RefreshCw size={14} className="text-artha-muted animate-spin" />
                        ) : (
                          <ChevronRight size={14} className="text-artha-muted" />
                        )}
                      </div>
                    </button>
                    {/* Uninstall — separate from the row's switch action. */}
                    <button
                      onClick={() => { setDeleteError(null); setConfirmDelete(model.name); }}
                      disabled={isDeleting || !!switching}
                      title="Uninstall model"
                      className="shrink-0 p-1.5 rounded-lg text-artha-muted hover:text-artha-danger hover:bg-artha-danger/10 transition-colors disabled:opacity-40"
                    >
                      {isDeleting
                        ? <RefreshCw size={13} className="animate-spin" />
                        : <Trash2 size={13} />}
                    </button>
                  </div>

                  {/* Inline confirm — deleting frees disk space and can't be undone. */}
                  {isConfirming && (
                    <div className="flex items-center justify-between gap-3 px-4 py-2.5 border-t border-artha-border bg-artha-danger/5 rounded-b-xl">
                      <p className="text-xs text-artha-muted">
                        Uninstall <span className="text-artha-text font-medium">{model.name}</span> and free {formatSize(model.size)}? You can re-pull it any time.
                      </p>
                      <div className="flex items-center gap-2 shrink-0">
                        <button
                          onClick={() => setConfirmDelete(null)}
                          disabled={isDeleting}
                          className="px-2.5 py-1 rounded-lg text-xs text-artha-muted hover:text-artha-text hover:bg-artha-text/5 transition-colors disabled:opacity-40"
                        >
                          Cancel
                        </button>
                        <button
                          onClick={() => deleteModel(model.name)}
                          disabled={isDeleting}
                          className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-artha-danger/15 hover:bg-artha-danger/25 text-artha-danger text-xs font-medium transition-colors disabled:opacity-40"
                        >
                          {isDeleting && <RefreshCw size={11} className="animate-spin" />}
                          Uninstall
                        </button>
                      </div>
                    </div>
                  )}

                  {/* Delete failure — shown beneath the row that failed. */}
                  {deleteError && confirmDelete === model.name && (
                    <p className="px-4 pb-2.5 text-xs text-artha-danger">{deleteError}</p>
                  )}
                </div>
              );
            })}
          </div>
        )
      )}

      {/* ── Browse & Install catalog ── */}
      {tab === 'browse' && (
        <div className="space-y-3">
          {MODEL_CATALOG.map((entry) => {
            const isInstalled = installedTags.has(entry.tag);
            const isActive = entry.tag === activeModel || entry.tag.split(':')[0] === activeModel?.split(':')[0];
            const progress = pulling[entry.tag];
            const isPulling = !!progress && progress.status !== 'success' && progress.status !== 'error';
            const fitsRam = !hardware || hardware.gbRam >= entry.ramRequired;

            return (
              <div
                key={entry.tag}
                className={`rounded-xl border p-4 transition-all ${
                  isInstalled && isActive
                    ? 'bg-artha-accent/10 border-artha-accent/40'
                    : isInstalled
                    ? 'bg-artha-s2 border-artha-accent/20'
                    : 'bg-artha-s2 border-artha-border'
                }`}
              >
                <div className="flex items-start gap-3">
                  {/* Family badge */}
                  <span className={`shrink-0 text-xs font-semibold px-2 py-0.5 rounded-md mt-0.5 ${familyColor(entry.family)}`}>
                    {entry.family}
                  </span>

                  {/* Info */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <p className="text-sm font-medium text-artha-text">{entry.label}</p>
                      {entry.badge && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-artha-accent/20 text-artha-accent font-medium">
                          {entry.badge}
                        </span>
                      )}
                      {!fitsRam && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-yellow-500/15 text-yellow-400 font-medium">
                          Needs {entry.ramRequired} GB RAM
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-artha-muted mt-0.5 leading-relaxed">{entry.description}</p>
                    <div className="flex items-center gap-3 mt-1.5">
                      <span className="text-[11px] text-artha-muted">{entry.size}</span>
                      <span className="text-artha-border">·</span>
                      <span className="flex items-center gap-1 text-[11px] text-artha-muted">
                        <Zap size={10} /> {entry.speed}
                      </span>
                      <span className="text-artha-border">·</span>
                      <code className="text-[10px] text-artha-muted font-mono">{entry.tag}</code>
                    </div>
                  </div>

                  {/* Action */}
                  <div className="shrink-0 flex flex-col items-end gap-1.5">
                    {isInstalled ? (
                      isActive ? (
                        <span className="flex items-center gap-1 text-xs text-artha-accent font-medium">
                          <CheckCircle2 size={13} /> Active
                        </span>
                      ) : (
                        <button
                          onClick={() => switchModel(entry.tag)}
                          disabled={!!switching}
                          className="px-3 py-1.5 rounded-lg border border-artha-accent/30 text-artha-accent hover:bg-artha-accent/10 text-xs font-medium transition-colors disabled:opacity-40"
                        >
                          Use this
                        </button>
                      )
                    ) : isPulling ? (
                      <div className="flex flex-col items-end gap-1">
                        <span className="flex items-center gap-1 text-xs text-artha-muted">
                          <RefreshCw size={11} className="animate-spin" />
                          {progress.status === 'starting' ? 'Starting…' : `${progress.percent ?? 0}%`}
                        </span>
                        {typeof progress.percent === 'number' && (
                          <div className="w-24 h-1 rounded-full bg-artha-text/8">
                            <div
                              className="h-1 rounded-full bg-artha-accent transition-all"
                              style={{ width: `${progress.percent}%` }}
                            />
                          </div>
                        )}
                      </div>
                    ) : progress?.status === 'error' ? (
                      <button
                        onClick={() => pullModel(entry.tag)}
                        className="px-3 py-1.5 rounded-lg border border-artha-danger/30 text-artha-danger hover:bg-artha-danger/10 text-xs font-medium transition-colors"
                      >
                        Retry
                      </button>
                    ) : progress?.status === 'success' ? (
                      <span className="flex items-center gap-1 text-xs text-artha-success">
                        <CheckCircle2 size={13} /> Installed
                      </span>
                    ) : (
                      <button
                        onClick={() => pullModel(entry.tag)}
                        disabled={!ollamaOnline}
                        className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-artha-accent/15 hover:bg-artha-accent/25 disabled:opacity-40 disabled:cursor-not-allowed text-artha-accent text-xs font-medium transition-colors"
                      >
                        <Download size={12} /> Pull
                      </button>
                    )}
                  </div>
                </div>

                {/* Error message */}
                {progress?.status === 'error' && progress.error && (
                  <p className="mt-2 text-xs text-artha-danger pl-14">{progress.error}</p>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* ── Cloud models (BYOK) ── */}
      <section className="mt-10 pt-6 border-t border-artha-border">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <Cloud size={14} className="text-artha-accent" />
            <h2 className="text-xs font-semibold text-artha-muted uppercase tracking-wide">Cloud Models (BYOK)</h2>
          </div>
          {!showCloudForm && (
            <button onClick={() => { setCloudError(''); setShowCloudForm(true); }}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-artha-accent/15 hover:bg-artha-accent/25 text-artha-accent text-xs font-medium transition-colors">
              <Plus size={12} /> Add cloud model
            </button>
          )}
        </div>

        <div className="flex items-start gap-2 mb-4 text-xs text-artha-muted bg-artha-s2 border border-artha-border rounded-lg px-3 py-2.5">
          <Shield size={13} className="text-artha-accent shrink-0 mt-0.5" />
          <p className="leading-relaxed">
            Optional. Local Ollama stays the default — Artha is private by design. A cloud model is only used when you
            activate it, and your API key is stored locally and sent only to the provider you choose.
          </p>
        </div>

        {/* Configured cloud models */}
        {cloudModels.length > 0 && (
          <div className="space-y-2 mb-4">
            {cloudModels.map(m => {
              const isActive = !!m.is_active;
              return (
                <div key={m.model_id}
                  className={`flex items-center gap-3 px-4 py-3 rounded-xl border ${
                    isActive ? 'bg-artha-accent/10 border-artha-accent/40' : 'bg-artha-s2 border-artha-border'
                  }`}>
                  <Cloud size={15} className="text-artha-accent shrink-0" />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-artha-text truncate">{m.name}</p>
                    <code className="text-[11px] text-artha-muted font-mono truncate block">{m.base_url}</code>
                  </div>
                  {isActive ? (
                    <span className="flex items-center gap-1 text-xs text-artha-accent font-medium">
                      <CheckCircle2 size={14} /> Active
                    </span>
                  ) : (
                    <button onClick={() => activateCloud(m)}
                      className="px-3 py-1.5 rounded-lg border border-artha-border text-artha-muted hover:text-artha-text hover:bg-artha-text/5 text-xs transition-colors">
                      Activate
                    </button>
                  )}
                  <button onClick={() => removeCloud(m)} title="Remove"
                    className="text-artha-muted hover:text-artha-danger transition-colors">
                    <Trash2 size={13} />
                  </button>
                </div>
              );
            })}
          </div>
        )}

        {/* Add-cloud form */}
        {showCloudForm && (
          <div className="bg-artha-s2 border border-artha-border rounded-xl p-4 space-y-3">
            <div className="flex gap-1.5">
              {(Object.keys(CLOUD_PROVIDERS) as (keyof typeof CLOUD_PROVIDERS)[]).map(p => (
                <button key={p} onClick={() => pickProvider(p)}
                  className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                    cloudProvider === p
                      ? 'bg-artha-accent/20 text-artha-text border border-artha-accent/30'
                      : 'bg-artha-surface border border-artha-border text-artha-muted hover:text-artha-text'
                  }`}>
                  {CLOUD_PROVIDERS[p].label}
                </button>
              ))}
            </div>

            <div>
              <label className="block text-xs font-medium text-artha-muted mb-1">Model name</label>
              <input value={cloudModel} onChange={e => setCloudModel(e.target.value)}
                placeholder={CLOUD_PROVIDERS[cloudProvider].modelHint}
                className="w-full bg-artha-surface border border-artha-border rounded-lg px-3 py-2 text-sm text-artha-text placeholder-artha-muted focus:border-artha-accent/50 focus:outline-none font-mono" />
            </div>

            {cloudProvider === 'custom' && (
              <div>
                <label className="block text-xs font-medium text-artha-muted mb-1">Base URL (OpenAI-compatible)</label>
                <input value={cloudBaseUrl} onChange={e => setCloudBaseUrl(e.target.value)}
                  placeholder="https://your-endpoint/v1"
                  className="w-full bg-artha-surface border border-artha-border rounded-lg px-3 py-2 text-sm text-artha-text placeholder-artha-muted focus:border-artha-accent/50 focus:outline-none font-mono" />
              </div>
            )}

            <div>
              <label className="block text-xs font-medium text-artha-muted mb-1 flex items-center gap-1.5">
                <Lock size={11} /> API key
              </label>
              <input type="password" value={cloudKey} onChange={e => setCloudKey(e.target.value)}
                placeholder="sk-…"
                className="w-full bg-artha-surface border border-artha-border rounded-lg px-3 py-2 text-sm text-artha-text placeholder-artha-muted focus:border-artha-accent/50 focus:outline-none font-mono" />
            </div>

            {cloudError && <p className="text-xs text-artha-danger">{cloudError}</p>}

            <div className="flex gap-2">
              <button onClick={saveCloudModel} disabled={savingCloud}
                className="flex items-center gap-1.5 px-4 py-2 rounded-lg bg-artha-accent hover:bg-artha-accent/80 disabled:opacity-40 text-sm font-medium transition-colors">
                {savingCloud ? <RefreshCw size={13} className="animate-spin" /> : <CheckCircle2 size={13} />}
                Save &amp; activate
              </button>
              <button onClick={() => { setShowCloudForm(false); setCloudError(''); }}
                className="px-4 py-2 rounded-lg text-sm text-artha-muted hover:text-artha-text hover:bg-artha-text/5 transition-colors">
                Cancel
              </button>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
