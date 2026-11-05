/**
 * Tests for the global kill switch and the desktop action queue: the shortcut
 * is held only while runs are active, a press cancels every run, rejects
 * queued/in-flight actions with stopped_by_user, and a stop never yields
 * `completed`.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  KillSwitch, type KillSwitchDeps, acceleratorHint, terminalStatusAfterStop, defaultStopAccelerator,
} from './killSwitch';
import { DesktopActionQueue, StoppedByUserError, STOPPED_BY_USER } from './actionQueue';

function makeDeps(queue = new DesktopActionQueue()) {
  let handler: (() => void) | null = null;
  const deps = {
    register: vi.fn((_a: string, cb: () => void) => { handler = cb; return true; }),
    unregister: vi.fn(),
    cancelRuns: vi.fn(),
    rejectDesktopActions: vi.fn(() => queue.stopAll()),
    hideOverlay: vi.fn(),
    setBrowserDrivingToUser: vi.fn(),
    recordStopReceipt: vi.fn(),
  } satisfies KillSwitchDeps;
  return { deps, press: () => handler?.(), queue };
}

describe('KillSwitch', () => {
  it('registers only while a run is active', () => {
    const { deps } = makeDeps();
    const ks = new KillSwitch(deps, 'Control+Alt+Shift+.');
    expect(deps.register).not.toHaveBeenCalled();
    ks.runStarted('w1');
    ks.runStarted('w2');
    expect(deps.register).toHaveBeenCalledTimes(1);
    ks.runEnded('w1');
    expect(deps.unregister).not.toHaveBeenCalled();
    ks.runEnded('w2');
    expect(deps.unregister).toHaveBeenCalledWith('Control+Alt+Shift+.');
    expect(ks.isRegistered).toBe(false);
  });

  it('pressing the shortcut cancels all runs, hides the overlay, hands the browser back and records receipts', () => {
    const { deps, press } = makeDeps();
    const ks = new KillSwitch(deps);
    ks.runStarted('w1');
    ks.runStarted('w2');
    press();
    expect(deps.cancelRuns).toHaveBeenCalledWith(['w1', 'w2']);
    expect(deps.rejectDesktopActions).toHaveBeenCalled();
    expect(deps.hideOverlay).toHaveBeenCalled();
    expect(deps.setBrowserDrivingToUser).toHaveBeenCalled();
    expect(deps.recordStopReceipt).toHaveBeenCalledTimes(2);
    expect(deps.recordStopReceipt.mock.calls[0][0]).toMatchObject({ workflowId: 'w1' });
  });

  it('rejects queued and in-flight desktop actions with stopped_by_user', async () => {
    const queue = new DesktopActionQueue();
    const { deps, press } = makeDeps(queue);
    const ks = new KillSwitch(deps);
    ks.runStarted('w1');

    let release!: () => void;
    const ran: string[] = [];
    const inflight = queue.enqueue(async (ctl) => {
      await new Promise<void>(r => { release = r; });
      ran.push('first');
      return ctl.isStopped() ? 'stopped' : 'done';
    });
    const queued1 = queue.enqueue(async () => { ran.push('second'); return 'x'; });
    const queued2 = queue.enqueue(async () => { ran.push('third'); return 'y'; });
    await Promise.resolve();

    press();
    release();
    await expect(inflight).rejects.toBeInstanceOf(StoppedByUserError);
    await expect(queued1).rejects.toMatchObject({ code: STOPPED_BY_USER });
    await expect(queued2).rejects.toMatchObject({ code: STOPPED_BY_USER });
    expect(ran).toEqual(['first']); // queued actions never started
    expect(deps.rejectDesktopActions).toHaveReturnedWith(3);
  });

  it('the queue keeps working for new actions after a stop', async () => {
    const q = new DesktopActionQueue();
    const dead = q.enqueue(async () => 1);
    q.stopAll();
    await expect(dead).rejects.toBeInstanceOf(StoppedByUserError);
    await expect(q.enqueue(async () => 2)).resolves.toBe(2);
  });

  it('falls back to the default accelerator when a custom one is refused', () => {
    const { deps } = makeDeps();
    deps.register.mockImplementationOnce(() => false);
    const ks = new KillSwitch(deps, 'F13');
    ks.runStarted('w1');
    expect(deps.register).toHaveBeenCalledTimes(2);
    expect(ks.currentAccelerator).not.toBe('F13');
    expect(ks.isRegistered).toBe(true);
  });

  it('setAccelerator re-registers while active', () => {
    const { deps } = makeDeps();
    const ks = new KillSwitch(deps, 'Control+Alt+Shift+.');
    ks.runStarted('w1');
    ks.setAccelerator('Control+Alt+Shift+K');
    expect(deps.unregister).toHaveBeenCalledWith('Control+Alt+Shift+.');
    expect(deps.register).toHaveBeenLastCalledWith('Control+Alt+Shift+K', expect.any(Function));
  });
});

describe('stop never yields completed', () => {
  it('terminalStatusAfterStop forces cancelled for a stopped run', () => {
    expect(terminalStatusAfterStop('completed', true)).toBe('cancelled');
    expect(terminalStatusAfterStop('failed', true)).toBe('cancelled');
    expect(terminalStatusAfterStop('completed', false)).toBe('completed');
  });
});

describe('acceleratorHint', () => {
  it('renders the macOS default as ⌃⌥⇧.', () => {
    expect(acceleratorHint(defaultStopAccelerator('darwin'), 'darwin')).toBe('⌃⌥⇧.');
    expect(acceleratorHint(defaultStopAccelerator('linux'), 'linux')).toBe('⌃⌥⇧.');
    expect(acceleratorHint('CommandOrControl+Shift+X', 'darwin')).toBe('⌘⇧X');
  });
});
