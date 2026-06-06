/**
 * MCP Tool Registry — manages all MCP server connections and tool invocations.
 * Built on the Anthropic MCP TypeScript SDK.
 * Any installed MCP server is auto-discovered and available to the agent.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { spawnEnv } from '../system/nodePath';
import { getDb } from '../db/schema';
import OpenAI from 'openai';
import { FILESYSTEM_TOOL_SCHEMAS, invokeFilesystemTool, isFilesystemTool } from '../tools/filesystem';
import { WEB_TOOL_SCHEMAS, invokeWebTool, isWebTool } from '../tools/web';
import { BROWSER_TOOL_SCHEMAS, invokeBrowserTool, isBrowserTool } from '../tools/browser';
import { DOCS_TOOL_SCHEMAS, invokeDocsTool, isDocsTool } from '../tools/docs';
import { RAG_TOOL_SCHEMAS, invokeRagTool, isRagTool } from '../tools/rag';
import { KG_TOOL_SCHEMAS, invokeKgTool, isKgTool } from '../tools/kg';
import { CRM_TOOL_SCHEMAS, invokeCrmTool, isCrmTool } from '../tools/crm';
import type { ScopeRoot } from '../db/scopes';
import { openCredentials, sealCredentials, type StoredCredentials } from '../security/secrets';
import { parseEnvTokens } from './envTokens';

// Re-export so existing importers (`ipc/handlers.ts`) can keep pulling the ENV:
// token parser from the registry; the implementation lives in the
// dependency-free envTokens.ts (the single source of truth for ENV: parsing,
// replacing the former serverUri.ts).
export { parseEnvTokens };

/** Per-invocation context derived from the active chat's scopes. When the chat
 *  has attached folders/files: `allowedRoots` confines filesystem tools to them,
 *  `primaryDir` becomes the default output directory for generated docs, and
 *  `ragIndexIds` confines rag_search / doc grounding to the chat's folders. */
export interface ToolContext {
  allowedRoots?: ScopeRoot[] | null;
  primaryDir?: string | null;
  ragIndexIds?: string[] | null;
  /** The active session's project (NULL = global). Scopes CRM/KG writes so they
   *  belong to the same project bucket as memories. */
  projectId?: string | null;
}

/**
 * Runtime record of one connected MCP server: its SDK client handle plus the
 * OpenAI-formatted tool schemas negotiated at connection time. Kept in the
 * `connections` map keyed by the DB `tool_id`.
 */
interface MCPServerConnection {
  id: string;
  name: string;
  client: Client;
  tools: OpenAI.ChatCompletionTool[];
}

/**
 * Singleton registry that manages the lifecycle of every MCP server process
 * and owns the dispatch logic for all tool invocations.
 *
 * Lifetime: created once in `handlers.ts`, lives until app quit.
 */
export class MCPRegistry {
  private static instance: MCPRegistry;
  // tool_id → live connection (stdio sub-process + negotiated tool schemas)
  private connections = new Map<string, MCPServerConnection>();

  static getInstance(): MCPRegistry {
    if (!MCPRegistry.instance) MCPRegistry.instance = new MCPRegistry();
    return MCPRegistry.instance;
  }

