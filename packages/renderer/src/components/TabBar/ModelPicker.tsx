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
import { Cpu, Check, Search, Loader2 } from 'lucide-react';

export default function ModelPicker({ refreshKey }: { refreshKey?: unknown }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [models, setModels] = useState<string[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [switching, setSwitching] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Load the active model (and refresh when the parent signals a change, e.g.
  // the Settings modal closing).
  useEffect(() => {
    window.artha.llm.getActiveModel().then(setActive).catch(() => setActive(null));
  }, [refreshKey]);

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
        title={active ? `Model: ${active} — click to switch` : 'Choose a model'}
        className="flex items-center gap-1.5 px-2 py-1 rounded-md border border-artha-border text-[11px] text-artha-muted hover:text-artha-text hover:border-artha-accent transition-colors"
      >
        <Cpu size={10} className="text-artha-accent shrink-0" />
        <span className="truncate max-w-[160px]">{active ?? 'No model'}</span>
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
