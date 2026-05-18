/**
 * MCP Tool Registry — manages all MCP server connections and tool invocations.
 * Built on the Anthropic MCP TypeScript SDK.
 * Any installed MCP server is auto-discovered and available to the agent.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { getDb } from '../db/schema';
import OpenAI from 'openai';
import { FILESYSTEM_TOOL_SCHEMAS, invokeFilesystemTool, isFilesystemTool } from '../tools/filesystem';

interface MCPServerConnection {
  id: string;
  name: string;
  client: Client;
  tools: OpenAI.ChatCompletionTool[];
}

export class MCPRegistry {
  private static instance: MCPRegistry;
  private connections = new Map<string, MCPServerConnection>();

  static getInstance(): MCPRegistry {
    if (!MCPRegistry.instance) MCPRegistry.instance = new MCPRegistry();
    return MCPRegistry.instance;
  }

  /** Load and connect all enabled MCP servers from the database. */
  async loadFromDatabase(): Promise<void> {
    const db = getDb();
    const rows = db.prepare(`SELECT * FROM tools WHERE is_enabled = 1 AND mcp_server_uri IS NOT NULL`).all() as {
      tool_id: string; name: string; mcp_server_uri: string;
    }[];

    for (const row of rows) {
      try {
        await this.connectServer(row.tool_id, row.name, row.mcp_server_uri);
      } catch (err) {
        console.warn(`[MCP] Failed to connect ${row.name}:`, err);
      }
    }
  }

  /** Connect to an MCP server and cache its tool schemas. */
  async connectServer(id: string, name: string, serverUri: string): Promise<void> {
    const [cmd, ...args] = serverUri.split(' ');
    const transport = new StdioClientTransport({ command: cmd, args });
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
    console.log(`[MCP] Connected: ${name} (${tools.length} tools)`);
  }

  /** Get all tool schemas — built-in tools first, then any connected MCP servers. */
  getToolSchemas(): OpenAI.ChatCompletionTool[] {
    const mcpTools = Array.from(this.connections.values()).flatMap(c => c.tools);
    return [...FILESYSTEM_TOOL_SCHEMAS, ...mcpTools];
  }

  /** Invoke a named tool — built-in tools first, then MCP servers. */
  async invokeTool(toolName: string, args: Record<string, unknown>): Promise<string> {
    // Built-in filesystem tools
    if (isFilesystemTool(toolName)) {
      return invokeFilesystemTool(toolName, args);
    }
    // External MCP server tools
    for (const conn of this.connections.values()) {
      const hasTool = conn.tools.some(t => t.function.name === toolName);
      if (hasTool) {
        const result = await conn.client.callTool({ name: toolName, arguments: args });
        return JSON.stringify(result.content);
      }
    }
    throw new Error(`Tool not found: ${toolName}`);
  }

  async disconnectAll(): Promise<void> {
    for (const conn of this.connections.values()) {
      await conn.client.close();
    }
    this.connections.clear();
  }
}
