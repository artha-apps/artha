/**
 * Tests for the desktop action gate: unapproved apps route to the existing
 * confirmation flow, unattended runs skip, deny-listed apps always ask.
 */
import { describe, it, expect, vi } from 'vitest';
import { gateDesktopAction, type DesktopGateDeps } from './desktopGate';
import { InMemoryAppGrantStore } from './appGrants';
import type { GrantAnswer } from './appGrants';

function deps(app: string | null, answer: GrantAnswer = 'once', store = new InMemoryAppGrantStore()) {
  const confirm = vi.fn(async () => answer);
  const d: DesktopGateDeps = { store, resolveApp: async () => app, confirm, nowSec: () => 1_800_000_000 };
  return { d, confirm, store };
}
const ctx = { toolName: 'desktop_click', args: { x: 1, y: 2 }, sessionId: 's1', projectId: 'p1', unattended: false };

describe('gateDesktopAction', () => {
  it('read-only desktop tools are not gated', async () => {
    const { d, confirm } = deps('Notes');
    const r = await gateDesktopAction(d, { ...ctx, toolName: 'desktop_screenshot' });
    expect(r.proceed).toBe(true);
    expect(confirm).not.toHaveBeenCalled();
  });

  it('unapproved app → confirmation; approving once lets later actions through without asking', async () => {
    const { d, confirm } = deps('Notes', 'once');
    expect((await gateDesktopAction(d, ctx)).proceed).toBe(true);
    expect(confirm).toHaveBeenCalledWith({ appName: 'Notes', alwaysAllowed: true, reason: 'unapproved' });
    expect((await gateDesktopAction(d, ctx)).proceed).toBe(true);
    expect(confirm).toHaveBeenCalledTimes(1);
  });

  it('deny blocks the action', async () => {
    const { d } = deps('Notes', 'deny');
    const r = await gateDesktopAction(d, ctx);
    expect(r).toMatchObject({ proceed: false, status: 'blocked' });
  });

  it('unattended + unapproved → skipped without prompting', async () => {
    const { d, confirm } = deps('Notes');
    const r = await gateDesktopAction(d, { ...ctx, unattended: true });
    expect(r).toMatchObject({ proceed: false, status: 'skipped' });
    expect(confirm).not.toHaveBeenCalled();
  });

  it('a LAN run never rides the host\'s app grants, and cannot view the screen (R2 #6)', async () => {
    const { d, confirm } = deps('Notes', 'always');
    // The host granted Notes for this project.
    expect((await gateDesktopAction(d, ctx)).proceed).toBe(true);
    confirm.mockClear();
    const lan = { ...ctx, unattended: true, lan: true };
    expect(await gateDesktopAction(d, lan)).toMatchObject({ proceed: false, status: 'skipped' });
    expect(await gateDesktopAction(d, { ...lan, toolName: 'desktop_screenshot' }))
      .toMatchObject({ proceed: false, status: 'skipped' });
    expect(confirm).not.toHaveBeenCalled();
  });

  it('deny-listed app asks every time, even after "always"', async () => {
    const { d, confirm } = deps('Terminal', 'always');
    await gateDesktopAction(d, ctx);
    await gateDesktopAction(d, ctx);
    expect(confirm).toHaveBeenCalledTimes(2);
    expect(confirm).toHaveBeenLastCalledWith(expect.objectContaining({ reason: 'always_confirm', alwaysAllowed: false }));
  });

  it('desktop_open_app is gated on the app being opened', async () => {
    const resolveApp = vi.fn(async (_t: string, a: Record<string, unknown>) => String(a.appName));
    const confirm = vi.fn(async (): Promise<GrantAnswer> => 'deny');
    const r = await gateDesktopAction(
      { store: new InMemoryAppGrantStore(), resolveApp, confirm, nowSec: () => 1 },
      { ...ctx, toolName: 'desktop_open_app', args: { appName: 'Mail' } },
    );
    expect(r).toMatchObject({ proceed: false, appName: 'Mail' });
  });

  it('a resolver failure is treated as an unknown app (asks)', async () => {
    const confirm = vi.fn(async (): Promise<GrantAnswer> => 'deny');
    const r = await gateDesktopAction(
      { store: new InMemoryAppGrantStore(), resolveApp: async () => { throw new Error('x'); }, confirm, nowSec: () => 1 },
      ctx,
    );
    expect(confirm).toHaveBeenCalledWith(expect.objectContaining({ reason: 'unknown_app' }));
    expect(r.proceed).toBe(false);
  });
});
