/**
 * ModelPicker — inline, searchable model switcher (top-bar chip).
 *
 * Replaces the old "click the chip → open Settings → Models" round-trip with a
 * dropdown right where the active model is shown: a "Find model…" filter over
 * every installed Ollama model (plus any configured cloud models), click to
 * switch. Selecting upserts + activates the model (`llm:setActiveModel` handles
 * models that were never explicitly "added") and pre-warms it via `ensureModel`
 * so it's ready by the time the user sends — the status banner shows progress.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Cpu, Check, Search, Loader2, Zap } from 'lucide-react';
import { activeModelFromStatus } from '../../lib/modelStatusLabel';

/** Mirror of main's AgentRoute (router/agentRouter.ts): which model actually
 *  runs the agent loop, and why. `source: 'auto'` means Artha overrode the
 *  user's pick (too large / failed tool calls) — shown, never silent. */
interface AgentRoute {
  model: string | null;
  source: 'pin' | 'user' | 'auto' | 'user-fallback' | 'none';
  reason: string;
  userPick: string | null;
  capB: number;
}

export default function ModelPicker({ refreshKey }: { refreshKey?: unknown }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [models, setModels] = useState<string[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [switching, setSwitching] = useState<string | null>(null);
  const [route, setRoute] = useState<AgentRoute | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Agent-role routing: what will ACTUALLY run actions. Loaded on mount /
  // refresh, and updated live when a run starts (agent:modelRouted).
  const loadRoute = () => {
    window.artha.router.getAgentRoute().then(setRoute).catch(() => setRoute(null));
  };
  useEffect(() => { loadRoute(); }, [refreshKey, active]);
  useEffect(() => {
    const off = window.artha.agent.onModelRouted((r) => setRoute(r));
    return () => { off(); };
  }, []);
  const pinAgent = async (name: string | null) => {
    try { setRoute(await window.artha.router.setAgentPin(name)); } catch { /* keep current */ }
  };
  const autoRouted = route?.source === 'auto' && route.model;

  // Load the active model (and refresh when the parent signals a change, e.g.
  // the Settings modal closing).
  useEffect(() => {
    window.artha.llm.getActiveModel().then(setActive).catch(() => setActive(null));
  }, [refreshKey]);

  // Stay current WITHOUT interaction: every activation path emits
  // `model:status` with the model name (onboarding finish, model switch,
  // BYOK add). Before this subscription the chip sat on "No model" after
  // onboarding until the user happened to click something (validation row 1
  // defect — stale state, missing invalidation).
  useEffect(() => {
    const off = window.artha.llm.onModelStatus((s) => {
      setActive(cur => activeModelFromStatus(cur, s));
    });
    return () => { off(); };
  }, []);

  // Pull the model list each time the dropdown opens (cheap, and picks up any
  // model the user just pulled). Union of installed Ollama models + configured
  // ones so cloud/added models aren't hidden.
  useEffect(() => {
    if (!open) return;
    setQuery('');
    Promise.all([
      window.artha.llm.listModels().catch(() => []) as Promise<{ name: string }[]>,
      window.artha.llm.listConfigured().catch(() => []) as Promise<{ ollama_name: string }[]>,
    ]).then(([installed, configured]) => {
      const names = new Set<string>();
      for (const m of installed) if (m?.name) names.add(m.name);
      for (const c of configured) if (c?.ollama_name) names.add(c.ollama_name);
      setModels([...names]);
    });
    // Focus the filter once the panel paints.
    const t = setTimeout(() => inputRef.current?.focus(), 0);
    return () => clearTimeout(t);
  }, [open]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = q ? models.filter(m => m.toLowerCase().includes(q)) : models;
    // Active model first, then alphabetical — predictable + the current pick is obvious.
    return [...list].sort((a, b) =>
      (a === active ? -1 : b === active ? 1 : 0) || a.localeCompare(b));
  }, [models, query, active]);

  const select = async (name: string) => {
    if (name === active) { setOpen(false); return; }
    setSwitching(name);
    try {
      await window.artha.llm.setActiveModel(name);
      setActive(name);
      setOpen(false);
      // Warm the newly-selected model so the next message is instant. Fire and
      // forget — progress surfaces in the ModelStatusBanner.
      window.artha.llm.ensureModel().catch(() => { /* status banner reports */ });
    } catch {
      /* leave the dropdown open so the user can retry */
    } finally {
      setSwitching(null);
    }
  };

  return (
    <div className="relative">
      <button
        onClick={() => setOpen(o => !o)}
        title={autoRouted
          ? `Actions run on ${route!.model} (automatic). ${route!.reason}`
          : active ? `Model: ${active} — click to switch` : 'Choose a model'}
        className="flex items-center gap-1.5 px-2 py-1 rounded-md border border-artha-border text-[11px] text-artha-muted hover:text-artha-text hover:border-artha-accent transition-colors"
      >
        {autoRouted
          ? <Zap size={10} className="text-artha-accent shrink-0" />
          : <Cpu size={10} className="text-artha-accent shrink-0" />}
        <span className="truncate max-w-[160px]">{autoRouted ? route!.model : (active ?? 'No model')}</span>
        {autoRouted && <span className="text-[9px] uppercase tracking-wide text-artha-accent">auto</span>}
      </button>

      {open && (
        <>
          {/* Click-away backdrop */}
          <div className="fixed inset-0 z-[70]" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-full mt-1.5 z-[71] w-64 rounded-xl bg-artha-surface-raised border border-artha-border shadow-modal overflow-hidden origin-top-right animate-scale-in">
            <div className="flex items-center gap-2 px-3 py-2 border-b border-artha-border">
              <Search size={13} className="text-artha-subtle shrink-0" />
              <input
                ref={inputRef}
                value={query}
                onChange={e => setQuery(e.target.value)}
                onKeyDown={e => { if (e.key === 'Escape') setOpen(false); }}
                placeholder="Find model…"
                className="flex-1 bg-transparent text-sm text-artha-text placeholder:text-artha-subtle focus:outline-none"
              />
            </div>
            {/* Agent-routing note: why the chip may differ from the pick, with the
                one-tap revert the founder asked for. Never shown when the pick
                simply runs as-is. */}
            {route && route.source !== 'user' && route.source !== 'none' && (
              <div className="px-3 py-2 border-b border-artha-border text-[11px] text-artha-muted space-y-1.5">
                <p className="leading-snug">{route.reason}</p>
                {route.source === 'auto' && route.userPick && (
                  <button onClick={() => pinAgent(route.userPick)} className="text-artha-accent hover:underline">
                    Use {route.userPick} anyway
                  </button>
                )}
                {route.source === 'pin' && (
                  <button onClick={() => pinAgent(null)} className="text-artha-accent hover:underline">
                    Back to automatic
                  </button>
                )}
              </div>
            )}
            <div className="max-h-72 overflow-y-auto py-1">
              {filtered.length === 0 ? (
                <p className="px-3 py-3 text-xs text-artha-muted">No models match.</p>
              ) : filtered.map(name => (
                <button
                  key={name}
                  onClick={() => select(name)}
                  className={`w-full flex items-center gap-2 px-3 py-2 text-left text-sm transition-colors hover:bg-artha-accent/5
                    ${name === active ? 'text-artha-text font-medium' : 'text-artha-muted hover:text-artha-text'}`}
                >
                  {switching === name
                    ? <Loader2 size={13} className="text-artha-accent shrink-0 animate-spin" />
                    : name === active
                      ? <Check size={13} className="text-artha-accent shrink-0" />
                      : <span className="w-[13px] shrink-0" />}
                  <span className="truncate">{name}</span>
                </button>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
