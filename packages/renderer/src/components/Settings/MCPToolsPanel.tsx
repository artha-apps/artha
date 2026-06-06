/**
 * MCPToolsPanel — three tabs:
 *   Tools       — installed MCP servers + built-in tools, enable/disable/remove
 *   Marketplace — curated popular MCP servers, one-click connect
 *   Audit Log   — persistent history of every tool invocation
 */
import { useEffect, useState } from 'react';
import {
  Wrench, Plus, Trash2, ToggleLeft, ToggleRight,
  RefreshCw, Clock, CheckCircle2, XCircle, ChevronDown, ChevronRight,
  Shield, Zap, Store, ExternalLink, Loader2, Globe, Brain,
  GitBranch, MessageSquare, Monitor, Database, Search, Eye, AlertCircle,
} from 'lucide-react';
import { FeatureGuide } from '../ui/FeatureGuide';
import { GUIDES } from './guides';

// ── Types ─────────────────────────────────────────────────────────────────────

/** Row from the `tools` table — MCP servers and (via the built-in shim) the
 *  filesystem helpers. `is_enabled` is 0/1, not boolean, to match SQLite. */
interface MCPTool {
  tool_id: string;
  name: string;
  description: string;
  mcp_server_uri: string | null;
  is_enabled: number;
  installed_at: number;
  /** Last connection outcome (from the `conn_status`/`conn_error` columns) so the
   *  row shows honest state — connected, failed (+ Retry), or disabled — instead
   *  of implying every installed server is live. Absent on built-in shim rows. */
  conn_status?: 'connected' | 'error' | 'disabled' | null;
  conn_error?: string | null;
  /** 1 when the server has encrypted credentials stored (derived server-side as
   *  `credentials_enc IS NOT NULL`; the secret itself is never sent to the UI). */
  has_credentials?: number;
}

/** Row from `tool_audit_log`. `result` is already truncated to 500 chars by
 *  the orchestrator before insert. */
interface AuditEntry {
  id: string;
  session_id: string | null;
  workflow_id: string | null;
  tool_name: string;
  args_json: string;
  result: string | null;
  duration_ms: number | null;
  status: 'ok' | 'error';
  ts: number;
}

/** Curated marketplace entry. `requiresEnv` triggers the env-var sub-form
 *  before install; `docs` adds an "open docs" external link; `example` is a
 *  ready-to-try chat prompt shown after connecting so the user knows what to
 *  actually do with it. */
interface MarketplaceServer {
  id: string;
  name: string;
  description: string;
  category: string;
  command: string;
  requiresEnv?: string[];
  icon: React.ElementType;
  iconColor: string;
  docs?: string;
  example?: string;
}

/** Friendly, per-credential guidance so a non-technical user knows WHAT each
 *  field is and WHERE to get it — keyed by the raw env-var name the server
 *  expects. Anything not listed falls back to the raw key. */
const ENV_HELP: Record<string, { label: string; url: string; hint: string }> = {
  GITHUB_PERSONAL_ACCESS_TOKEN: {
    label: 'GitHub access token',
    url: 'https://github.com/settings/tokens',
    hint: 'Create a token with read access to your repos, then paste it here.',
  },
  BRAVE_API_KEY: {
    label: 'Brave Search API key',
    url: 'https://brave.com/search/api/',
    hint: 'Sign up (there’s a free tier) and copy your API key.',
  },
  SLACK_BOT_TOKEN: {
    label: 'Slack bot token',
    url: 'https://api.slack.com/apps',
    hint: 'Create a Slack app, add bot scopes, install it to your workspace, then copy the Bot User OAuth Token (starts with xoxb-).',
  },
  SLACK_TEAM_ID: {
    label: 'Slack workspace ID',
    url: 'https://slack.com/help/articles/221769328-Locate-your-Slack-URL-or-ID',
    hint: 'Your workspace/team ID — it starts with “T”.',
  },
};

// ── Curated MCP server catalogue ──────────────────────────────────────────────
// Hand-picked list shown in the Marketplace tab. Adding a row here is enough
// to surface a one-click "Connect" — no backend changes required.

