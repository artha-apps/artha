/**
 * MarketplacePanel — browse and install MCP server plugins.
 *
 * Shows the built-in catalog (mirrored from packages/app/src/mcp/registry-catalog.ts)
 * with category filtering and search. One-click install delegates to the
 * already-wired `mcp:installServer` IPC channel, then refreshes the MCP panel.
 */
import { useEffect, useState } from 'react';
import { ExternalLink, Download, Check, Loader, Link as LinkIcon } from 'lucide-react';
import { useChatStore } from '../../stores/chat';
import { FeatureGuide } from '../ui/FeatureGuide';
import { GUIDES } from './guides';

// Catalog entries for Google Workspace services that need an OAuth grant — the
// user must connect them in the Cloud tab rather than installing an MCP server.
const AUTH_REQUIRED = new Set(['mcp-google-drive', 'mcp-gmail', 'mcp-google-calendar']);

// ── Catalog ──────────────────────────────────────────────────────────────────
// Duplicated here so the renderer bundle doesn't pull in Node/Electron modules
// from the app package. Keep in sync with registry-catalog.ts.

type McpCategory = 'filesystem' | 'web' | 'productivity' | 'data' | 'dev' | 'ai' | 'communication';

interface CatalogEntry {
  id: string;
  name: string;
  description: string;
  installUri: string;
  category: McpCategory;
  icon: string;
  author: string;
  tools: string;
  docsUrl?: string;
}

const CATALOG: CatalogEntry[] = [
  { id: 'mcp-filesystem', name: 'Filesystem', description: 'Read, write, move, and search files on your local machine. The foundation for most file-automation tasks.', installUri: 'npx @modelcontextprotocol/server-filesystem', category: 'filesystem', icon: '📁', author: 'Anthropic', tools: 'read_file, write_file, list_directory, move_file, search_files', docsUrl: 'https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem' },
  { id: 'mcp-everything', name: 'Everything Search', description: 'Lightning-fast file search across your entire disk using the Everything index (Windows) or mdfind (macOS).', installUri: 'npx @modelcontextprotocol/server-everything', category: 'filesystem', icon: '🔍', author: 'Anthropic', tools: 'search_files, get_file_info', docsUrl: 'https://github.com/modelcontextprotocol/servers/tree/main/src/everything' },
  { id: 'mcp-fetch', name: 'Web Fetch', description: 'Fetch any URL and return its text content. Ideal for reading docs, articles, and APIs.', installUri: 'npx @modelcontextprotocol/server-fetch', category: 'web', icon: '🌐', author: 'Anthropic', tools: 'fetch', docsUrl: 'https://github.com/modelcontextprotocol/servers/tree/main/src/fetch' },
  { id: 'mcp-brave-search', name: 'Brave Search', description: 'Real-time web and news search via the Brave Search API. Requires a free Brave API key.', installUri: 'npx @modelcontextprotocol/server-brave-search', category: 'web', icon: '🦁', author: 'Anthropic', tools: 'brave_web_search, brave_local_search', docsUrl: 'https://github.com/modelcontextprotocol/servers/tree/main/src/brave-search' },
  { id: 'mcp-puppeteer', name: 'Puppeteer Browser', description: 'Control a real Chromium browser — navigate, click, screenshot, and scrape JS-rendered pages.', installUri: 'npx @modelcontextprotocol/server-puppeteer', category: 'web', icon: '🤖', author: 'Anthropic', tools: 'puppeteer_navigate, puppeteer_click, puppeteer_screenshot, puppeteer_fill', docsUrl: 'https://github.com/modelcontextprotocol/servers/tree/main/src/puppeteer' },
  { id: 'mcp-google-drive', name: 'Google Drive', description: 'Search, read, and list files from your Google Drive. Supports Docs, Sheets, and Slides export.', installUri: 'npx @modelcontextprotocol/server-gdrive', category: 'productivity', icon: '📂', author: 'Anthropic', tools: 'gdrive_search, gdrive_read_file', docsUrl: 'https://github.com/modelcontextprotocol/servers/tree/main/src/gdrive' },
  { id: 'mcp-notion', name: 'Notion', description: 'Read pages, search your workspace, and create new content inside Notion.', installUri: 'npx @modelcontextprotocol/server-notion', category: 'productivity', icon: '📓', author: 'Anthropic', tools: 'notion_search, notion_get_page, notion_create_page', docsUrl: 'https://github.com/modelcontextprotocol/servers/tree/main/src/notion' },
  { id: 'mcp-sqlite', name: 'SQLite', description: 'Query any SQLite database file. Run SELECTs, inspect schemas, and export results as Markdown tables.', installUri: 'npx @modelcontextprotocol/server-sqlite', category: 'data', icon: '🗄️', author: 'Anthropic', tools: 'query, list_tables, describe_table', docsUrl: 'https://github.com/modelcontextprotocol/servers/tree/main/src/sqlite' },
  { id: 'mcp-postgres', name: 'PostgreSQL', description: 'Connect to a Postgres database — run read-only queries, inspect tables, and fetch data.', installUri: 'npx @modelcontextprotocol/server-postgres', category: 'data', icon: '🐘', author: 'Anthropic', tools: 'query, list_tables, describe_table', docsUrl: 'https://github.com/modelcontextprotocol/servers/tree/main/src/postgres' },
  { id: 'mcp-github', name: 'GitHub', description: 'Search repos, read files, create issues and PRs, and manage your GitHub repositories.', installUri: 'npx @modelcontextprotocol/server-github', category: 'dev', icon: '🐙', author: 'Anthropic', tools: 'github_search, github_read_file, github_create_issue, github_create_pr', docsUrl: 'https://github.com/modelcontextprotocol/servers/tree/main/src/github' },
  { id: 'mcp-git', name: 'Git', description: 'Run git commands — log, diff, status, blame — on any local repository.', installUri: 'uvx mcp-server-git', category: 'dev', icon: '🌿', author: 'Anthropic', tools: 'git_log, git_diff, git_status, git_show, git_blame', docsUrl: 'https://github.com/modelcontextprotocol/servers/tree/main/src/git' },
  { id: 'mcp-slack', name: 'Slack', description: 'Read channels, search messages, and post to Slack workspaces you belong to.', installUri: 'npx @modelcontextprotocol/server-slack', category: 'communication', icon: '💬', author: 'Anthropic', tools: 'slack_list_channels, slack_post_message, slack_search_messages', docsUrl: 'https://github.com/modelcontextprotocol/servers/tree/main/src/slack' },
  { id: 'mcp-memory', name: 'Knowledge Graph Memory', description: 'Persistent memory using a local knowledge graph. Let the agent remember entities, facts, and relationships across sessions.', installUri: 'npx @modelcontextprotocol/server-memory', category: 'ai', icon: '🧠', author: 'Anthropic', tools: 'create_entities, create_relations, search_nodes, open_nodes', docsUrl: 'https://github.com/modelcontextprotocol/servers/tree/main/src/memory' },
  { id: 'mcp-sequential-thinking', name: 'Sequential Thinking', description: 'Gives the agent an explicit scratchpad for multi-step reasoning — improves accuracy on complex tasks.', installUri: 'npx @modelcontextprotocol/server-sequential-thinking', category: 'ai', icon: '🧩', author: 'Anthropic', tools: 'sequentialthinking', docsUrl: 'https://github.com/modelcontextprotocol/servers/tree/main/src/sequentialthinking' },
];

