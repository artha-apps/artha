/**
 * ModelsPanel — browse available Ollama models, see hardware info,
 * and set the active model with one click.
 */
import { useEffect, useState } from 'react';
import { Cpu, CheckCircle2, RefreshCw, HardDrive, MemoryStick, ChevronRight, Cloud, Plus, Trash2, Lock, Shield } from 'lucide-react';

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
}

/** Bytes → human-readable size for the model card. */
function formatSize(bytes: number): string {
  const gb = bytes / 1024 / 1024 / 1024;
  return gb >= 1 ? `${gb.toFixed(1)} GB` : `${(bytes / 1024 / 1024).toFixed(0)} MB`;
}

/** Infer the model family from its Ollama tag name. Drives the colored badge
 *  in the model card. Returns a generic "Model" label for anything unknown. */
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

  // ── Context window state ──────────────────────────────────────────────────
  // Tracks the context window setting for the currently-active configured model.
  // Saved on blur / Enter so the user doesn't have to click a separate button.
  const [ctxWindow, setCtxWindow] = useState<number>(4096);
  const [ctxSaving, setCtxSaving] = useState(false);

  // ── BYOK cloud state ──────────────────────────────────────────────────────
  const [configured, setConfigured] = useState<ConfiguredModel[]>([]);
  const [showCloudForm, setShowCloudForm] = useState(false);
  const [cloudProvider, setCloudProvider] = useState<keyof typeof CLOUD_PROVIDERS>('openai');
  const [cloudModel, setCloudModel] = useState('');
  const [cloudBaseUrl, setCloudBaseUrl] = useState(CLOUD_PROVIDERS.openai.baseUrl);
  const [cloudKey, setCloudKey] = useState('');
  const [savingCloud, setSavingCloud] = useState(false);
  const [cloudError, setCloudError] = useState('');

  /** Pull model list + hardware info + active model in parallel.
   *  Ollama reachability is checked independently so a hardware-detection
   *  failure never falsely shows the "Ollama not running" banner. */
  const load = async () => {
    setLoading(true);

    // ── 1. Ollama reachability — checked on its own so nothing else poisons it ──
    try {
      const online = await (window.artha.llm.checkOllama() as Promise<boolean>);
      setOllamaOnline(online);
    } catch {
      setOllamaOnline(false);
    }

    // ── 2. Configured (saved) models — cloud BYOK must show even when Ollama is offline ──
    window.artha.llm.listConfigured().then(c => {
      const list = c as ConfiguredModel[];
      setConfigured(list);
      const activeRow = list.find(m => m.is_active);
      if (activeRow) setCtxWindow(activeRow.context_window ?? 4096);
    }).catch(() => {});

    // ── 3. Model list + hardware + active model — failures here don't affect the banner ──
    try {
      const [modelList, hw, active] = await Promise.all([
        window.artha.llm.listModels() as Promise<OllamaModel[]>,
        window.artha.llm.detectHardware() as Promise<HardwareInfo>,
        window.artha.llm.getActiveModel() as Promise<string | null>,
      ]);
      setModels(modelList);
      setHardware(hw);

      // If no model is marked active in DB, default-highlight qwen2.5:7b
      // (matches the LLM client fallback) — or the first available model
      if (!active && modelList.length > 0) {
        const preferred = modelList.find(m => m.name.startsWith('qwen2.5')) ?? modelList[0];
        setActiveModelState(preferred.name);
      } else {
        setActiveModelState(active);
      }
    } catch {
      // Model list / hardware failures are silent — banner is driven by checkOllama only
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  /** Cloud models live in the same table but with a non-local base_url. */
  const cloudModels = configured.filter(m => !m.base_url.includes('localhost') && !m.base_url.includes('127.0.0.1'));

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

  /** Persist the new active model and reflect it in local state. Guards against
   *  double-click races via the `switching` flag. */
  const switchModel = async (name: string) => {
    if (switching) return;
    setSwitching(name);
    try {
      await window.artha.llm.setActiveModel(name);
      setActiveModelState(name);
      // Reload configured list so context_window is synced for the newly-active row.
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
            <p className="text-xs text-artha-muted">Manage your local Ollama models</p>
          </div>
        </div>
        <button onClick={load} disabled={loading}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-artha-border text-artha-muted hover:text-white hover:bg-white/5 text-xs transition-colors disabled:opacity-40">
          <RefreshCw size={12} className={loading ? 'animate-spin' : ''} /> Refresh
        </button>
      </div>

      {/* Hardware card */}
      {hardware && (
        <div className="bg-artha-s2 border border-artha-border rounded-xl p-4 mb-6 flex items-center gap-6">
          <div className="flex items-center gap-2">
            <MemoryStick size={15} className="text-artha-accent" />
            <span className="text-sm font-medium text-white">{hardware.gbRam} GB RAM</span>
          </div>
          <div className="w-px h-5 bg-artha-border" />
          <div className="flex items-start gap-2 flex-1">
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
          Ollama is not running. Start it with <code className="bg-red-500/10 px-1.5 py-0.5 rounded font-mono text-xs">ollama serve</code> then refresh.
        </div>
      )}

      {/* Active model badge + context window config */}
      {activeModel && (
        <div className="mb-5 rounded-xl border border-white/10 bg-white/3 p-4 space-y-3">
          <div className="flex items-center gap-2">
            <CheckCircle2 size={14} className="text-green-400 shrink-0" />
            <span className="text-xs text-artha-muted">Active model: </span>
            <code className="text-xs text-green-400 font-mono truncate">{activeModel}</code>
          </div>
          {/* Context window slider — controls max_tokens sent to the model */}
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
              type="range"
              min={512}
              max={128000}
              step={512}
              value={ctxWindow}
              onChange={e => setCtxWindow(Number(e.target.value))}
              onMouseUp={saveContextWindow}
              onTouchEnd={saveContextWindow}
              className="w-full h-1 rounded-full bg-white/10 accent-artha-accent cursor-pointer"
            />
            <div className="flex justify-between text-[10px] text-artha-muted/60">
              <span>512</span>
              <span>8 k</span>
              <span>32 k</span>
              <span>128 k</span>
            </div>
          </div>
        </div>
      )}

      {/* Model list */}
      {loading ? (
        <div className="space-y-3">
          {[1, 2, 3].map(i => (
            <div key={i} className="h-16 bg-artha-s2 border border-artha-border rounded-xl animate-pulse" />
          ))}
        </div>
      ) : models.length === 0 ? (
        <div className="text-center py-16 text-artha-muted">
          <Cpu size={32} className="mx-auto mb-3 opacity-30" />
          <p className="text-sm font-medium text-white mb-1">No models installed</p>
          <p className="text-xs">Run <code className="bg-white/5 px-1.5 py-0.5 rounded font-mono">ollama pull qwen2.5:7b</code> to get started</p>
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
                {/* Family badge */}
                <span className={`shrink-0 text-xs font-semibold px-2 py-0.5 rounded-md ${familyColor(family)}`}>
                  {family}
                </span>

                {/* Name + details */}
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-white truncate">{model.name}</p>
                  {model.details?.parameter_size && (
                    <p className="text-xs text-artha-muted mt-0.5">
                      {model.details.parameter_size}
                      {model.details.quantization_level && ` · ${model.details.quantization_level}`}
                    </p>
                  )}
                </div>

                {/* Size */}
                <span className="text-xs text-artha-muted shrink-0">{formatSize(model.size)}</span>

                {/* Status indicator */}
                <div className="shrink-0 w-5 flex items-center justify-center">
                  {isActive ? (
                    <CheckCircle2 size={16} className="text-artha-accent" />
                  ) : isLoading ? (
                    <RefreshCw size={14} className="text-artha-muted animate-spin" />
                  ) : (
                    <ChevronRight size={14} className="text-artha-muted opacity-0 group-hover:opacity-100" />
                  )}
                </div>
              </button>
            );
          })}
        </div>
      )}

      <p className="text-xs text-artha-muted text-center mt-8">
        Pull new models via terminal: <code className="bg-white/5 px-1.5 py-0.5 rounded font-mono">ollama pull &lt;model-name&gt;</code>
      </p>

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
                    cloudProvider === p ? 'bg-artha-accent/20 text-white border border-artha-accent/30' : 'bg-artha-surface border border-artha-border text-artha-muted hover:text-white'
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
                Save & activate
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
