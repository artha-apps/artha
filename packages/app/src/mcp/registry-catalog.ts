/**
 * MCP Plugin Marketplace catalog.
 *
 * Each entry describes one MCP server that the user can install with a single
 * click. `installUri` is the string passed directly to `mcp:installServer` —
 * it can be an `npx` command, a `uvx` command, or a local path.
 *
 * Categories map to the filter tabs in MarketplacePanel.
 *
 * This file is the source of truth for the built-in catalog. Community entries
 * can be fetched from the remote JSON URL at runtime and merged in.
 */

/** The set of filter-tab categories shown in the MCP Marketplace panel. */
export type McpCategory =
  | 'filesystem'
  | 'web'
  | 'productivity'
  | 'data'
  | 'dev'
  | 'ai'
  | 'communication';

/**
 * One secret a connector needs before it can run (an API key, token, or
 * connection string). Drives the credential form shown at install time and how
 * the value is delivered to the server's child process.
 *   - kind 'env': injected as the environment variable named by `key`.
 *   - kind 'arg': appended to the spawn command line (e.g. a Postgres URL).
 */
export interface McpCredentialField {
  /** Env-var name (kind 'env') or storage key (kind 'arg') the value maps to. */
  key: string;
  /** Human-readable label shown in the install form. */
  label: string;
  /** How the secret reaches the server process. Defaults to 'env'. */
  kind?: 'env' | 'arg';
  /** Short helper text explaining what to paste / where to find it. */
  help?: string;
  /** URL where the user can obtain the credential. */
  link?: string;
  /** Input placeholder hint. */
  placeholder?: string;
}

export interface McpCatalogEntry {
  id: string;
  name: string;
  description: string;
  installUri: string;
  category: McpCategory;
  icon: string;
  author: string;
  /** Comma-separated list of notable tool names exposed by this server */
  tools: string;
  /** Official docs or repo link */
  docsUrl?: string;
  /** Secrets the user must supply before this connector can run. Absent/empty
   *  means the connector works with no auth. */
  credentials?: McpCredentialField[];
}

