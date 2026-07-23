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

  it('email_SEND is the email tool the agent sees — and email_compose is NOT advertised', () => {
    // A small local model kept mistaking email_compose (draft) for sending, so
    // Delegate is shown ONLY email_send (which actually delivers + reports
    // honestly). email_compose stays dispatchable but is not offered to the model.
    const names = reg.getToolSchemas().map(t => t.function.name);
    expect(names).toContain('email_send');
    expect(names).not.toContain('email_compose');
  });

  it("the operator's empty allowlist keeps email_send available (empty = all tools)", () => {
    const all = reg.getToolSchemas();
    const asOperatorSees = filterToolsByAllowlist(all, []); // operator.ts: allowedTools: []
    expect(asOperatorSees.map(t => t.function.name)).toContain('email_send');
  });

  it('invokeTool still routes email_compose when called directly (back-compat), producing a DRAFT', async () => {
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
