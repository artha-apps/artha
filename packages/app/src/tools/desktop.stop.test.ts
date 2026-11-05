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

  it('desktop_open_app targets the app being opened', async () => {
    expect(await resolveDesktopTargetApp('desktop_open_app', { appName: ' Notes ' })).toBe('Notes');
    expect(await resolveDesktopTargetApp('desktop_open_app', {})).toBeNull();
    // Off macOS (and whenever the frontmost app can't be read) the target is
    // unknown — never the last app opened — so the gate asks or skips.
    if (process.platform !== 'darwin') {
      expect(await resolveDesktopTargetApp('desktop_click', { x: 1, y: 1 })).toBeNull();
    }
  });
});