  /** Load and connect all enabled MCP servers from the database, decrypting any
   *  stored credentials so auth-gated connectors (GitHub, Slack, …) come back up
   *  on launch with their keys injected. */
  async loadFromDatabase(): Promise<void> {
    const db = getDb();

    // One-time plaintext scrub across ALL rows — enabled AND disabled. Older
    // installs stored secrets as inline ENV: tokens in mcp_server_uri (also
    // leaked via listTools / bundle export). Move them into the encrypted column
    // and rewrite a clean URI so no plaintext secret survives at rest. Runs over
    // every row, because the connect loop below only visits enabled ones — a
    // disabled legacy connector would otherwise keep its key in cleartext.
    const plaintextRows = db.prepare(
      `SELECT tool_id, mcp_server_uri, credentials_enc FROM tools WHERE mcp_server_uri LIKE '%ENV:%'`
    ).all() as { tool_id: string; mcp_server_uri: string; credentials_enc: string | null }[];
    for (const row of plaintextRows) {
      try {
        const { cleanUri, env } = parseEnvTokens(row.mcp_server_uri);
        const existing = openCredentials(row.credentials_enc);
        const merged = { env: { ...env, ...(existing.env ?? {}) }, args: existing.args };
        db.prepare(`UPDATE tools SET mcp_server_uri=?, credentials_enc=? WHERE tool_id=?`)
          .run(cleanUri, sealCredentials(merged), row.tool_id);
      } catch (err) {
        console.warn(`[MCP] plaintext scrub skipped for ${row.tool_id}:`, err);
      }
    }

    const rows = db.prepare(`SELECT * FROM tools WHERE is_enabled = 1 AND mcp_server_uri IS NOT NULL`).all() as {
      tool_id: string; name: string; mcp_server_uri: string; credentials_enc: string | null;
    }[];
    for (const row of rows) {
      let creds: StoredCredentials;
      try {
        creds = openCredentials(row.credentials_enc);
      } catch (err) {
        // Credentials can't be decrypted (OS keychain reset, or the DB was copied
        // to another machine). Record the failure so the panel shows "not
        // connected" + Retry instead of a stale green "connected" badge.
        this.recordStatus(row.tool_id, 'error', 'Stored credentials could not be decrypted on this machine.');
        console.error(`[MCP] cannot decrypt credentials for ${row.name}:`, err);
        continue;
      }
      try {
        await this.connectServer(row.tool_id, row.name, row.mcp_server_uri, creds);
      } catch (err) {
        console.error(`Failed to connect MCP server ${row.name}:`, err);
      }
    }
  }

  /**
   * Spawn the MCP server process described by `serverUri` (space-separated
   * command + args, e.g. `"npx @modelcontextprotocol/server-filesystem"`),
   * negotiate capabilities, and cache the resulting tool schemas.
   *
   * `creds` carries the connector's decrypted secrets: `env` vars are handed to
   * the child process and `args` are appended after the base command (e.g. a
   * Postgres connection string). Secrets are passed only to this server's own
   * process — never logged, and never exposed to the model. Any inline ENV:
   * tokens still present in `serverUri` are also peeled off and merged
   * (structured `creds.env` wins on key collision).
   *
   * The merged env is layered onto `spawnEnv()` so the child still inherits the
   * augmented PATH — npx/node resolve even in a Finder-launched packaged app
   * (minimal macOS GUI PATH). Overwrites any previous connection for the same
   * `id` (hot-reload safe).
   */
  async connectServer(id: string, name: string, serverUri: string, creds?: StoredCredentials): Promise<void> {
    // Reconnecting the same id (e.g. after a credential change) — tear down the
    // old child process first so we don't leak a stdio sub-process.
    await this.disconnectServer(id);

    try {
      const { cleanUri, env: uriEnv } = parseEnvTokens(serverUri);
      const [cmd, ...baseArgs] = cleanUri.split(' ');
      if (!cmd) throw new Error(`Invalid MCP server command: "${serverUri}"`);
      const args = [...baseArgs, ...(creds?.args ?? [])];
      const credEnv = { ...uriEnv, ...(creds?.env ?? {}) };

      // Augmented PATH (packaged-app fix) plus this connector's credential env.
      const transport = new StdioClientTransport({ command: cmd, args, env: spawnEnv(credEnv) });
      const client = new Client({ name: 'artha', version: '0.1.0' }, { capabilities: {} });

      await client.connect(transport);

      const { tools } = await client.listTools();
      const openaiTools: OpenAI.ChatCompletionTool[] = tools.map(t => ({
        type: 'function',
        function: {
          name: t.name,
          description: t.description ?? '',
          parameters: t.inputSchema as Record<string, unknown>,
        },
      }));

      this.connections.set(id, { id, name, client, tools: openaiTools });
      this.recordStatus(id, 'connected', null);
      console.log(`[MCP] Connected: ${name} (${tools.length} tools)`);
    } catch (err) {
      // Persist the failure so the UI can show "not connected" + Retry rather
      // than implying the row is live. The row (and its encrypted credentials)
      // is kept so a transient failure — e.g. npx cold-start — recovers on the
      // next launch / Retry without the user re-entering keys. Re-throw so
      // callers (install IPC) can still surface the error inline.
      this.recordStatus(id, 'error', err instanceof Error ? err.message : String(err));
      throw err;
    }
  }