const CATEGORIES: { id: McpCategory | 'all'; label: string }[] = [
  { id: 'all',           label: 'All'          },
  { id: 'filesystem',    label: 'Filesystem'   },
  { id: 'web',           label: 'Web'          },
  { id: 'productivity',  label: 'Productivity' },
  { id: 'data',          label: 'Data'         },
  { id: 'dev',           label: 'Dev'          },
  { id: 'communication', label: 'Comms'        },
  { id: 'ai',            label: 'AI'           },
];

// ── Component ─────────────────────────────────────────────────────────────────

/**
 * Marketplace panel — browse the curated plugin catalog, install MCP servers
 * one-click, or navigate to the Cloud tab for OAuth-gated services.
 */
export default function MarketplacePanel() {
  // ── State ──────────────────────────────────────────────────────────────────
  const [category, setCategory] = useState<McpCategory | 'all'>('all');
  const [query, setQuery] = useState('');
  // `installing` holds the catalog entry id currently being installed.
  const [installing, setInstalling] = useState<string | null>(null);
  const [installed, setInstalled] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  // Used to redirect auth-required entries straight to the Cloud Integrations tab.
  const setActiveView = useChatStore(s => s.setActiveView);

  // Installed state is persisted in the DB (the `tools` table), keyed by install
  // URI. Map those URIs back to catalog ids so the badges survive navigation.
  const refreshInstalled = async () => {
    try {
      const uris = await window.artha.mcp.listInstalledIds();
      const ids = CATALOG.filter(e => uris.includes(e.installUri)).map(e => e.id);
      setInstalled(new Set(ids));
    } catch {
      /* leave whatever we have */
    }
  };

  useEffect(() => { refreshInstalled(); }, []);

  // Filter the catalog by both category pill and free-text query (name, description, tools).
  const filtered = CATALOG.filter(e => {
    const matchCat = category === 'all' || e.category === category;
    const q = query.toLowerCase();
    const matchQ = !q || e.name.toLowerCase().includes(q) || e.description.toLowerCase().includes(q) || e.tools.toLowerCase().includes(q);
    return matchCat && matchQ;
  });

  const install = async (entry: CatalogEntry) => {
    setError(null);
    setInstalling(entry.id);
    try {
      await window.artha.mcp.installServer(entry.installUri);
      // Re-fetch from the DB so the Set stays in sync with persisted state.
      await refreshInstalled();
    } catch (err) {
      setError(`Failed to install ${entry.name}: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setInstalling(null);
    }
  };

  return (
    <div className="flex-1 overflow-y-auto p-6">
      <div className="max-w-3xl mx-auto">
        <FeatureGuide {...GUIDES.marketplace} />

        {/* Header */}
        <div className="mb-6">
          <h2 className="text-lg font-semibold text-artha-text">Plugin Marketplace</h2>
          <p className="text-sm text-artha-muted mt-0.5">
            One-click install for MCP servers — extend Artha with new tools and integrations.
          </p>
        </div>

        {/* Search */}
        <input
          type="text"
          value={query}
          onChange={e => setQuery(e.target.value)}
          placeholder="Search plugins…"
          className="w-full mb-4 px-3 py-2 rounded-xl bg-artha-s2 border border-artha-border text-sm text-artha-text placeholder-artha-muted outline-none focus:border-artha-accent/50 transition-colors"
        />

        {/* Category tabs */}
        <div className="flex flex-wrap gap-2 mb-5">
          {CATEGORIES.map(c => (
            <button
              key={c.id}
              onClick={() => setCategory(c.id)}
              className={`px-3 py-1 rounded-full text-xs font-medium transition-colors ${
                category === c.id
                  ? 'bg-artha-accent text-artha-text'
                  : 'bg-artha-s2 border border-artha-border text-artha-muted hover:text-artha-text hover:border-artha-accent/40'
              }`}
            >
              {c.label}
            </button>
          ))}
        </div>

        {/* Error banner */}
        {error && (
          <div className="mb-4 px-4 py-3 rounded-xl bg-red-500/10 border border-red-500/30 text-sm text-red-400">
            {error}
          </div>
        )}

        {/* Plugin grid */}
        {filtered.length === 0 && (
          <p className="text-center text-artha-muted text-sm py-12">No plugins match your search.</p>
        )}

        <div className="space-y-3">
          {filtered.map(entry => {
            const isInstalling = installing === entry.id;
            const isDone = installed.has(entry.id);
            const authRequired = AUTH_REQUIRED.has(entry.id);

            return (
              <div key={entry.id}
                className="flex items-start gap-4 px-4 py-4 rounded-xl bg-artha-s2 border border-artha-border hover:border-artha-accent/25 transition-colors"
              >
                {/* Icon */}
                <span className="text-2xl leading-none mt-0.5 shrink-0">{entry.icon}</span>

                {/* Info */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-0.5">
                    <span className="text-sm font-semibold text-artha-text">{entry.name}</span>
                    <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-artha-surface border border-artha-border text-artha-muted uppercase tracking-wide">
                      {entry.category}
                    </span>
                  </div>
                  <p className="text-xs text-artha-muted leading-relaxed mb-1.5">{entry.description}</p>
                  <p className="text-[11px] text-artha-muted/60">
                    <span className="text-artha-muted/80">Tools:</span> {entry.tools}
                  </p>
                  <p className="text-[11px] text-artha-muted/50 font-mono mt-1">{entry.installUri}</p>
                  {authRequired && (
                    <p className="text-[11px] text-amber-400/90 mt-1.5">Auth required — go to Cloud tab</p>
                  )}
                </div>

                {/* Actions */}
                <div className="flex items-center gap-2 shrink-0 mt-0.5">
                  {entry.docsUrl && (
                    <a
                      href={entry.docsUrl}
                      target="_blank"
                      rel="noreferrer"
                      title="Docs"
                      className="p-1.5 rounded-lg text-artha-muted hover:text-artha-text hover:bg-artha-text/5 transition-colors"
                    >
                      <ExternalLink size={13} />
                    </a>
                  )}
                  {authRequired ? (
                    <button
                      onClick={() => setActiveView('cloud')}
                      title="Connect in the Cloud tab"
                      className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-cyan-600/80 hover:bg-cyan-500 text-artha-text transition-colors"
                    >
                      <LinkIcon size={11} /> Cloud tab
                    </button>
                  ) : (
                    <button
                      onClick={() => install(entry)}
                      disabled={isInstalling || isDone}
                      title={isDone ? 'Installed' : 'Install'}
                      className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors disabled:cursor-not-allowed ${
                        isDone
                          ? 'bg-green-500/15 border border-green-500/30 text-green-400'
                          : 'bg-artha-accent hover:bg-artha-accent/80 disabled:opacity-50 text-artha-text'
                      }`}
                    >
                      {isInstalling ? (
                        <><Loader size={11} className="animate-spin" /> Installing…</>
                      ) : isDone ? (
                        <><Check size={11} /> Installed</>
                      ) : (
                        <><Download size={11} /> Install</>
                      )}
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        {/* Footer note */}
        <p className="text-center text-[11px] text-artha-muted/50 mt-6">
          MCP servers run as local child processes. All data stays on your machine.
        </p>
      </div>
    </div>
  );
}