const MARKETPLACE: MarketplaceServer[] = [
  {
    id: 'fetch',
    name: 'Web Fetch',
    description: 'Fetch and read web pages. Lets Artha pull live information from the internet.',
    category: 'Web',
    command: 'npx -y @modelcontextprotocol/server-fetch',
    icon: Globe,
    iconColor: 'text-artha-accent',
    docs: 'https://github.com/modelcontextprotocol/servers/tree/main/src/fetch',
    example: 'Read and summarize https://example.com',
  },
  {
    id: 'brave-search',
    name: 'Brave Search',
    description: 'Search the web via Brave. Lets Artha find up-to-date information without a browser.',
    category: 'Search',
    command: 'npx -y @modelcontextprotocol/server-brave-search',
    requiresEnv: ['BRAVE_API_KEY'],
    icon: Search,
    iconColor: 'text-orange-400',
    docs: 'https://github.com/modelcontextprotocol/servers/tree/main/src/brave-search',
    example: 'Search the web for the latest on local AI agents',
  },
  {
    id: 'memory',
    name: 'Memory',
    description: 'Persistent knowledge graph. Artha remembers facts across sessions.',
    category: 'Memory',
    command: 'npx -y @modelcontextprotocol/server-memory',
    icon: Brain,
    iconColor: 'text-violet-400',
    docs: 'https://github.com/modelcontextprotocol/servers/tree/main/src/memory',
  },
  {
    id: 'github',
    name: 'GitHub',
    description: 'Read repos, issues, PRs, and code. Manage your GitHub projects with Artha.',
    category: 'Dev',
    command: 'npx -y @modelcontextprotocol/server-github',
    requiresEnv: ['GITHUB_PERSONAL_ACCESS_TOKEN'],
    icon: GitBranch,
    iconColor: 'text-artha-text',
    docs: 'https://github.com/modelcontextprotocol/servers/tree/main/src/github',
    example: 'List my open GitHub issues',
  },
  {
    id: 'slack',
    name: 'Slack',
    description: 'Read messages and channels from your Slack workspace.',
    category: 'Communication',
    command: 'npx -y @modelcontextprotocol/server-slack',
    requiresEnv: ['SLACK_BOT_TOKEN', 'SLACK_TEAM_ID'],
    icon: MessageSquare,
    iconColor: 'text-artha-success',
    docs: 'https://github.com/modelcontextprotocol/servers/tree/main/src/slack',
    example: 'Summarize today’s messages in #general',
  },
  {
    id: 'puppeteer',
    name: 'Puppeteer',
    description: 'Browser automation — take screenshots, fill forms, scrape dynamic web pages.',
    category: 'Browser',
    command: 'npx -y @modelcontextprotocol/server-puppeteer',
    icon: Monitor,
    iconColor: 'text-yellow-400',
    docs: 'https://github.com/modelcontextprotocol/servers/tree/main/src/puppeteer',
  },
  {
    id: 'sqlite',
    name: 'SQLite',
    description: 'Query and explore SQLite database files — great for local app data.',
    category: 'Data',
    command: 'npx -y @modelcontextprotocol/server-sqlite --db-path ~/data.db',
    icon: Database,
    iconColor: 'text-blue-400',
    docs: 'https://github.com/modelcontextprotocol/servers/tree/main/src/sqlite',
    example: 'How many rows are in the users table?',
  },
  {
    id: 'everything',
    name: 'Everything (Demo)',
    description: 'Full-featured demo server with prompts, resources, and all tool types.',
    category: 'Dev',
    command: 'npx -y @modelcontextprotocol/server-everything',
    icon: Eye,
    iconColor: 'text-artha-accent',
    docs: 'https://github.com/modelcontextprotocol/servers/tree/main/src/everything',
  },
];

const CATEGORY_ORDER = ['Web', 'Search', 'Memory', 'Dev', 'Communication', 'Browser', 'Data'];

// ── Built-in tool names ───────────────────────────────────────────────────────
const BUILTIN_TOOLS = [
  'fs_list_directory', 'fs_search_files', 'fs_create_directory',
  'fs_move_file', 'fs_copy_file', 'fs_read_file',
  'fs_get_file_info', 'fs_delete_file',
  'web_fetch', 'web_search',
  'browser_navigate', 'browser_click', 'browser_type', 'browser_wait_for',
  'browser_read_dom', 'browser_screenshot', 'browser_get_url',
  'browser_back', 'browser_forward', 'browser_reload', 'browser_request_user',
  'docs_generate',
  'rag_search', 'rag_list_indexes',
];

// ── Helpers ───────────────────────────────────────────────────────────────────

