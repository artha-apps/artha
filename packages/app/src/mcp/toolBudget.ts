/**
 * Tool budget — which MCP tools a run is offered.
 *
 * Every tool schema the model sees costs prompt tokens on every turn and, for
 * small local models, attention: on the founder's Mac 27 of 44 schemas came
 * from two demo/unconfigured MCP servers, and the first turn spent ~5k tokens
 * describing tools the task could never use. Worse, the demo filesystem server
 * offered `move_file` next to Artha's sandboxed `fs_move_file`; the model
 * picked the un-sandboxed twin, which failed (no roots), and the run stalled.
 *
 * Built-in tools are always offered (skill allowlists aside). MCP tools are
 * offered when they earn it:
 *   1. shadow rule — an MCP tool whose name duplicates a built-in capability
 *      (`move_file` vs `fs_move_file`) is hidden. Built-ins are sandboxed,
 *      undo-tracked and receipt-logged; the model must never be offered two
 *      tools for one action.
 *   2. relevance — a server's remaining tools are offered when the goal names
 *      the server or its tools, when an explicitly invoked skill allowlists
 *      one of them, or when the server has already succeeded in this session.
 *   3. health — a server that has only ever failed is quarantined by the
 *      registry and not offered at all (see MCPRegistry.recordOutcome).
 *
 * This is a prefilter, not a wall: when a turn is DISCARDED because the model
 * called a tool it was not offered, the act loop's escalation restores the
 * full set for the rest of the run (agent/escalation.ts). Pure + dependency-
 * free so it is unit-tested without servers.
 */
import type OpenAI from 'openai';

export interface McpServerTools {
  id: string;
  name: string;
  tools: OpenAI.ChatCompletionTool[];
}

export interface SelectToolsInput {
  builtIn: OpenAI.ChatCompletionTool[];
  servers: McpServerTools[];
  goal: string;
  /** Server ids that produced at least one successful call in this session. */
  recentlyUsed: Set<string>;
  /** The run's enforced skill allowlist ([] = unrestricted). */
  allowlist: string[];
}

export interface SelectToolsResult {
  tools: OpenAI.ChatCompletionTool[];
  /** Servers whose tools were withheld for this run (name → why). */
  withheld: { server: string; reason: 'irrelevant' | 'shadowed' }[];
  /** Everything (built-in + all non-shadowed MCP), for escalation. */
  full: OpenAI.ChatCompletionTool[];
}

/** Built-in tool names reduced to their capability: `fs_move_file` → `move_file`.
 *  Only the filesystem prefix is stripped — `browser_click` stays as is, since
 *  an MCP `click` is not the same capability. */
export function capabilityKey(name: string): string {
  return name.toLowerCase().replace(/^fs_/, '');
}

/** MCP tool names that duplicate a built-in. Compared by capability key, with
 *  a few common aliases the reference filesystem server uses. */
const ALIASES: Record<string, string> = {
  read_text_file: 'read_file',
  read_multiple_files: 'read_file',
  list_directory_with_sizes: 'list_directory',
  get_file_info: 'get_file_info',
  write_file: 'write_file',
  edit_file: 'write_file',
};

export function isShadowedByBuiltIn(mcpToolName: string, builtInNames: Set<string>): boolean {
  const key = capabilityKey(mcpToolName);
  const builtInKeys = new Set([...builtInNames].map(capabilityKey));
  return builtInKeys.has(key) || builtInKeys.has(ALIASES[key] ?? '');
}

const STOP = new Set([
  'the', 'and', 'for', 'with', 'from', 'into', 'this', 'that', 'file', 'files', 'get', 'set', 'list',
  'read', 'write', 'create', 'new', 'all', 'any', 'one', 'two', 'use', 'using', 'server', 'mcp', 'tool',
  'tools', 'modelcontextprotocol', 'npx', 'run', 'data', 'info', 'text', 'name', 'value', 'item', 'items',
  'add', 'remove', 'update', 'delete', 'find', 'search', 'open', 'move', 'copy', 'folder', 'directory',
]);

/** Lower-cased word stems ≥ 3 chars, splitting snake/kebab/camel case. */
export function tokens(text: string): Set<string> {
  const out = new Set<string>();
  for (const raw of text.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length < 3 || STOP.has(raw)) continue;
    out.add(raw.endsWith('s') && raw.length > 4 ? raw.slice(0, -1) : raw);
  }
  return out;
}

/** Does the goal name this server or what it does? Server-name tokens are
 *  strong signal (one hit is enough); tool-name/description tokens need two
 *  distinct hits so generic verbs don't drag every server in. */
export function serverIsRelevant(goal: string, server: McpServerTools): boolean {
  const g = tokens(goal);
  if (g.size === 0) return false;
  for (const t of tokens(server.name)) if (g.has(t)) return true;
  const toolTokens = new Set<string>();
  for (const tool of server.tools) {
    for (const t of tokens(tool.function.name)) toolTokens.add(t);
    for (const t of tokens((tool.function.description ?? '').split(/[.\n]/)[0] ?? '')) toolTokens.add(t);
  }
  let hits = 0;
  for (const t of toolTokens) if (g.has(t) && ++hits >= 2) return true;
  return false;
}

export function selectToolsForRun(input: SelectToolsInput): SelectToolsResult {
  const builtInNames = new Set(input.builtIn.map(t => t.function.name));
  const withheld: SelectToolsResult['withheld'] = [];
  const offered: OpenAI.ChatCompletionTool[] = [...input.builtIn];
  const full: OpenAI.ChatCompletionTool[] = [...input.builtIn];
  const allow = new Set(input.allowlist);

  for (const server of input.servers) {
    const visible = server.tools.filter(t => !isShadowedByBuiltIn(t.function.name, builtInNames));
    if (visible.length === 0) {
      if (server.tools.length) withheld.push({ server: server.name, reason: 'shadowed' });
      continue;
    }
    full.push(...visible);
    const allowlisted = visible.some(t => allow.has(t.function.name) || [...allow].some(a => a.endsWith('_') && t.function.name.startsWith(a)));
    const relevant = allowlisted || input.recentlyUsed.has(server.id) || serverIsRelevant(input.goal, server);
    if (relevant) offered.push(...visible);
    else withheld.push({ server: server.name, reason: 'irrelevant' });
  }
  return { tools: offered, withheld, full };
}
