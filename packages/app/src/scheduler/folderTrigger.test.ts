/**
 * Folder trigger tests: bursts are debounced into one fire, pre-existing and
 * temp files never fire, and a folder outside the attached scopes (or missing)
 * is refused before any watcher starts.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as path from 'path';
import { FolderWatcher, startFolderTrigger, isIgnoredName, type FolderFs } from './folderTrigger';

/** Fake fs: captures the watch listener so tests can emit events. */
function fakeFs(initial: string[]) {
  const files = new Set(initial);
  let listener: ((e: string, f: string | null) => void) | null = null;
  const closed = { value: false };
  const impl: FolderFs = {
    watch: (_folder, l) => { listener = l; return { close: () => { closed.value = true; } }; },
    list: () => [...files],
    // Separator-agnostic: the watcher joins with path.join (backslashes on Windows).
    exists: p => p === '/scope/inbox' || files.has(path.basename(p)),
  };
  const add = (name: string) => { files.add(name); listener?.('rename', name); };
  return { impl, add, emit: (n: string | null) => listener?.('rename', n), closed, watched: () => listener !== null };
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe('FolderWatcher', () => {
  it('debounces a burst of new files into a single fire', () => {
    const fs = fakeFs(['old.pdf']);
    const onNew = vi.fn();
    const w = new FolderWatcher('/scope/inbox', onNew, fs.impl, 5000);
    w.start();
    fs.add('a.pdf');
    vi.advanceTimersByTime(3000);
    fs.add('b.pdf');
    fs.add('c.pdf');
    vi.advanceTimersByTime(4999);
    expect(onNew).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onNew).toHaveBeenCalledTimes(1);
    expect(onNew).toHaveBeenCalledWith(['a.pdf', 'b.pdf', 'c.pdf']);
  });

  it('ignores pre-existing, repeated, hidden, partial and deleted files', () => {
    const fs = fakeFs(['old.pdf']);
    const onNew = vi.fn();
    const w = new FolderWatcher('/scope/inbox', onNew, fs.impl, 1000);
    w.start();
    fs.emit('old.pdf');            // modified, not new
    fs.add('.DS_Store');
    fs.add('report.pdf.crdownload');
    fs.emit('gone.pdf');           // event for a file that no longer exists
    fs.emit(null);
    vi.advanceTimersByTime(2000);
    expect(onNew).not.toHaveBeenCalled();

    fs.add('new.pdf');
    fs.emit('new.pdf');            // duplicate event for the same file
    vi.advanceTimersByTime(1000);
    expect(onNew).toHaveBeenCalledWith(['new.pdf']);
  });

  it('stop() drops a pending burst and closes the watcher', () => {
    const fs = fakeFs([]);
    const onNew = vi.fn();
    const w = new FolderWatcher('/scope/inbox', onNew, fs.impl, 1000);
    w.start();
    fs.add('x.pdf');
    w.stop();
    vi.advanceTimersByTime(5000);
    expect(onNew).not.toHaveBeenCalled();
    expect(fs.closed.value).toBe(true);
  });
});

describe('startFolderTrigger (scope confinement)', () => {
  it('refuses a folder outside the attached scopes and never watches it', () => {
    const fs = fakeFs([]);
    const r = startFolderTrigger('/elsewhere/inbox', ['/scope'], vi.fn(), fs.impl);
    expect(typeof r).toBe('string');
    expect(r).toMatch(/not inside a folder you've attached/);
    expect(fs.watched()).toBe(false);
  });

  it('refuses a missing folder (hold: folder missing)', () => {
    const fs = fakeFs([]);
    const r = startFolderTrigger('/scope/missing', ['/scope'], vi.fn(), fs.impl);
    expect(r).toMatch(/missing/);
  });

  it('starts a watcher for a folder inside a scope', () => {
    const fs = fakeFs([]);
    const r = startFolderTrigger('/scope/inbox', ['/scope'], vi.fn(), fs.impl);
    expect(r).toBeInstanceOf(FolderWatcher);
    expect(fs.watched()).toBe(true);
    (r as FolderWatcher).stop();
  });
});

describe('isIgnoredName', () => {
  it('flags temp/hidden names', () => {
    expect(isIgnoredName('.hidden')).toBe(true);
    expect(isIgnoredName('~$doc.docx')).toBe(true);
    expect(isIgnoredName('file.part')).toBe(true);
    expect(isIgnoredName('invoice.pdf')).toBe(false);
  });
});
