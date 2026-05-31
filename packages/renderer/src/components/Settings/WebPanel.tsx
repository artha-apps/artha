/**
 * WebPanel — manage Artha's built-in browsing capability.
 *
 *   • SearXNG instances (the metasearch backend, no API key needed)
 *   • Cache TTL & on-disk cache stats
 *   • Robots.txt policy + per-host override allowlist
 *   • Request timeout & max response size
 *
 * No data leaves the machine apart from the explicit fetch / search the
 * agent makes — this panel is also a privacy disclosure surface.
 */
import { useEffect, useState } from 'react';
import {
  Globe, Search, Shield, Plus, Trash2, RefreshCw, Database,
  CheckCircle2, Info, Clock, AlertTriangle,
} from 'lucide-react';

/** Mirrors the backend `WebConfig` in tools/web.ts. Edits round-trip through
 *  settings.json so they survive restarts. */
interface WebConfig {
  searxng_instances: string[];
  cache_ttl_seconds: number;
  respect_robots: boolean;
  robots_override_hosts: string[];
  timeout_ms: number;
  max_bytes: number;
  brave_api_key?: string;
}

/** Cache size summary from the backend — shown next to the "Clear cache" button. */
interface CacheStats { count: number; bytes: number; }

function humanBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function humanDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)} min`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)} hr`;
  return `${Math.round(seconds / 86400)} days`;
}

