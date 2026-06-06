/**
 * Tests for the ENV:KEY=value install-convention parser. This is the seam that
 * makes the legacy "MCP Tools → Connect" credential path actually spawn (it used
 * to embed `ENV:` tokens that nothing parsed) and that lets the installer move
 * those secrets into the encrypted store + a clean URI.
 */
import { describe, it, expect } from 'vitest';
import { parseEnvTokens } from './envTokens';

describe('parseEnvTokens', () => {
  it('extracts a single leading ENV token and cleans the command', () => {
    const { cleanUri, env } = parseEnvTokens('ENV:BRAVE_API_KEY=BSA123 npx -y @modelcontextprotocol/server-brave-search');
    expect(cleanUri).toBe('npx -y @modelcontextprotocol/server-brave-search');
    expect(env).toEqual({ BRAVE_API_KEY: 'BSA123' });
  });

  it('extracts multiple ENV tokens', () => {
    const { cleanUri, env } = parseEnvTokens('ENV:SLACK_BOT_TOKEN=xoxb-1 ENV:SLACK_TEAM_ID=T01 npx server-slack');
    expect(cleanUri).toBe('npx server-slack');
    expect(env).toEqual({ SLACK_BOT_TOKEN: 'xoxb-1', SLACK_TEAM_ID: 'T01' });
  });

  it('leaves a plain command untouched and returns an empty env', () => {
    const { cleanUri, env } = parseEnvTokens('uvx mcp-server-git');
    expect(cleanUri).toBe('uvx mcp-server-git');
    expect(env).toEqual({});
  });

  it('preserves values that contain = signs (e.g. base64 tokens)', () => {
    const { env } = parseEnvTokens('ENV:TOKEN=ab==cd npx srv');
    expect(env).toEqual({ TOKEN: 'ab==cd' });
  });

  it('ignores a malformed ENV token with no = and drops it from the command', () => {
    const { cleanUri, env } = parseEnvTokens('ENV:BROKEN npx srv');
    expect(cleanUri).toBe('npx srv');
    expect(env).toEqual({});
  });
});
