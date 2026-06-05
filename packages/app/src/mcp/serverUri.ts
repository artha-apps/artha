/**
 * Parse a stored MCP server URI into the pieces needed to spawn it.
 *
 * The Marketplace install form prefixes credential env vars onto the command
 * using an `ENV:KEY=VALUE` convention, e.g.
 *   "ENV:GITHUB_PERSONAL_ACCESS_TOKEN=ghp_xxx npx -y @modelcontextprotocol/server-github"
 * Those leading tokens must be split back out into an env map (NOT treated as
 * the command), or the spawn would try to exec "ENV:GITHUB_…" and fail.
 */
export interface ParsedServerUri {
  /** Credential env vars peeled off the front (may be empty). */
  credEnv: Record<string, string>;
  /** The executable to spawn (e.g. "npx"). Empty string if the URI was blank. */
  command: string;
  args: string[];
}

export function parseServerUri(serverUri: string): ParsedServerUri {
  const tokens = serverUri.split(' ').filter(Boolean);
  const credEnv: Record<string, string> = {};
  let i = 0;
  for (; i < tokens.length; i++) {
    const m = /^ENV:([^=]+)=(.*)$/.exec(tokens[i]);
    if (!m) break;
    credEnv[m[1]] = m[2];
  }
  const [command = '', ...args] = tokens.slice(i);
  return { credEnv, command, args };
}