/** Web settings panel — configures search providers, cache, and network limits. */
export default function WebPanel() {
  // ── State ──────────────────────────────────────────────────────────────────
  const [config, setConfig] = useState<WebConfig | null>(null);
  const [stats, setStats] = useState<CacheStats>({ count: 0, bytes: 0 });
  // Controlled inputs for the SearXNG and robots override add-forms.
  const [newInstance, setNewInstance] = useState('');
  const [newOverride, setNewOverride] = useState('');
  const [saving, setSaving] = useState(false);
  const [clearing, setClearing] = useState(false);
  // `saved` drives a transient "Saved ✓" pill that auto-dismisses after 1.5 s.
  const [saved, setSaved] = useState(false);

  const load = async () => {
    const [cfg, st] = await Promise.all([
      window.artha.settings.getWebConfig() as Promise<WebConfig>,
      window.artha.web.getCacheStats(),
    ]);
    setConfig(cfg);
    setStats(st);
  };

  useEffect(() => { load(); }, []);

  /** Partial-update the persisted WebConfig and reflect the server's resolved
   *  config back into local state. Flashes a "Saved" pill for 1.5s. */
  const patch = async (next: Partial<WebConfig>) => {
    if (!config) return;
    setSaving(true);
    const updated = await window.artha.settings.setWebConfig(next) as WebConfig;
    setConfig(updated);
    setSaving(false);
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  };

  // ── Handlers ───────────────────────────────────────────────────────────────

  const addInstance = async () => {
    // Strip trailing slashes so duplicates don't sneak in with differing trailing /.
    const url = newInstance.trim().replace(/\/+$/, '');
    if (!url || !config) return;
    if (!/^https?:\/\//.test(url)) return;
    if (config.searxng_instances.includes(url)) { setNewInstance(''); return; }
    await patch({ searxng_instances: [...config.searxng_instances, url] });
    setNewInstance('');
  };

  const removeInstance = async (url: string) => {
    if (!config) return;
    await patch({ searxng_instances: config.searxng_instances.filter(i => i !== url) });
  };

  const addOverride = async () => {
    // Normalise: strip scheme + path so "https://example.com/path" becomes "example.com".
    const host = newOverride.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
    if (!host || !config) return;
    if (config.robots_override_hosts.includes(host)) { setNewOverride(''); return; }
    await patch({ robots_override_hosts: [...config.robots_override_hosts, host] });
    setNewOverride('');
  };

  const removeOverride = async (host: string) => {
    if (!config) return;
    await patch({ robots_override_hosts: config.robots_override_hosts.filter(h => h !== host) });
  };

  const clearCache = async () => {
    setClearing(true);
    await window.artha.web.clearCache();
    await load();
    setClearing(false);
  };

  if (!config) {
    return (
      <div className="flex-1 flex items-center justify-center text-artha-muted text-sm">
        Loading…
      </div>
    );
  }

  // True when any configured SearXNG instance is not on the local machine — triggers
  // the privacy advisory banner that recommends a self-hosted instance.
  const usingPublicInstance = config.searxng_instances.some(
    i => !/localhost|127\.0\.0\.1|0\.0\.0\.0/.test(i)
  );

  return (
    <div className="flex-1 overflow-y-auto px-8 py-8 max-w-3xl mx-auto w-full">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg bg-artha-accent/20 flex items-center justify-center">
            <Globe size={16} className="text-artha-accent" />
          </div>
          <div>
            <h1 className="text-base font-semibold text-artha-text">Web</h1>
            <p className="text-xs text-artha-muted">
              Built-in fetch + search. No browser, no MCP install needed.
            </p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          {saved && (
            <span className="flex items-center gap-1 text-xs text-green-400">
              <CheckCircle2 size={12} /> Saved
            </span>
          )}
          {saving && <RefreshCw size={12} className="text-artha-muted animate-spin" />}
        </div>
      </div>

      {/* Privacy note */}
      <div className="rounded-xl bg-artha-s2 border border-artha-border p-4 mb-6 flex gap-3">
        <Info size={14} className="text-artha-accent shrink-0 mt-0.5" />
        <p className="text-xs text-artha-muted leading-relaxed">
          Artha only contacts the web when the agent explicitly calls{' '}
          <code className="text-artha-accent font-mono">web_fetch</code> or{' '}
          <code className="text-artha-accent font-mono">web_search</code>. Every
          request is logged in <strong className="text-artha-text">MCP Tools → Audit Log</strong>{' '}
          and identifies itself with a transparent User-Agent.
        </p>
      </div>

      {/* Search provider status summary */}
      <div className="rounded-xl bg-artha-s2 border border-artha-border p-4 mb-6">
        <p className="text-xs font-semibold text-artha-text mb-2">Search provider priority</p>
        <div className="space-y-1.5">
          {[
            { label: '1. Brave Search API', active: !!config.brave_api_key?.trim(), note: config.brave_api_key?.trim() ? 'Active — fastest, real-time' : 'No key — skipped' },
            { label: '2. SearXNG', active: config.searxng_instances.length > 0, note: config.searxng_instances.length > 0 ? `${config.searxng_instances.length} instance(s) configured` : 'No instances — skipped' },
            { label: '3. DuckDuckGo HTML', active: true, note: 'Always available as fallback' },
          ].map(({ label, active, note }) => (
            <div key={label} className="flex items-center gap-2">
              <div className={`w-1.5 h-1.5 rounded-full shrink-0 ${active ? 'bg-green-400' : 'bg-artha-muted/40'}`} />
              <span className={`text-xs ${active ? 'text-artha-text' : 'text-artha-muted'}`}>{label}</span>
              <span className="text-[10px] text-artha-muted ml-auto">{note}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Brave Search API key */}
      <section className="mb-8">
        <div className="flex items-center gap-2 mb-3">
          <Search size={13} className="text-artha-accent" />
          <h2 className="text-xs font-semibold text-artha-muted uppercase tracking-wide">
            Brave Search API (optional)
          </h2>
        </div>
        <p className="text-xs text-artha-muted mb-3 leading-relaxed">
          Get higher-quality, real-time results. Free tier: 2,000 queries/month.
          Get a key at{' '}
          <span className="text-artha-accent font-mono">brave.com/search/api</span>.
          Leave blank to skip Brave and use SearXNG instead.
        </p>
        <div className="flex gap-2">
          <input
            type="password"
            value={config.brave_api_key ?? ''}
            onChange={e => patch({ brave_api_key: e.target.value })}
            placeholder="BSA••••••••••••••••••••••••••••••••••••••"
            className="flex-1 bg-artha-s2 border border-artha-border rounded-lg px-3 py-2 text-xs text-artha-text placeholder-artha-muted focus:border-artha-accent/50 focus:outline-none font-mono"
          />
          {config.brave_api_key?.trim() && (
            <button
              onClick={() => patch({ brave_api_key: '' })}
              className="px-3 py-2 rounded-lg bg-red-500/10 hover:bg-red-500/20 text-red-400 text-xs transition-colors"
              title="Remove API key"
            >
              <Trash2 size={12} />
            </button>
          )}
        </div>
      </section>

      {/* SearXNG instances */}
      <section className="mb-8">
        <div className="flex items-center gap-2 mb-3">
          <Search size={13} className="text-artha-accent" />
          <h2 className="text-xs font-semibold text-artha-muted uppercase tracking-wide">
            SearXNG instances
          </h2>
        </div>
        <p className="text-xs text-artha-muted mb-3 leading-relaxed">
          Privacy-respecting metasearch fallback. Queries fall through
          the list in order — add your self-hosted instance at the top for fully
          local search.
        </p>

        {usingPublicInstance && (
          <div className="rounded-xl bg-amber-500/5 border border-amber-500/20 p-3 mb-3 flex gap-2">
            <AlertTriangle size={13} className="text-amber-400 shrink-0 mt-0.5" />
            <p className="text-xs text-amber-100/80 leading-relaxed">
              You're using a public SearXNG instance. For true local-first
              browsing, run{' '}
              <code className="text-amber-200 font-mono">docker run -p 8888:8080 searxng/searxng</code>
              {' '}and add <code className="text-amber-200 font-mono">http://localhost:8888</code> here.
            </p>
          </div>
        )}

        <div className="space-y-2 mb-3">
          {config.searxng_instances.map((url, i) => (
            <div key={url} className="flex items-center gap-2 px-3 py-2 rounded-lg bg-artha-s2 border border-artha-border">
              <span className="text-[10px] text-artha-muted font-mono w-5">#{i + 1}</span>
              <code className="text-xs text-artha-text flex-1 truncate font-mono">{url}</code>
              <button
                onClick={() => removeInstance(url)}
                title="Remove instance"
                className="text-artha-muted hover:text-red-400 transition-colors"
              >
                <Trash2 size={12} />
              </button>
            </div>
          ))}
          {config.searxng_instances.length === 0 && (
            <p className="text-xs text-red-400 px-3 py-2 bg-red-500/5 border border-red-500/20 rounded-lg">
              No instances configured — web_search will fail until you add one.
            </p>
          )}
        </div>

        <div className="flex gap-2">
          <input
            value={newInstance}
            onChange={e => setNewInstance(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && addInstance()}
            placeholder="https://your-searxng-instance.example"
            className="flex-1 bg-artha-s2 border border-artha-border rounded-lg px-3 py-2 text-xs text-artha-text placeholder-artha-muted focus:border-artha-accent/50 focus:outline-none font-mono"
          />
          <button
            onClick={addInstance}
            disabled={!newInstance.trim()}
            className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-artha-accent hover:bg-artha-accent/80 disabled:opacity-40 disabled:cursor-not-allowed text-xs font-medium transition-colors"
          >
            <Plus size={12} /> Add
          </button>
        </div>
      </section>

      {/* Robots.txt */}
      <section className="mb-8">
        <div className="flex items-center gap-2 mb-3">
          <Shield size={13} className="text-artha-accent" />
          <h2 className="text-xs font-semibold text-artha-muted uppercase tracking-wide">
            Robots.txt policy
          </h2>
        </div>

        <label className="flex items-start gap-3 px-4 py-3 rounded-xl bg-artha-s2 border border-artha-border cursor-pointer hover:bg-white/[0.02] transition-colors mb-3">
          <input
            type="checkbox"
            checked={config.respect_robots}
            onChange={e => patch({ respect_robots: e.target.checked })}
            className="mt-0.5 accent-artha-accent"
          />
          <div className="flex-1">
            <p className="text-sm text-artha-text">Respect robots.txt</p>
            <p className="text-xs text-artha-muted leading-relaxed mt-0.5">
              Honour each site's crawler rules. Recommended — turning this off
              risks being IP-blocked and is impolite.
            </p>
          </div>
        </label>

        <div>
          <p className="text-xs font-medium text-artha-muted mb-2">
            Override hosts <span className="text-artha-muted/60">— allowed to bypass robots.txt</span>
          </p>
          <div className="space-y-1.5 mb-2">
            {config.robots_override_hosts.length === 0 ? (
              <p className="text-xs text-artha-muted/60 italic">No overrides</p>
            ) : (
              config.robots_override_hosts.map(host => (
                <div key={host} className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-artha-s2 border border-artha-border">
                  <code className="text-xs text-artha-text flex-1 font-mono">{host}</code>
                  <button
                    onClick={() => removeOverride(host)}
                    className="text-artha-muted hover:text-red-400 transition-colors"
                  >
                    <Trash2 size={11} />
                  </button>
                </div>
              ))
            )}
          </div>
          <div className="flex gap-2">
            <input
              value={newOverride}
              onChange={e => setNewOverride(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && addOverride()}
              placeholder="example.com"
              className="flex-1 bg-artha-s2 border border-artha-border rounded-lg px-3 py-1.5 text-xs text-artha-text placeholder-artha-muted focus:border-artha-accent/50 focus:outline-none font-mono"
            />
            <button
              onClick={addOverride}
              disabled={!newOverride.trim()}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-artha-s2 border border-artha-border hover:bg-artha-text/5 disabled:opacity-40 disabled:cursor-not-allowed text-xs text-artha-muted hover:text-artha-text transition-colors"
            >
              <Plus size={11} /> Add host
            </button>
          </div>
        </div>
      </section>

      {/* Cache */}
      <section className="mb-8">
        <div className="flex items-center gap-2 mb-3">
          <Database size={13} className="text-artha-accent" />
          <h2 className="text-xs font-semibold text-artha-muted uppercase tracking-wide">
            Fetch cache
          </h2>
        </div>

        <div className="grid grid-cols-2 gap-2 mb-3">
          <div className="px-4 py-3 rounded-xl bg-artha-s2 border border-artha-border">
            <p className="text-[10px] uppercase tracking-wider text-artha-muted mb-1">Cached pages</p>
            <p className="text-lg font-semibold text-artha-text">{stats.count}</p>
          </div>
          <div className="px-4 py-3 rounded-xl bg-artha-s2 border border-artha-border">
            <p className="text-[10px] uppercase tracking-wider text-artha-muted mb-1">On disk</p>
            <p className="text-lg font-semibold text-artha-text">{humanBytes(stats.bytes)}</p>
          </div>
        </div>

        <div className="rounded-xl bg-artha-s2 border border-artha-border p-4 mb-3">
          <label className="block">
            <div className="flex items-center justify-between mb-1.5">
              <span className="text-xs font-medium text-artha-text flex items-center gap-1.5">
                <Clock size={11} /> Cache TTL
              </span>
              <span className="text-xs text-artha-accent font-mono">
                {humanDuration(config.cache_ttl_seconds)}
              </span>
            </div>
            <input
              type="range"
              min={60}
              max={86400}
              step={60}
              value={config.cache_ttl_seconds}
              onChange={e => patch({ cache_ttl_seconds: Number(e.target.value) })}
              className="w-full accent-artha-accent"
            />
            <div className="flex justify-between text-[10px] text-artha-muted/60 mt-1">
              <span>1 min</span><span>1 hr</span><span>1 day</span>
            </div>
          </label>
        </div>

        <button
          onClick={clearCache}
          disabled={clearing || stats.count === 0}
          className="flex items-center gap-1.5 px-3 py-2 rounded-lg border border-artha-border text-artha-muted hover:text-red-400 hover:border-red-400/40 text-xs transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {clearing
            ? <><RefreshCw size={11} className="animate-spin" /> Clearing…</>
            : <><Trash2 size={11} /> Clear cache</>}
        </button>
      </section>

      {/* Network limits */}
      <section className="mb-8">
        <div className="flex items-center gap-2 mb-3">
          <Globe size={13} className="text-artha-accent" />
          <h2 className="text-xs font-semibold text-artha-muted uppercase tracking-wide">
            Network limits
          </h2>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <label className="rounded-xl bg-artha-s2 border border-artha-border p-4 block">
            <div className="flex items-center justify-between mb-1.5">
              <span className="text-xs font-medium text-artha-text">Timeout</span>
              <span className="text-xs text-artha-accent font-mono">
                {(config.timeout_ms / 1000).toFixed(0)}s
              </span>
            </div>
            <input
              type="range" min={2000} max={60000} step={1000}
              value={config.timeout_ms}
              onChange={e => patch({ timeout_ms: Number(e.target.value) })}
              className="w-full accent-artha-accent"
            />
          </label>
          <label className="rounded-xl bg-artha-s2 border border-artha-border p-4 block">
            <div className="flex items-center justify-between mb-1.5">
              <span className="text-xs font-medium text-artha-text">Max response</span>
              <span className="text-xs text-artha-accent font-mono">
                {humanBytes(config.max_bytes)}
              </span>
            </div>
            <input
              type="range" min={262144} max={52428800} step={262144}
              value={config.max_bytes}
              onChange={e => patch({ max_bytes: Number(e.target.value) })}
              className="w-full accent-artha-accent"
            />
          </label>
        </div>
      </section>
    </div>
  );
}