function relativeTime(unixSec: number): string {
  const diff = Math.floor(Date.now() / 1000) - unixSec;
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

function toolColor(name: string): string {
  if (name.startsWith('fs_')) return 'text-blue-400 bg-blue-400/10';
  if (name.startsWith('web_')) return 'text-artha-accent bg-artha-accent/10';
  if (name.startsWith('browser_')) return 'text-yellow-400 bg-yellow-400/10';
  return 'text-violet-400 bg-violet-400/10';
}

// ── Sub-components ────────────────────────────────────────────────────────────

/** Collapsible audit-log row. Click to expand the args + truncated result. */
function AuditRow({ entry }: { entry: AuditEntry }) {
  const [expanded, setExpanded] = useState(false);
  let args: Record<string, unknown> = {};
  try { args = JSON.parse(entry.args_json); } catch { /* ok */ }

  return (
    <div className={`rounded-xl border text-xs ${
      entry.status === 'error'
        ? 'border-artha-danger/20 bg-artha-danger/5'
        : 'border-artha-border bg-artha-surface'
    }`}>
      <button
        onClick={() => setExpanded(e => !e)}
        className="w-full flex items-center gap-3 px-3 py-2.5 text-left"
      >
        {entry.status === 'error'
          ? <XCircle size={12} className="text-artha-danger shrink-0" />
          : <CheckCircle2 size={12} className="text-artha-success shrink-0" />}

        <code className={`font-mono font-medium px-1.5 py-0.5 rounded text-xs ${toolColor(entry.tool_name)}`}>
          {entry.tool_name}
        </code>

        {entry.duration_ms != null && (
          <span className="text-artha-muted">{entry.duration_ms}ms</span>
        )}

        <span className="ml-auto text-artha-muted flex items-center gap-1">
          <Clock size={10} /> {relativeTime(entry.ts)}
        </span>

        {expanded
          ? <ChevronDown size={12} className="text-artha-muted shrink-0" />
          : <ChevronRight size={12} className="text-artha-muted shrink-0" />}
      </button>

      {expanded && (
        <div className="px-3 pb-3 space-y-2 border-t border-artha-border/50 pt-2">
          {Object.keys(args).length > 0 && (
            <div>
              <p className="text-artha-muted mb-1 uppercase tracking-wide text-[10px]">Args</p>
              <pre className="font-mono text-artha-text whitespace-pre-wrap break-all">
                {JSON.stringify(args, null, 2).slice(0, 400)}
              </pre>
            </div>
          )}
          {entry.result && (
            <div>
              <p className="text-artha-muted mb-1 uppercase tracking-wide text-[10px]">Result</p>
              <pre className={`font-mono whitespace-pre-wrap break-all ${
                entry.status === 'error' ? 'text-artha-danger/80' : 'text-artha-success/70'
              }`}>
                {entry.result.slice(0, 400)}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

interface MarketplaceCardProps {
  server: MarketplaceServer;
  isInstalled: boolean;
  onInstall: (server: MarketplaceServer, envVars: Record<string, string>) => Promise<void>;
}

/** Marketplace card. If `requiresEnv` is set, the first click expands an
 *  inline env-var form before the second click actually installs. Errors are
 *  shown inline so the user never loses the form they're filling in. */
function MarketplaceCard({ server, isInstalled, onInstall }: MarketplaceCardProps) {
  const [expanded, setExpanded] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [envValues, setEnvValues] = useState<Record<string, string>>({});
  const [error, setError] = useState('');
  const Icon = server.icon;

  const handleConnect = async () => {
    setError('');
    if (server.requiresEnv && !expanded) {
      setExpanded(true);
      return;
    }
    setInstalling(true);
    try {
      await onInstall(server, envValues);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Connection failed');
    } finally {
      setInstalling(false);
    }
  };

  const categoryColors: Record<string, string> = {
    Web: 'bg-artha-accent/10 text-artha-accent',
    Search: 'bg-orange-400/10 text-orange-400',
    Memory: 'bg-violet-400/10 text-violet-400',
    Dev: 'bg-artha-text/8 text-artha-text',
    Communication: 'bg-artha-success/10 text-artha-success',
    Browser: 'bg-yellow-400/10 text-yellow-400',
    Data: 'bg-blue-400/10 text-blue-400',
  };

  return (
    <div className={`rounded-xl border transition-all ${
      isInstalled ? 'border-artha-success/30 bg-artha-success/5' : 'border-artha-border bg-artha-s2'
    }`}>
      <div className="flex items-start gap-3 px-4 py-3">
        {/* Icon */}
        <div className="w-9 h-9 rounded-lg bg-artha-surface border border-artha-border flex items-center justify-center shrink-0 mt-0.5">
          <Icon size={17} className={server.iconColor} />
        </div>

        {/* Info */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-0.5">
            <span className="text-sm font-medium text-artha-text">{server.name}</span>
            <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium ${categoryColors[server.category] ?? 'bg-artha-text/8 text-artha-text'}`}>
              {server.category}
            </span>
          </div>
          <p className="text-xs text-artha-muted leading-relaxed">{server.description}</p>

          {/* Command preview */}
          <code className="text-[10px] text-artha-muted/60 font-mono mt-1 block truncate">
            {server.command}
          </code>

          {/* What to do with it, once connected. */}
          {isInstalled && server.example && (
            <p className="text-[11px] text-artha-accent/90 mt-1.5">💡 Try asking: “{server.example}”</p>
          )}
        </div>

        {/* Action */}
        <div className="flex items-center gap-2 shrink-0 ml-2">
          {server.docs && (
            <a
              href={server.docs}
              target="_blank"
              rel="noreferrer"
              className="p-1.5 rounded-lg text-artha-muted hover:text-artha-text hover:bg-artha-text/5 transition-colors"
              title="View docs"
              onClick={e => e.stopPropagation()}
            >
              <ExternalLink size={12} />
            </a>
          )}
          {isInstalled ? (
            <span className="flex items-center gap-1 text-xs text-artha-success font-medium px-2 py-1">
              <CheckCircle2 size={12} /> Connected
            </span>
          ) : (
            <button
              onClick={handleConnect}
              disabled={installing}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-artha-accent hover:bg-artha-accent/80 disabled:opacity-40 disabled:cursor-not-allowed text-xs font-medium transition-colors"
            >
              {installing
                ? <><Loader2 size={11} className="animate-spin" /> Connecting…</>
                : server.requiresEnv && !expanded
                  ? <><Plus size={11} /> Setup</>
                  : <><Plus size={11} /> Connect</>}
            </button>
          )}
        </div>
      </div>

      {/* Env var form — shown when server needs credentials */}
      {expanded && !isInstalled && server.requiresEnv && (
        <div className="px-4 pb-4 space-y-3 border-t border-artha-border/40 pt-3">
          <p className="text-xs text-artha-muted">
            This connector needs a key to sign in. Enter it below — it stays on your machine and is only passed to the connector.
          </p>
          {server.requiresEnv.map(envKey => {
            const help = ENV_HELP[envKey];
            return (
              <div key={envKey}>
                <div className="flex items-center justify-between mb-1">
                  <label className="text-xs font-medium text-artha-text">{help?.label ?? envKey}</label>
                  {help?.url && (
                    <a
                      href={help.url}
                      target="_blank"
                      rel="noreferrer"
                      onClick={e => e.stopPropagation()}
                      className="inline-flex items-center gap-0.5 text-[10px] text-artha-accent hover:underline"
                    >
                      Get this <ExternalLink size={9} />
                    </a>
                  )}
                </div>
                {help?.hint && <p className="text-[10px] text-artha-muted leading-snug mb-1.5">{help.hint}</p>}
                <input
                  type="password"
                  value={envValues[envKey] ?? ''}
                  onChange={e => setEnvValues(v => ({ ...v, [envKey]: e.target.value }))}
                  placeholder={help ? `Paste your ${help.label.toLowerCase()}` : `Enter ${envKey}`}
                  className="w-full bg-artha-surface border border-artha-border rounded-lg px-3 py-2 text-xs text-artha-text placeholder-artha-muted/50 focus:border-artha-accent/50 focus:outline-none font-mono"
                />
              </div>
            );
          })}
          {error && (
            <p className="text-xs text-artha-danger flex items-center gap-1">
              <XCircle size={11} /> {error}
            </p>
          )}
          <div className="flex gap-2">
            <button
              onClick={handleConnect}
              disabled={installing || (server.requiresEnv?.some(k => !envValues[k]))}
              className="flex items-center gap-1.5 px-4 py-2 rounded-lg bg-artha-accent hover:bg-artha-accent/80 disabled:opacity-40 disabled:cursor-not-allowed text-xs font-medium transition-colors"
            >
              {installing ? <><Loader2 size={11} className="animate-spin" /> Connecting…</> : <><Zap size={11} /> Connect</>}
            </button>
            <button
              onClick={() => { setExpanded(false); setError(''); }}
              className="px-3 py-2 rounded-lg text-xs text-artha-muted hover:text-artha-text hover:bg-artha-text/5 transition-colors"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Error without env form */}
      {error && !server.requiresEnv && (
        <div className="px-4 pb-3">
          <p className="text-xs text-artha-danger flex items-center gap-1">
            <XCircle size={11} /> {error}
          </p>
        </div>
      )}
    </div>
  );
}

// ── Main panel ────────────────────────────────────────────────────────────────

/**
 * Three-tab panel that manages all tool-related configuration:
 *   - Tools tab: view built-ins, add/remove/toggle MCP servers
 *   - Marketplace tab: one-click curated installs with optional env-var prompts
 *   - Audit Log tab: live table of every tool invocation with args + results
 */
export default function MCPToolsPanel() {
  // ── State ──────────────────────────────────────────────────────────────────
  const [tab, setTab] = useState<'tools' | 'marketplace' | 'audit'>('tools');
  const [tools, setTools] = useState<MCPTool[]>([]);
  const [auditLog, setAuditLog] = useState<AuditEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [addUri, setAddUri] = useState('');
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState('');
  const [marketplaceCategory, setMarketplaceCategory] = useState<string>('All');
  // npx-based connectors need Node.js on PATH; warn (with a fix) if it's absent.
  const [npxMissing, setNpxMissing] = useState(false);
  useEffect(() => {
    window.artha.system.checkRuntime().then(r => setNpxMissing(!r.npx)).catch(() => { /* ignore */ });
  }, []);

  // Whether the OS keychain encrypts connector secrets at rest on this machine.
  // Default true so we never flash a warning before the check resolves; flips to
  // false only on a box without a secret-service/keyring (rare — e.g. some Linux
  // setups), where credentials fall back to base64-at-rest and the user deserves
  // to know before pasting an API key.
  const [credEncAvailable, setCredEncAvailable] = useState(true);
  useEffect(() => {
    window.artha.mcp.credentialEncryptionAvailable().then(setCredEncAvailable).catch(() => { /* assume available */ });
  }, []);

  // ── Data loading ───────────────────────────────────────────────────────────

  /** Fetch both tools and audit log in parallel so the count badge in the tab
   *  bar is always accurate when the user switches tabs. */
  const load = async () => {
    setLoading(true);
    try {
      const [t, a] = await Promise.all([
        window.artha.mcp.listTools() as Promise<MCPTool[]>,
        // 200 is a practical cap — the full log can grow very large over time.
        window.artha.mcp.getAuditLog(200) as Promise<AuditEntry[]>,
      ]);
      setTools(t);
      setAuditLog(a);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const toggle = async (tool: MCPTool) => {
    const next = !tool.is_enabled;
    await window.artha.mcp.toggleTool(tool.tool_id, next);
    setTools(prev => prev.map(t =>
      t.tool_id === tool.tool_id ? { ...t, is_enabled: next ? 1 : 0 } : t
    ));
  };

  // Per-server "retrying…" state so the Retry button can spin and disable while
  // the reconnect IPC is in flight (npx cold-starts can take a few seconds).
  const [retrying, setRetrying] = useState<Set<string>>(new Set());

  /** Retry a failed/disabled connection without re-entering the API key — the
   *  stored (encrypted) credentials are reused server-side. Reflects the new
   *  conn_status by reloading so the badge updates. */
  const reconnect = async (tool: MCPTool) => {
    setRetrying(prev => new Set(prev).add(tool.tool_id));
    try {
      await window.artha.mcp.reconnect(tool.tool_id);
      await load();
    } finally {
      setRetrying(prev => { const n = new Set(prev); n.delete(tool.tool_id); return n; });
    }
  };

  const remove = async (tool: MCPTool) => {
    await window.artha.mcp.removeServer(tool.tool_id);
    setTools(prev => prev.filter(t => t.tool_id !== tool.tool_id));
  };

  const addServer = async () => {
    const uri = addUri.trim();
    if (!uri) return;
    setAdding(true);
    setAddError('');
    try {
      await window.artha.mcp.installServer(uri);
      setAddUri('');
      await load();
    } catch (err) {
      setAddError(err instanceof Error ? err.message : 'Failed to connect server');
    } finally {
      setAdding(false);
    }
  };

  /** Install a curated marketplace entry. Env vars from the inline form are
   *  prefixed with the `ENV:` convention that the MCP registry parses back
   *  into a process.env override at spawn time. */
  const installMarketplaceServer = async (
    server: MarketplaceServer,
    envVars: Record<string, string>
  ) => {
    const cmd = server.command;
    const envParts = Object.entries(envVars)
      .filter(([, v]) => v.trim())
      .map(([k, v]) => `ENV:${k}=${v}`);

    const fullUri = envParts.length > 0 ? `${envParts.join(' ')} ${cmd}` : cmd;
    await window.artha.mcp.installServer(fullUri);
    await load();
  };

  // Build a normalized set of installed server commands (ENV: prefixes removed) so
  // we can detect duplicates without being fooled by extra env-var tokens.
  const installedCommandSet = new Set(
    tools
      .filter(t => t.mcp_server_uri)
      .map(t => {
        // Strip ENV: prefixes to compare base command
        const parts = (t.mcp_server_uri ?? '').split(' ').filter(p => !p.startsWith('ENV:'));
        return parts.join(' ');
      })
  );

  /** Fuzzy match: check if the catalog entry's npm package name appears in any
   *  installed command string. Uses just the third token (the package name) to
   *  tolerate minor argument differences across installs. */
  const isServerInstalled = (server: MarketplaceServer) => {
    const baseCmd = server.command.split(' ').slice(0, 3).join(' ');
    return Array.from(installedCommandSet).some(uri => uri.includes(baseCmd.split(' ')[2] ?? baseCmd));
  };

  const mcpTools = tools.filter(t => t.mcp_server_uri);

  const filteredMarketplace = marketplaceCategory === 'All'
    ? MARKETPLACE
    : MARKETPLACE.filter(s => s.category === marketplaceCategory);

  return (
    <div className="flex-1 overflow-y-auto px-8 py-8 max-w-3xl mx-auto w-full">
      <FeatureGuide {...GUIDES.mcp} />
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg bg-artha-accent/20 flex items-center justify-center">
            <Wrench size={16} className="text-artha-accent" />
          </div>
          <div>
            <h1 className="text-base font-semibold text-artha-text">MCP Tools</h1>
            <p className="text-xs text-artha-muted">Manage tools and extend Artha's capabilities</p>
          </div>
        </div>
        <button onClick={load} disabled={loading}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-artha-border text-artha-muted hover:text-artha-text hover:bg-artha-text/5 text-xs transition-colors disabled:opacity-40">
          <RefreshCw size={12} className={loading ? 'animate-spin' : ''} /> Refresh
        </button>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 mb-6 p-1 bg-artha-s2 border border-artha-border rounded-xl w-fit">
        {(['tools', 'marketplace', 'audit'] as const).map(t => (
          <button key={t} onClick={() => setTab(t)}
            className={`px-4 py-1.5 rounded-lg text-sm font-medium transition-colors capitalize flex items-center gap-1.5
              ${tab === t ? 'bg-artha-accent/20 text-artha-text' : 'text-artha-muted hover:text-artha-text'}`}>
            {t === 'marketplace' && <Store size={12} />}
            {t === 'audit' ? 'Audit Log' : t === 'marketplace' ? 'Marketplace' : 'Tools'}
            {t === 'audit' && auditLog.length > 0 && (
              <span className="text-xs bg-artha-accent/20 text-artha-accent px-1.5 py-0.5 rounded-full">
                {auditLog.length}
              </span>
            )}
            {t === 'marketplace' && (
              <span className="text-xs bg-artha-accent/20 text-artha-accent px-1.5 py-0.5 rounded-full">
                {MARKETPLACE.length}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* ── Tools tab ── */}
      {tab === 'tools' && (
        <div className="space-y-6">
          {/* Built-in tools */}
          <section>
            <div className="flex items-center gap-2 mb-3">
              <Shield size={13} className="text-artha-accent" />
              <h2 className="text-xs font-semibold text-artha-muted uppercase tracking-wide">
                Built-in Filesystem Tools
              </h2>
              <span className="text-xs text-artha-muted">({BUILTIN_TOOLS.length})</span>
            </div>
            <div className="grid grid-cols-2 gap-2">
              {BUILTIN_TOOLS.map(name => (
                <div key={name}
                  className="flex items-center gap-2 px-3 py-2 rounded-lg bg-artha-s2 border border-artha-border">
                  <Zap size={11} className="text-blue-400 shrink-0" />
                  <code className="text-xs font-mono text-artha-text truncate">{name}</code>
                  <CheckCircle2 size={11} className="text-artha-success ml-auto shrink-0" />
                </div>
              ))}
            </div>
          </section>

          {/* MCP servers */}
          <section>
            <div className="flex items-center gap-2 mb-3">
              <Wrench size={13} className="text-artha-accent" />
              <h2 className="text-xs font-semibold text-artha-muted uppercase tracking-wide">
                Connected MCP Servers
              </h2>
              {mcpTools.length > 0 && (
                <span className="text-xs text-artha-muted">({mcpTools.length})</span>
              )}
            </div>

            {mcpTools.length === 0 ? (
              <div className="text-center py-8 bg-artha-s2 border border-dashed border-artha-border rounded-xl">
                <Store size={24} className="mx-auto mb-2 text-artha-muted opacity-30" />
                <p className="text-sm text-artha-muted">No MCP servers installed yet</p>
                <p className="text-xs text-artha-muted mt-1">
                  Browse the{' '}
                  <button onClick={() => setTab('marketplace')} className="text-artha-accent hover:underline">
                    Marketplace
                  </button>
                  {' '}to add web search, GitHub, Slack, and more.
                </p>
              </div>
            ) : (
              <div className="space-y-2">
                {mcpTools.map(tool => (
                  <div key={tool.tool_id}
                    className="flex items-center gap-3 px-4 py-3 rounded-xl bg-artha-s2 border border-artha-border">
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-artha-text truncate">{tool.name}</p>
                      {tool.mcp_server_uri && (
                        <code className="text-xs text-artha-muted font-mono truncate block">
                          {tool.mcp_server_uri.replace(/ENV:[^\s]+ /g, '')}
                        </code>
                      )}
                      {/* Honest per-server status: a failed connect keeps the row
                          (credentials persist) but says so + offers Retry. */}
                      {tool.is_enabled && tool.conn_status === 'error' && (
                        <span className="mt-0.5 inline-flex items-center gap-1 text-xs text-artha-danger"
                          title={tool.conn_error ?? undefined}>
                          <XCircle size={11} className="shrink-0" />
                          <span className="truncate">Not connected{tool.conn_error ? ` — ${tool.conn_error}` : ''}</span>
                        </span>
                      )}
                      {tool.is_enabled && tool.conn_status === 'connected' && (
                        <span className="mt-0.5 inline-flex items-center gap-1 text-xs text-artha-success">
                          <CheckCircle2 size={11} className="shrink-0" /> Connected
                        </span>
                      )}
                    </div>

                    {/* Retry — only for a server that failed to connect; reuses
                        the stored key (no re-entry). */}
                    {tool.is_enabled && tool.conn_status === 'error' && (
                      <button onClick={() => reconnect(tool)} disabled={retrying.has(tool.tool_id)}
                        title="Retry connection" className="text-artha-muted hover:text-artha-text transition-colors disabled:opacity-50">
                        <RefreshCw size={14} className={retrying.has(tool.tool_id) ? 'animate-spin' : ''} />
                      </button>
                    )}

                    {/* Toggle */}
                    <button onClick={() => toggle(tool)} title={tool.is_enabled ? 'Disable' : 'Enable'}
                      className="text-artha-muted hover:text-artha-text transition-colors">
                      {tool.is_enabled
                        ? <ToggleRight size={20} className="text-artha-accent" />
                        : <ToggleLeft size={20} />}
                    </button>

                    {/* Remove */}
                    <button onClick={() => remove(tool)} title="Remove server"
                      className="text-artha-muted hover:text-artha-danger transition-colors">
                      <Trash2 size={14} />
                    </button>
                  </div>
                ))}
              </div>
            )}

            {/* Manual add server */}
            <div className="mt-4 space-y-2">
              <p className="text-xs font-medium text-artha-muted uppercase tracking-wide">Add custom server</p>
              {/* Secrets are normally sealed by the OS keychain. When that's
                  unavailable they fall back to base64-at-rest — not encryption —
                  so warn before the user pastes an ENV:KEY=… token. */}
              {!credEncAvailable && (
                <div className="flex items-start gap-2.5 px-3 py-2.5 rounded-xl bg-amber-500/10 border border-amber-500/30 text-sm">
                  <AlertCircle size={15} className="text-amber-500 shrink-0 mt-0.5" />
                  <div className="flex-1 min-w-0">
                    <p className="text-artha-text font-medium">Secrets aren’t encrypted at rest on this machine</p>
                    <p className="text-xs text-artha-muted leading-snug mt-0.5">
                      No OS keychain (secret-service/keyring) was found, so any API keys you add to a connector are stored only base64-encoded, not encrypted. Avoid entering high-value credentials until a keyring is available.
                    </p>
                  </div>
                </div>
              )}
              <div className="flex gap-2">
                <input
                  value={addUri}
                  onChange={e => setAddUri(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && addServer()}
                  placeholder="npx @modelcontextprotocol/server-filesystem ~/Documents"
                  className="flex-1 bg-artha-s2 border border-artha-border rounded-lg px-3 py-2 text-sm text-artha-text placeholder-artha-muted focus:border-artha-accent/50 focus:outline-none transition-colors font-mono"
                />
                <button onClick={addServer} disabled={!addUri.trim() || adding}
                  className="flex items-center gap-1.5 px-4 py-2 rounded-lg bg-artha-accent hover:bg-artha-accent/80 disabled:opacity-40 disabled:cursor-not-allowed text-sm font-medium transition-colors">
                  {adding ? <RefreshCw size={13} className="animate-spin" /> : <Plus size={13} />}
                  Add
                </button>
              </div>
              {addError && (
                <p className="text-xs text-artha-danger flex items-center gap-1">
                  <XCircle size={11} /> {addError}
                </p>
              )}
              <p className="text-xs text-artha-muted">
                Any stdio MCP server — paste the full command as you'd run it in a terminal.
              </p>
            </div>
          </section>
        </div>
      )}

      {/* ── Marketplace tab ── */}
      {tab === 'marketplace' && (
        <div className="space-y-5">
          <div>
            <p className="text-sm text-artha-muted mb-4">
              Extend Artha with one-click MCP servers. All run locally via{' '}
              <code className="text-xs bg-artha-s2 border border-artha-border px-1.5 py-0.5 rounded font-mono">npx</code>
              {' '}— no cloud, no accounts required (unless the service itself needs one).
            </p>

            {/* Prerequisite: npx-based connectors can't start without Node.js. Tell
                the user up front with a one-click fix, instead of a cryptic error. */}
            {npxMissing && (
              <div className="flex items-start gap-2.5 mb-4 px-3 py-2.5 rounded-xl bg-amber-500/10 border border-amber-500/30 text-sm">
                <AlertCircle size={15} className="text-amber-500 shrink-0 mt-0.5" />
                <div className="flex-1 min-w-0">
                  <p className="text-artha-text font-medium">Node.js is required for these connectors</p>
                  <p className="text-xs text-artha-muted leading-snug mt-0.5">
                    They start with <code className="font-mono">npx</code>, which needs Node.js (a free, one-time install). Install it, then reopen this tab.
                  </p>
                  <a
                    href="https://nodejs.org/en/download"
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 mt-1.5 text-xs text-artha-accent hover:underline"
                  >
                    Install Node.js <ExternalLink size={11} />
                  </a>
                </div>
              </div>
            )}

            {/* Category filter */}
            <div className="flex gap-1.5 flex-wrap mb-5">
              {['All', ...CATEGORY_ORDER].map(cat => (
                <button
                  key={cat}
                  onClick={() => setMarketplaceCategory(cat)}
                  className={`px-3 py-1 rounded-full text-xs font-medium transition-colors ${
                    marketplaceCategory === cat
                      ? 'bg-artha-accent/20 text-artha-text border border-artha-accent/30'
                      : 'bg-artha-s2 border border-artha-border text-artha-muted hover:text-artha-text'
                  }`}
                >
                  {cat}
                </button>
              ))}
            </div>
          </div>

          <div className="space-y-3">
            {filteredMarketplace.map(server => (
              <MarketplaceCard
                key={server.id}
                server={server}
                isInstalled={isServerInstalled(server)}
                onInstall={installMarketplaceServer}
              />
            ))}
          </div>

          <div className="pt-2 pb-4 border-t border-artha-border">
            <p className="text-xs text-artha-muted">
              Looking for more?{' '}
              <a
                href="https://github.com/modelcontextprotocol/servers"
                target="_blank"
                rel="noreferrer"
                className="text-artha-accent hover:underline inline-flex items-center gap-1"
              >
                Browse the full MCP server catalogue <ExternalLink size={10} />
              </a>
            </p>
          </div>
        </div>
      )}

      {/* ── Audit Log tab ── */}
      {tab === 'audit' && (
        <div>
          {loading ? (
            <div className="space-y-2">
              {[1,2,3,4,5].map(i => (
                <div key={i} className="h-10 bg-artha-s2 border border-artha-border rounded-xl animate-pulse" />
              ))}
            </div>
          ) : auditLog.length === 0 ? (
            <div className="text-center py-16 text-artha-muted">
              <Clock size={32} className="mx-auto mb-3 opacity-30" />
              <p className="text-sm font-medium text-artha-text mb-1">No tool invocations yet</p>
              <p className="text-xs">Every tool call Artha makes will appear here</p>
            </div>
          ) : (
            <div className="space-y-2">
              {/* Summary bar */}
              <div className="flex items-center gap-4 px-4 py-2 bg-artha-s2 border border-artha-border rounded-xl mb-4 text-xs">
                <span className="text-artha-muted">{auditLog.length} invocations</span>
                <span className="text-artha-success">
                  {auditLog.filter(e => e.status === 'ok').length} ok
                </span>
                <span className="text-artha-danger">
                  {auditLog.filter(e => e.status === 'error').length} errors
                </span>
                {auditLog.length > 0 && auditLog[0].duration_ms != null && (
                  <span className="text-artha-muted ml-auto">
                    avg {Math.round(auditLog.slice(0,20).reduce((s,e) => s + (e.duration_ms ?? 0), 0) / Math.min(20, auditLog.length))}ms
                  </span>
                )}
              </div>

              {auditLog.map(entry => (
                <AuditRow key={entry.id} entry={entry} />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
