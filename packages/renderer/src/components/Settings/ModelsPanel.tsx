/**
 * ModelsPanel — browse available Ollama models, see hardware info,
 * and set the active model with one click. Includes a curated catalog
 * so users can pull new models directly from the UI.
 */
import { useEffect, useState } from 'react';
import {
  Cpu, CheckCircle2, RefreshCw, HardDrive,
  ChevronRight, Cloud, Plus, Trash2, Lock, Shield, Download, Zap,
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
function formatSize(bytes: number): string {
  const gb = bytes / 1024 / 1024 / 1024;
  return gb >= 1 ? `${gb.toFixed(1)} GB` : `${(bytes / 1024 / 1024).toFixed(0)} MB`;
}

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

function familyColor(family: string): string {
  const map: Record<string, string> = {
    Qwen: 'text-blue-400 bg-blue-400/10',
    Llama: 'text-orange-400 bg-orange-400/10',
    Mistral: 'text-violet-400 bg-violet-400/10',
    Gemma: 'text-teal-400 bg-teal-400/10',
    Phi: 'text-pink-400 bg-pink-400/10',
    DeepSeek: 'text-cyan-400 bg-cyan-400/10',
    CodeLlama: 'text-yellow-400 bg-yellow-400/10',
    Nomic: 'text-green-400 bg-green-400/10',
  };
  return map[family] ?? 'text-artha-muted bg-white/5';
}

export default function ModelsPanel() {
  const [models, setModels] = useState<OllamaModel[]>([]);
  const [activeModel, setActiveModelState] = useState<string | null>(null);
  const [hardware, setHardware] = useState<HardwareInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [switching, setSwitching] = useState<string | null>(null);
  const [ollamaOnline, setOllamaOnline] = useState(true);

  // Pull progress — keyed by model tag
  const [pulling, setPulling] = useState<Record<string, PullProgress>>({});

  // Context window state
  const [ctxWindow, setCtxWindow] = useState<number>(4096);
  const [ctxSaving, setCtxSaving] = useState(false);

  // BYOK cloud state
  const [configured, setConfigured] = useState<ConfiguredModel[]>([]);
  const [showCloudForm, setShowCloudForm] = useState(false);
  const [cloudProvider, setCloudProvider] = useState<keyof typeof CLOUD_PROVIDERS>('openai');
  const [cloudModel, setCloudModel] = useState('');
  const [cloudBaseUrl, setCloudBaseUrl] = useState(CLOUD_PROVIDERS.openai.baseUrl);
  const [cloudKey, setCloudKey] = useState('');
  const [savingCloud, setSavingCloud] = useState(false);
  const [cloudError, setCloudError] = useState('');

  // Catalog tab: 'installed' | 'browse'
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

  // Subscribe to pull progress events
  useEffect(() => {
    const unsub = window.artha.llm.onPullProgress((p: PullProgress) => {
      setPulling(prev => ({ ...prev, [p.name]: p }));
      // On success, refresh the installed list, clear progress, and switch to Installed tab
      if (p.status === 'success') {
        setTimeout(() => {
          setPulling(prev => { const n = { ...prev }; delete n[p.name]; return n; });
          setTab('installed');
          load();
        }, 1200);
      }
    });
    // Wrap in a void arrow — the preload unsub returns IpcRenderer, which is not
    // a valid useEffect Destructor (must return void).
    return () => { unsub(); };
  }, []);

  useEffect(() => { load(); }, []);

  const cloudModels = configured.filter(
    m => !m.base_url.includes('localhost') && !m.base_url.includes('127.0.0.1')
  );

  const installedTags = new Set(models.map(m => m.name));

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
      await window.artha.llm.addCloudModel({
        provider: cloudProvider,
        label: `${CLOUD_PROVIDERS[cloudProvider].label}: ${cloudModel.trim()}`,
        model: cloudModel.trim(),
        baseUrl: cloudBaseUrl.trim(),
        apiKey: cloudKey.trim(),
        activate: true,
      });
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

  const saveContextWindow = async () => {
    const active = configured.find(m => m.is_active);
    if (!active) return;
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
            <h1 className="text-base font-semibold text-white">Models</h1>
            <p className="text-xs text-artha-muted">Local Ollama models + cloud API keys</p>
          </div>
        </div>
        <button onClick={load} disabled={loading}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-artha-border text-artha-muted hover:text-white hover:bg-white/5 text-xs transition-colors disabled:opacity-40">
          <RefreshCw size={12} className={loading ? 'animate-spin' : ''} /> Refresh
        </button>
      </div>

      {/* Hardware card */}
      {hardware && (
        <div className="bg-artha-s2 border border-artha-border rounded-xl p-4 mb-6">
          {/* GPU · RAM summary line */}
          <div className="flex items-center gap-2 flex-wrap">
            <Cpu size={15} className="text-artha-accent shrink-0" />
            <span className="text-sm font-medium text-white">
              {hardware.gpuName && <>{hardware.gpuName} · </>}
              {hardware.gbRam} GB RAM
              {hardware.vramGb ? <> · {hardware.vramGb} GB VRAM</> : null}
            </span>
          </div>
          {/* Recommendation */}
          <div className="flex items-start gap-2 mt-2">
            <HardDrive size={15} className="text-artha-muted mt-0.5 shrink-0" />
            <p className="text-xs text-artha-muted leading-relaxed">
              Recommended: <span className="text-white">{hardware.recommendation}</span>
            </p>
          </div>
        </div>
      )}

      {/* Ollama offline warning */}
      {!ollamaOnline && (
        <div className="bg-red-500/10 border border-red-500/20 rounded-xl p-4 mb-6 text-sm text-red-400">
          Ollama is not running. Start it with{' '}
          <code className="bg-red-500/10 px-1.5 py-0.5 rounded font-mono text-xs">ollama serve</code>{' '}
          then refresh. Or use a cloud model below.
        </div>
      )}

      {/* Active model badge + context window */}
      {activeModel && (
        <div className="mb-5 rounded-xl border border-white/10 bg-white/3 p-4 space-y-3">
          <div className="flex items-center gap-2">
            <CheckCircle2 size={14} className="text-green-400 shrink-0" />
            <span className="text-xs text-artha-muted">Active model: </span>
            <code className="text-xs text-green-400 font-mono truncate">{activeModel}</code>
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
                  className="w-24 bg-black/30 border border-white/10 rounded-lg px-2 py-1 text-xs text-white text-right font-mono focus:outline-none focus:border-artha-accent/50"
                />
                <span className="text-xs text-artha-muted">tokens</span>
                {ctxSaving && <RefreshCw size={11} className="text-artha-muted animate-spin" />}
              </div>
            </div>
            <input
              type="range" min={512} max={128000} step={512} value={ctxWindow}
              onChange={e => setCtxWindow(Number(e.target.value))}
              onMouseUp={saveContextWindow} onTouchEnd={saveContextWindow}
              className="w-full h-1 rounded-full bg-white/10 accent-artha-accent cursor-pointer"
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
            tab === 'installed' ? 'bg-artha-accent/20 text-white' : 'text-artha-muted hover:text-white'
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
            tab === 'browse' ? 'bg-artha-accent/20 text-white' : 'text-artha-muted hover:text-white'
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
            <p className="text-sm font-medium text-white mb-1">No models installed yet</p>
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
              return (
                <button
                  key={model.name}
                  onClick={() => switchModel(model.name)}
                  disabled={isActive || !!switching}
                  className={`w-full flex items-center gap-4 px-4 py-3.5 rounded-xl border text-left transition-all
                    ${isActive
                      ? 'bg-artha-accent/10 border-artha-accent/40 cursor-default'
                      : 'bg-artha-s2 border-artha-border hover:border-artha-accent/30 hover:bg-artha-accent/5 disabled:opacity-50 disabled:cursor-wait'
                    }`}
                >
                  <span className={`shrink-0 text-xs font-semibold px-2 py-0.5 rounded-md ${familyColor(family)}`}>
                    {family}
                  </span>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-white truncate">{model.name}</p>
                    {model.details?.parameter_size && (
                      <p className="text-xs text-artha-muted mt-0.5">
                        {model.details.parameter_size}
                        {model.details.quantization_level && ` · ${model.details.quantization_level}`}
                      </p>
                    )}
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
                      <p className="text-sm font-medium text-white">{entry.label}</p>
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
                          <div className="w-24 h-1 rounded-full bg-white/10">
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
                        className="px-3 py-1.5 rounded-lg border border-red-500/30 text-red-400 hover:bg-red-500/10 text-xs font-medium transition-colors"
                      >
                        Retry
                      </button>
                    ) : progress?.status === 'success' ? (
                      <span className="flex items-center gap-1 text-xs text-green-400">
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
                  <p className="mt-2 text-xs text-red-400 pl-14">{progress.error}</p>
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
                    <p className="text-sm font-medium text-white truncate">{m.name}</p>
                    <code className="text-[11px] text-artha-muted font-mono truncate block">{m.base_url}</code>
                  </div>
                  {isActive ? (
                    <span className="flex items-center gap-1 text-xs text-artha-accent font-medium">
                      <CheckCircle2 size={14} /> Active
                    </span>
                  ) : (
                    <button onClick={() => activateCloud(m)}
                      className="px-3 py-1.5 rounded-lg border border-artha-border text-artha-muted hover:text-white hover:bg-white/5 text-xs transition-colors">
                      Activate
                    </button>
                  )}
                  <button onClick={() => removeCloud(m)} title="Remove"
                    className="text-artha-muted hover:text-red-400 transition-colors">
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
                      ? 'bg-artha-accent/20 text-white border border-artha-accent/30'
                      : 'bg-artha-surface border border-artha-border text-artha-muted hover:text-white'
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

            {cloudError && <p className="text-xs text-red-400">{cloudError}</p>}

            <div className="flex gap-2">
              <button onClick={saveCloudModel} disabled={savingCloud}
                className="flex items-center gap-1.5 px-4 py-2 rounded-lg bg-artha-accent hover:bg-artha-accent/80 disabled:opacity-40 text-sm font-medium transition-colors">
                {savingCloud ? <RefreshCw size={13} className="animate-spin" /> : <CheckCircle2 size={13} />}
                Save &amp; activate
              </button>
              <button onClick={() => { setShowCloudForm(false); setCloudError(''); }}
                className="px-4 py-2 rounded-lg text-sm text-artha-muted hover:text-white hover:bg-white/5 transition-colors">
                Cancel
              </button>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
