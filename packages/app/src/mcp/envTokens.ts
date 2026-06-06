/**
 * Parsing for the `ENV:KEY=value` install convention.
 *
 * This is the legacy way the MCP Tools panel passed secrets: it prepended
 * `ENV:KEY=value` tokens onto the server command string (and bundle import
 * recognises the same prefix). The registry parses them back out at spawn time
 * so the tokens become real environment variables instead of the process trying
 * to exec a command literally named `ENV:KEY=value`.
 *
 * Kept dependency-free (no Electron / SDK / DB imports) so it is trivially unit
 * testable in a plain Node environment.
 */

/**
 * Pull `ENV:KEY=value` tokens out of a server URI. Tokens may appear anywhere
 * in the string; every non-ENV token is preserved in its original order.
 * Returns the cleaned command string plus the extracted env map.
 *
 * NB: tokens are space-delimited, so a secret containing a space can't be
 * expressed this way — fine for API keys/tokens. Connection strings that may
 * contain spaces use the structured `args` credential path instead.
 */
export function parseEnvTokens(serverUri: string): { cleanUri: string; env: Record<string, string> } {
  const env: Record<string, string> = {};
  const kept: string[] = [];
  for (const tok of serverUri.split(' ')) {
    if (tok.startsWith('ENV:')) {
      const eq = tok.indexOf('=');
      if (eq > 4) env[tok.slice(4, eq)] = tok.slice(eq + 1);
    } else if (tok.length) {
      kept.push(tok);
    }
  }
  return { cleanUri: kept.join(' '), env };
}
