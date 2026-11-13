/**
 * Tests that desktop tool calls run through the kill-switch queue: a stop
 * mid-typing halts between chunks and reports stopped_by_user, and queued
 * calls are rejected before they touch the keyboard/mouse.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('electron', () => ({ desktopCapturer: { getSources: vi.fn() } }));

const typed: string[] = [];
let gate: Promise<void> = Promise.resolve();
const clicks = vi.fn();
vi.mock('@nut-tree-fork/nut-js', () => ({
  keyboard: { type: async (t: string) => { await gate; typed.push(t); } },
  mouse: { setPosition: async () => {}, click: async () => { clicks(); } },
  Point: class { constructor(public x: number, public y: number) {} },
  Button: { LEFT: 0, RIGHT: 1 },
}));

import { invokeDesktopTool, resolveDesktopTargetApp } from './desktop';
import { desktopActionQueue } from '../desktop/actionQueue';

describe('desktop tools under the kill switch', () => {
  it('stops typing between chunks and rejects queued actions with stopped_by_user', async () => {
    let release!: () => void;
    gate = new Promise<void>(r => { release = r; });
    const typing = invokeDesktopTool('desktop_type', { text: 'x'.repeat(200) });
    const click = invokeDesktopTool('desktop_click', { x: 1, y: 1 });
    await new Promise(r => setTimeout(r, 10)); // let the first chunk start

    desktopActionQueue.stopAll();
    release();

    expect(await typing).toMatch(/^Error: stopped_by_user/);
    expect(await click).toMatch(/^Error: stopped_by_user/);
    expect(typed.length).toBe(1);           // only the in-flight chunk landed
    expect(clicks).not.toHaveBeenCalled();  // the queued click never ran
    gate = Promise.resolve();
  });

  it('works normally after a stop', async () => {
    expect(await invokeDesktopTool('desktop_click', { x: 2, y: 3 })).toMatch(/Clicked/);
  });

  it('desktop_open_app refuses a path instead of a name (R2 #3)', async () => {
    expect(await invokeDesktopTool('desktop_open_app', { appName: '/System/Applications/Utilities/Terminal.app' }))
      .toMatch(/not a file path\. Nothing was opened/);
  });

  it('desktop_open_app targets the app being opened', async () => {
    expect(await resolveDesktopTargetApp('desktop_open_app', { appName: ' Notes ' })).toBe('Notes');
    expect(await resolveDesktopTargetApp('desktop_open_app', {})).toBeNull();
    // Off macOS (and whenever the frontmost app can't be read) the target is
    // unknown — never the last app opened — so the gate asks or skips.
    if (process.platform !== 'darwin') {
      expect(await resolveDesktopTargetApp('desktop_click', { x: 1, y: 1 })).toBeNull();
    }
  });

  describe('pointer actions are gated on the window under the point (R2 #2)', () => {
    const asDarwin = async (fn: () => Promise<void>) => {
      const real = Object.getOwnPropertyDescriptor(process, 'platform')!;
      Object.defineProperty(process, 'platform', { value: 'darwin' });
      try { await fn(); } finally { Object.defineProperty(process, 'platform', real); }
    };

    it('asks for the owner of the window at (x, y), not the frontmost app', () => asDarwin(async () => {
      const exec = vi.fn(async (_cmd: string, args: string[]) => (args.slice(-2).join(',') === '900,300' ? 'System Settings\n' : 'Notes\n'));
      expect(await resolveDesktopTargetApp('desktop_click', { x: 900, y: 300 }, exec)).toBe('System Settings');
      expect(exec.mock.calls[0][0]).toBe('osascript');
      expect(exec.mock.calls[0][1].slice(0, 2)).toEqual(['-l', 'JavaScript']);
      expect(await resolveDesktopTargetApp('desktop_move_mouse', { x: 10, y: 10 }, exec)).toBe('Notes');
    }));

    it('is unknown (fail closed) over no app window, on a lookup error, or without coordinates', () => asDarwin(async () => {
      expect(await resolveDesktopTargetApp('desktop_click', { x: 5, y: 5 }, async () => '\n')).toBeNull();
      expect(await resolveDesktopTargetApp('desktop_click', { x: 5, y: 5 }, async () => { throw new Error('denied'); })).toBeNull();
      const exec = vi.fn(async () => 'Notes');
      expect(await resolveDesktopTargetApp('desktop_click', {}, exec)).toBeNull();
      expect(exec).not.toHaveBeenCalled();
    }));
  });
});
