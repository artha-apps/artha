import { describe, it, expect } from 'vitest';
import { parseServerUri } from './serverUri';

describe('parseServerUri', () => {
  it('parses a plain command with no credentials', () => {
    const r = parseServerUri('npx -y @modelcontextprotocol/server-github');
    expect(r.credEnv).toEqual({});
    expect(r.command).toBe('npx');
    expect(r.args).toEqual(['-y', '@modelcontextprotocol/server-github']);
  });

  it('peels a single ENV: credential off the front', () => {
    const r = parseServerUri('ENV:GITHUB_PERSONAL_ACCESS_TOKEN=ghp_abc123 npx -y @modelcontextprotocol/server-github');
    expect(r.credEnv).toEqual({ GITHUB_PERSONAL_ACCESS_TOKEN: 'ghp_abc123' });
    expect(r.command).toBe('npx');
    expect(r.args).toEqual(['-y', '@modelcontextprotocol/server-github']);
  });

  it('peels multiple ENV: credentials (Slack needs two)', () => {
    const r = parseServerUri('ENV:SLACK_BOT_TOKEN=xoxb-1 ENV:SLACK_TEAM_ID=T123 npx -y @modelcontextprotocol/server-slack');
    expect(r.credEnv).toEqual({ SLACK_BOT_TOKEN: 'xoxb-1', SLACK_TEAM_ID: 'T123' });
    expect(r.command).toBe('npx');
    expect(r.args).toEqual(['-y', '@modelcontextprotocol/server-slack']);
  });

  it('keeps "=" that appears inside a credential value', () => {
    const r = parseServerUri('ENV:KEY=a=b=c node server.js');
    expect(r.credEnv).toEqual({ KEY: 'a=b=c' });
    expect(r.command).toBe('node');
    expect(r.args).toEqual(['server.js']);
  });

  it('does not treat a later non-prefixed token as an env var', () => {
    // Only LEADING ENV: tokens are credentials; args are left intact.
    const r = parseServerUri('npx server --flag ENV:NOPE=1');
    expect(r.credEnv).toEqual({});
    expect(r.command).toBe('npx');
    expect(r.args).toEqual(['server', '--flag', 'ENV:NOPE=1']);
  });

  it('returns an empty command for a blank URI', () => {
    expect(parseServerUri('   ').command).toBe('');
  });
});
