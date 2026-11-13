/**
 * Tests for the process-wide kill-switch wiring: loops register with a cancel
 * callback, a stop press cancels each through it, marks the workflow as
 * stopped (so it can never be recorded completed) and writes one receipt per
 * stopped run.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  installKillSwitch, trackRun, wasStoppedByUser, triggerStop, getKillSwitch,
  __resetDesktopRuntimeForTests, type InstallDeps,
} from './runtime';
import { DesktopActionQueue, StoppedByUserError } from './actionQueue';
import { terminalStatusAfterStop } from './killSwitch';

function install(queue = new DesktopActionQueue()) {
  const deps = {
    register: vi.fn(() => true),
    unregister: vi.fn(),
    rejectDesktopActions: vi.fn(() => queue.stopAll()),
    hideOverlay: vi.fn(),
    setBrowserDrivingToUser: vi.fn(),
    recordStopReceipt: vi.fn(),
  } satisfies InstallDeps;
  installKillSwitch(deps, 'Control+Alt+Shift+.');
  return deps;
}

beforeEach(() => __resetDesktopRuntimeForTests());

describe('desktop runtime', () => {
  it('holds the shortcut only while a tracked run is alive', () => {
    const deps = install();
    const untrack = trackRun({ workflowId: 'w1', runId: 'r1', sessionId: 's1', cancel: () => {} });
    expect(deps.register).toHaveBeenCalledTimes(1);
    expect(getKillSwitch()?.isRegistered).toBe(true);
    untrack();
    untrack(); // idempotent
    expect(deps.unregister).toHaveBeenCalledTimes(1);
  });

  it('a stop cancels every active run via its cancel path and receipts each', async () => {
    const queue = new DesktopActionQueue();
    const deps = install(queue);
    const c1 = vi.fn(); const c2 = vi.fn();
    trackRun({ workflowId: 'w1', runId: 'r1', sessionId: 's1', cancel: c1 });
    trackRun({ workflowId: 'w2', runId: 'r2', sessionId: 's2', cancel: c2 });
    const queued = queue.enqueue(async () => 'never');

    const report = triggerStop();
    expect(c1).toHaveBeenCalled();
    expect(c2).toHaveBeenCalled();
    expect(report?.stoppedWorkflows.sort()).toEqual(['w1', 'w2']);
    await expect(queued).rejects.toBeInstanceOf(StoppedByUserError);
    expect(deps.hideOverlay).toHaveBeenCalled();
    expect(deps.setBrowserDrivingToUser).toHaveBeenCalled();
    expect(deps.recordStopReceipt).toHaveBeenCalledWith(
      { workflowId: 'w1', runId: 'r1', sessionId: 's1' }, expect.objectContaining({ actionsRejected: expect.any(Number) }),
    );
    expect(deps.recordStopReceipt).toHaveBeenCalledTimes(2);
  });

  it('a stopped run can never be marked completed', () => {
    install();
    const untrack = trackRun({ workflowId: 'w1', runId: 'r1', sessionId: 's1', cancel: () => {} });
    triggerStop();
    expect(wasStoppedByUser('w1')).toBe(true);
    // The orchestrator's completion guard consults wasStoppedByUser().
    expect(terminalStatusAfterStop('completed', wasStoppedByUser('w1'))).toBe('cancelled');
    untrack();
    expect(wasStoppedByUser('w1')).toBe(false); // a later run with a fresh id is unaffected
  });

  it('runs tracked before install still get the shortcut', () => {
    trackRun({ workflowId: 'w0', runId: 'r0', sessionId: 's0', cancel: () => {} });
    const deps = install();
    expect(deps.register).toHaveBeenCalledTimes(1);
  });
});