  /** Persist a server's last connection outcome. Best-effort: a status write
   *  must never be the reason a connect/disconnect fails, and a row that no
   *  longer exists (removed mid-flight) is simply a no-op. */
  private recordStatus(id: string, status: 'connected' | 'error' | 'disabled', error: string | null): void {
    try {
      getDb().prepare(`UPDATE tools SET conn_status=?, conn_error=? WHERE tool_id=?`)
        .run(status, error, id);
    } catch (err) {
      console.warn(`[MCP] Could not record status for ${id}:`, err);
    }
  }

  /** Get all tool schemas — built-in tools first, then any connected MCP servers. */
  getToolSchemas(): OpenAI.ChatCompletionTool[] {
    const mcpTools = Array.from(this.connections.values()).flatMap(c => c.tools);
    return [...FILESYSTEM_TOOL_SCHEMAS, ...WEB_TOOL_SCHEMAS, ...BROWSER_TOOL_SCHEMAS, ...DOCS_TOOL_SCHEMAS, ...RAG_TOOL_SCHEMAS, ...KG_TOOL_SCHEMAS, ...CRM_TOOL_SCHEMAS, ...mcpTools];
  }

  /** Invoke a named tool — built-in tools first, then MCP servers.
   *  Built-ins are checked first so a malicious or buggy MCP server can't
   *  shadow `fs_move_file` etc. by re-using the name. */
  async invokeTool(toolName: string, args: Record<string, unknown>, ctx?: ToolContext): Promise<string> {
    if (isFilesystemTool(toolName)) {
      return invokeFilesystemTool(toolName, args, ctx?.allowedRoots);
    }
    if (isWebTool(toolName)) {
      return invokeWebTool(toolName, args);
    }
    if (isBrowserTool(toolName)) {
      return invokeBrowserTool(toolName, args);
    }
    if (isDocsTool(toolName)) {
      return invokeDocsTool(toolName, args, ctx?.primaryDir, ctx?.ragIndexIds);
    }
    if (isRagTool(toolName)) {
      return invokeRagTool(toolName, args, ctx?.ragIndexIds);
    }
    if (isKgTool(toolName)) {
      return invokeKgTool(toolName, args, ctx?.projectId);
    }
    if (isCrmTool(toolName)) {
      return invokeCrmTool(toolName, args, ctx?.projectId);
    }
    for (const conn of this.connections.values()) {
      const hasTool = conn.tools.some(t => t.function.name === toolName);
      if (hasTool) {
        const result = await conn.client.callTool({ name: toolName, arguments: args });
        return JSON.stringify(result.content);
      }
    }
    throw new Error(`Tool not found: ${toolName}`);
  }

  /** Tear down one server's stdio sub-process and drop its tools from the live
   *  schema set. Safe to call for an unknown/already-gone id (no-op). Used when
   *  a server is removed or disabled so its process doesn't linger (holding its
   *  credentials in memory) and its tools stop being offered to the agent. */
  async disconnectServer(id: string): Promise<void> {
    const conn = this.connections.get(id);
    if (!conn) return;
    this.connections.delete(id);
    try { await conn.client.close(); } catch { /* already gone */ }
  }

  /** Tear down every stdio sub-process. Called on app quit / hot reload. */
  async disconnectAll(): Promise<void> {
    for (const conn of this.connections.values()) {
      await conn.client.close();
    }
    this.connections.clear();
  }
}
