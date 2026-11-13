/**
 * Keep-awake follows the run lifecycle: the power-save blocker is held only
 * while at least one run is active AND the user opted in (and, on battery,
 * opted in for battery too), and it is always released when the last run ends.
 * Electron is mocked so installKeepAwake's real wiring is exercised as well.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const electron = vi.hoisted(() => {
  const handlers: Record<string, () => void> = {};
  const state = { battery: false };
  const started = new Set<number>();
  let next = 100;
  return {
    handlers, started, state,
    powerSaveBlocker: {
      start: vi.fn((_t: string) => { const id = next++; started.add(id); return id; }),
      stop: vi.fn((id: number) => { started.delete(id); }),
    },
    powerMonitor: {
      isOnBatteryPower: () => state.battery,
      on: (ev: string, fn: () => void) => { handlers[ev] = fn; },
    },
  };
});

vi.mock('electron', () => ({ powerSaveBlocker: electron.powerSaveBlocker, powerMonitor: electron.powerMonitor }));

import {
  KeepAwakeController, installKeepAwake, noteRunStarted, noteRunEnded, noteRunWaiting, setKeepAwakeController,
  readKeepAwakeSettings, type KeepAwakeSettings,
} from './keepAwake';

/** A fake blocker that tracks whether it is currently held. */
function fakeBlocker() {
  const held = new Set<number>();
  let id = 1;
  return {
    held,
    start: vi.fn((t: string) => { expect(t).toBe('prevent-app-suspension'); held.add(id); return id++; }),
    stop: vi.fn((i: number) => { held.delete(i); }),
  };
}

beforeEach(() => { electron.state.battery = false; electron.started.clear(); setKeepAwakeController(null); });

describe('KeepAwakeController', () => {
  it('holds while any run is active and releases when the last one ends', () => {
    const b = fakeBlocker();
    const c = new KeepAwakeController({ blocker: b, onBattery: () => false, settings: () => ({ keepAwakeWhileRunning: true, keepAwakeOnBattery: false }) });
    expect(c.holding).toBe(false);
    const t1 = c.runStarted('r1');
    const t2 = c.runStarted('r1'); // nested loop sharing a run id counts separately
    expect(b.start).toHaveBeenCalledTimes(1);
    expect(b.held.size).toBe(1);
    c.runEnded(t1);
    expect(b.held.size).toBe(1); // still one run active
    c.runEnded(t2);
    expect(b.held.size).toBe(0);
    expect(c.holding).toBe(false);
    c.runEnded(t2); // idempotent
    expect(b.stop).toHaveBeenCalledTimes(1);
  });

  it('a run waiting on the user does not hold the machine awake; it holds again once answered', () => {
    const b = fakeBlocker();
    const c = new KeepAwakeController({ blocker: b, onBattery: () => false, settings: () => ({ keepAwakeWhileRunning: true, keepAwakeOnBattery: false }) });
    const t = c.runStarted('r1');
    expect(c.holding).toBe(true);
    c.runWaiting(t, true);            // an approval prompt opened — it may wait for hours
    expect(c.holding).toBe(false);
    expect(c.activeRuns).toBe(1);     // still an active run, just not working
    expect(c.workingRuns).toBe(0);
    c.runWaiting(t, true);            // repeated notice changes nothing
    expect(b.stop).toHaveBeenCalledTimes(1);
    c.runWaiting(t, false);           // answered → working again
    expect(c.holding).toBe(true);
    c.runEnded(t);
    expect(c.holding).toBe(false);
  });

  it('holds while ANY run is working, even if another is waiting on the user', () => {
    const b = fakeBlocker();
    const c = new KeepAwakeController({ blocker: b, onBattery: () => false, settings: () => ({ keepAwakeWhileRunning: true, keepAwakeOnBattery: false }) });
    const waiting = c.runStarted('chat');
    const working = c.runStarted('scheduled');
    c.runWaiting(waiting, true);
    expect(c.holding).toBe(true);     // the scheduled run is still working
    c.runEnded(working);
    expect(c.holding).toBe(false);    // only the waiting run is left
    c.runEnded(waiting);              // ended while waiting (Stop) — no stale state
    const again = c.runStarted('next');
    expect(c.holding).toBe(true);
    c.runEnded(again);
    c.runWaiting(again, true);        // an ended run's late notice is ignored
    expect(c.workingRuns).toBe(0);
    expect(c.holding).toBe(false);
  });

  it('never holds when the setting is off (the default)', () => {
    const b = fakeBlocker();
    const c = new KeepAwakeController({ blocker: b, onBattery: () => false, settings: () => readKeepAwakeSettings('{}') });
    c.runStarted();
    expect(b.start).not.toHaveBeenCalled();
  });

  it('respects keepAwakeOnBattery and re-evaluates on power-source / settings changes', () => {
    const b = fakeBlocker();
    let battery = true;
    let s: KeepAwakeSettings = { keepAwakeWhileRunning: true, keepAwakeOnBattery: false };
    const c = new KeepAwakeController({ blocker: b, onBattery: () => battery, settings: () => s });
    const t = c.runStarted();
    expect(c.holding).toBe(false);       // on battery, battery toggle off
    battery = false; c.refresh();
    expect(c.holding).toBe(true);        // plugged in
    battery = true; c.refresh();
    expect(c.holding).toBe(false);       // unplugged again
    s = { ...s, keepAwakeOnBattery: true }; c.refresh();
    expect(c.holding).toBe(true);        // user allowed battery
    c.runEnded(t);
    expect(c.holding).toBe(false);
  });

  it('parses settings defensively (defaults off)', () => {
    expect(readKeepAwakeSettings(null)).toEqual({ keepAwakeWhileRunning: false, keepAwakeOnBattery: false });
    expect(readKeepAwakeSettings('not json')).toEqual({ keepAwakeWhileRunning: false, keepAwakeOnBattery: false });
    expect(readKeepAwakeSettings('{"keepAwakeWhileRunning":true}')).toEqual({ keepAwakeWhileRunning: true, keepAwakeOnBattery: false });
  });
});

