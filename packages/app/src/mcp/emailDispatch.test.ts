/**
 * Proves the Delegate path can actually reach email — the exact question
 * "if I ask Delegate to send an email, will it work?".
 *
 * Delegate runs the operator skill with an EMPTY allowlist (= all tools) and
 * dispatches every tool call through MCPRegistry.invokeTool. So the two facts
 * that make email reachable through Delegate are:
 *   1. email_compose appears in getToolSchemas() — the list the planner and
 *      ReAct loop see, and which the operator's empty allowlist does not
 *      filter (skills/util.filterToolsByAllowlist: [] returns all);
 *   2. invokeTool('email_compose', …) routes to the email tool and produces a
 *      draft, reporting sent:false.
 * This test pins both against the REAL registry + dispatch, not mocks.
 */
import { describe, it, expect, vi } from 'vitest';

const { opened } = vi.hoisted(() => ({ opened: { urls: [] as string[] } }));
vi.mock('electron', () => ({
  shell: { openExternal: vi.fn(async (u: string) => { opened.urls.push(u); }) },
  app: { getPath: () => '/tmp', isPackaged: false },
  safeStorage: { isEncryptionAvailable: () => false },
}));
// getToolSchemas touches the DB only for MCP rows; stub it empty.
vi.mock('../db/schema', () => ({ getDb: () => ({ prepare: () => ({ all: () => [], get: () => undefined, run: () => ({}) }) }) }));

import { MCPRegistry } from './registry';
import { filterToolsByAllowlist } from '../skills/util';

describe('email is reachable through the Delegate operator path', () => {
  const reg = MCPRegistry.getInstance();

  it('email_compose is in the schema list the agent sees', () => {
    const names = reg.getToolSchemas().map(t => t.function.name);
    expect(names).toContain('email_compose');
  });

  it("the operator's empty allowlist does not filter it out (empty = all tools)", () => {
    const all = reg.getToolSchemas();
    const asOperatorSees = filterToolsByAllowlist(all, []); // operator.ts: allowedTools: []
    expect(asOperatorSees.map(t => t.function.name)).toContain('email_compose');
  });

  it('invokeTool routes email_compose to the email tool and produces a DRAFT (not a send)', async () => {
    const result = await reg.invokeTool('email_compose', {
      to: 'jane@example.com', subject: 'Q3 numbers', body: 'Here are the Q3 figures.',
    });
    const out = JSON.parse(result);
    expect(out.drafted).toBe(true);
    expect(out.sent).toBe(false);                       // it prepares, never sends
    expect(opened.urls[0]).toMatch(/^mailto:jane%40example\.com\?/);
    expect(out.user_action_required).toMatch(/press send/i);
  });

  it('an underspecified request (no recipient) errors clearly instead of pretending', async () => {
    const result = await reg.invokeTool('email_compose', { subject: 's', body: 'b' });
    expect(result).toMatch(/^Error:.*"to" is required/);
  });
});