export const BUILTIN_CATALOG: McpCatalogEntry[] = [
  // ── Filesystem ──────────────────────────────────────────────────────────
  {
    id: 'mcp-filesystem',
    name: 'Filesystem',
    description: 'Read, write, move, and search files on your local machine. The foundation for most file-automation tasks.',
    installUri: 'npx @modelcontextprotocol/server-filesystem',
    category: 'filesystem',
    icon: '📁',
    author: 'Anthropic',
    tools: 'read_file, write_file, list_directory, move_file, search_files',
    docsUrl: 'https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem',
  },
  {
    id: 'mcp-everything',
    name: 'Everything Search',
    description: 'Lightning-fast file search across your entire disk using the Everything index (Windows) or mdfind (macOS).',
    installUri: 'npx @modelcontextprotocol/server-everything',
    category: 'filesystem',
    icon: '🔍',
    author: 'Anthropic',
    tools: 'search_files, get_file_info',
    docsUrl: 'https://github.com/modelcontextprotocol/servers/tree/main/src/everything',
  },

  // ── Web ─────────────────────────────────────────────────────────────────
  {
    id: 'mcp-fetch',
    name: 'Web Fetch',
    description: 'Fetch any URL and return its text content. Ideal for reading docs, articles, and APIs.',
    installUri: 'npx @modelcontextprotocol/server-fetch',
    category: 'web',
    icon: '🌐',
    author: 'Anthropic',
    tools: 'fetch',
    docsUrl: 'https://github.com/modelcontextprotocol/servers/tree/main/src/fetch',
  },
  {
    id: 'mcp-brave-search',
    name: 'Brave Search',
    description: 'Real-time web and news search via the Brave Search API. Requires a free Brave API key.',
    installUri: 'npx @modelcontextprotocol/server-brave-search',
    category: 'web',
    icon: '🦁',
    author: 'Anthropic',
    tools: 'brave_web_search, brave_local_search',
    docsUrl: 'https://github.com/modelcontextprotocol/servers/tree/main/src/brave-search',
    credentials: [
      {
        key: 'BRAVE_API_KEY',
        label: 'Brave API key',
        kind: 'env',
        help: 'Free tier available. Create a key in the Brave Search API dashboard.',
        link: 'https://brave.com/search/api/',
        placeholder: 'BSA…',
      },
    ],
  },
  {
    id: 'mcp-puppeteer',
    name: 'Puppeteer Browser',
    description: 'Control a real Chromium browser — navigate, click, screenshot, and scrape JS-rendered pages.',
    installUri: 'npx @modelcontextprotocol/server-puppeteer',
    category: 'web',
    icon: '🤖',
    author: 'Anthropic',
    tools: 'puppeteer_navigate, puppeteer_click, puppeteer_screenshot, puppeteer_fill',
    docsUrl: 'https://github.com/modelcontextprotocol/servers/tree/main/src/puppeteer',
  },

  // ── Productivity ─────────────────────────────────────────────────────────
  {
    id: 'mcp-google-drive',
    name: 'Google Drive',
    description: 'Search, read, and list files from your Google Drive. Supports Docs, Sheets, and Slides export.',
    installUri: 'npx @modelcontextprotocol/server-gdrive',
    category: 'productivity',
    icon: '📂',
    author: 'Anthropic',
    tools: 'gdrive_search, gdrive_read_file',
    docsUrl: 'https://github.com/modelcontextprotocol/servers/tree/main/src/gdrive',
  },
  {
    id: 'mcp-notion',
    name: 'Notion',
    description: 'Read pages, search your workspace, and create new content inside Notion.',
    installUri: 'npx @modelcontextprotocol/server-notion',
    category: 'productivity',
    icon: '📓',
    author: 'Anthropic',
    tools: 'notion_search, notion_get_page, notion_create_page',
    docsUrl: 'https://github.com/modelcontextprotocol/servers/tree/main/src/notion',
    credentials: [
      {
        key: 'NOTION_API_KEY',
        label: 'Notion integration token',
        kind: 'env',
        help: 'Create an internal integration and share the pages you want Artha to access with it.',
        link: 'https://www.notion.so/my-integrations',
        placeholder: 'secret_…',
      },
    ],
  },

  // ── Data ─────────────────────────────────────────────────────────────────
  {
    id: 'mcp-sqlite',
    name: 'SQLite',
    description: 'Query any SQLite database file. Run SELECTs, inspect schemas, and export results as Markdown tables.',
    installUri: 'npx @modelcontextprotocol/server-sqlite',
    category: 'data',
    icon: '🗄️',
    author: 'Anthropic',
    tools: 'query, list_tables, describe_table',
    docsUrl: 'https://github.com/modelcontextprotocol/servers/tree/main/src/sqlite',
  },
  {
    id: 'mcp-postgres',
    name: 'PostgreSQL',
    description: 'Connect to a Postgres database — run read-only queries, inspect tables, and fetch data.',
    installUri: 'npx @modelcontextprotocol/server-postgres',
    category: 'data',
    icon: '🐘',
    author: 'Anthropic',
    tools: 'query, list_tables, describe_table',
    docsUrl: 'https://github.com/modelcontextprotocol/servers/tree/main/src/postgres',
    credentials: [
      {
        key: 'connectionString',
        label: 'Postgres connection string',
        kind: 'arg',
        help: 'A read-only role is recommended. The URL is passed to the server, never sent to the model.',
        placeholder: 'postgresql://user:pass@host:5432/dbname',
      },
    ],
  },

  // ── Dev ──────────────────────────────────────────────────────────────────
  {
    id: 'mcp-github',
    name: 'GitHub',
    description: 'Search repos, read files, create issues and PRs, and manage your GitHub repositories.',
    installUri: 'npx @modelcontextprotocol/server-github',
    category: 'dev',
    icon: '🐙',
    author: 'Anthropic',
    tools: 'github_search, github_read_file, github_create_issue, github_create_pr',
    docsUrl: 'https://github.com/modelcontextprotocol/servers/tree/main/src/github',
    credentials: [
      {
        key: 'GITHUB_PERSONAL_ACCESS_TOKEN',
        label: 'GitHub personal access token',
        kind: 'env',
        help: 'A fine-grained token scoped to just the repos you want is safest. Needs repo read (and write for issues/PRs).',
        link: 'https://github.com/settings/tokens',
        placeholder: 'ghp_… or github_pat_…',
      },
    ],
  },
  {
    id: 'mcp-git',
    name: 'Git',
    description: 'Run git commands — log, diff, status, blame — on any local repository.',
    installUri: 'uvx mcp-server-git',
    category: 'dev',
    icon: '🌿',
    author: 'Anthropic',
    tools: 'git_log, git_diff, git_status, git_show, git_blame',
    docsUrl: 'https://github.com/modelcontextprotocol/servers/tree/main/src/git',
  },

  // ── Communication ─────────────────────────────────────────────────────────
  {
    id: 'mcp-slack',
    name: 'Slack',
    description: 'Read channels, search messages, and post to Slack workspaces you belong to.',
    installUri: 'npx @modelcontextprotocol/server-slack',
    category: 'communication',
    icon: '💬',
    author: 'Anthropic',
    tools: 'slack_list_channels, slack_post_message, slack_search_messages',
    docsUrl: 'https://github.com/modelcontextprotocol/servers/tree/main/src/slack',
    credentials: [
      {
        key: 'SLACK_BOT_TOKEN',
        label: 'Slack bot token',
        kind: 'env',
        help: 'Create a Slack app, add the bot scopes you need, install it to your workspace, and copy the Bot User OAuth Token.',
        link: 'https://api.slack.com/apps',
        placeholder: 'xoxb-…',
      },
      {
        key: 'SLACK_TEAM_ID',
        label: 'Slack team ID',
        kind: 'env',
        help: 'Your workspace ID (starts with T). Find it in your Slack URL or workspace settings.',
        placeholder: 'T01234567',
      },
    ],
  },

  // ── AI ───────────────────────────────────────────────────────────────────
  {
    id: 'mcp-memory',
    name: 'Knowledge Graph Memory',
    description: 'Persistent memory using a local knowledge graph. Let the agent remember entities, facts, and relationships across sessions.',
    installUri: 'npx @modelcontextprotocol/server-memory',
    category: 'ai',
    icon: '🧠',
    author: 'Anthropic',
    tools: 'create_entities, create_relations, search_nodes, open_nodes',
    docsUrl: 'https://github.com/modelcontextprotocol/servers/tree/main/src/memory',
  },
  {
    id: 'mcp-sequential-thinking',
    name: 'Sequential Thinking',
    description: 'Gives the agent an explicit scratchpad for multi-step reasoning — improves accuracy on complex tasks.',
    installUri: 'npx @modelcontextprotocol/server-sequential-thinking',
    category: 'ai',
    icon: '🧩',
    author: 'Anthropic',
    tools: 'sequentialthinking',
    docsUrl: 'https://github.com/modelcontextprotocol/servers/tree/main/src/sequentialthinking',
  },
];

/** Category metadata for UI rendering */
export const CATEGORIES: { id: McpCategory | 'all'; label: string; icon: string }[] = [
  { id: 'all',            label: 'All',          icon: '✦' },
  { id: 'filesystem',     label: 'Filesystem',   icon: '📁' },
  { id: 'web',            label: 'Web',          icon: '🌐' },
  { id: 'productivity',   label: 'Productivity', icon: '📝' },
  { id: 'data',           label: 'Data',         icon: '🗄️' },
  { id: 'dev',            label: 'Dev',          icon: '🐙' },
  { id: 'communication',  label: 'Comms',        icon: '💬' },
  { id: 'ai',             label: 'AI',           icon: '🧠' },
];