describe('installKeepAwake (mocked electron)', () => {
  it('wires powerSaveBlocker + powerMonitor and follows noteRunStarted/noteRunEnded', async () => {
    let settings = '{"keepAwakeWhileRunning":true}';
    await installKeepAwake(() => settings);
    const token = noteRunStarted('run-1');
    expect(electron.powerSaveBlocker.start).toHaveBeenLastCalledWith('prevent-app-suspension');
    expect(electron.started.size).toBe(1);

    electron.state.battery = true;
    electron.handlers['on-battery']();          // battery, not allowed → released
    expect(electron.started.size).toBe(0);
    electron.state.battery = false;
    electron.handlers['on-ac']();               // back on AC → held again
    expect(electron.started.size).toBe(1);

    noteRunEnded(token);                        // run finished → released
    expect(electron.started.size).toBe(0);

    settings = '{}';
    noteRunStarted('run-2');                    // setting off → never held
    expect(electron.started.size).toBe(0);
  });

  it('noteRunWaiting releases and re-acquires through the installed controller', async () => {
    await installKeepAwake(() => JSON.stringify({ keepAwakeWhileRunning: true }));
    const t = noteRunStarted('r1');
    expect(electron.started.size).toBe(1);
    noteRunWaiting(t, true);
    expect(electron.started.size).toBe(0);
    noteRunWaiting(t, false);
    expect(electron.started.size).toBe(1);
    noteRunEnded(t);
    expect(electron.started.size).toBe(0);
    noteRunWaiting(null, true);       // no token (before install / tests): no-op
  });

  it('is a no-op before installation', () => {
    expect(noteRunStarted()).toBeNull();
    expect(() => noteRunEnded(null)).not.toThrow();
  });
});
