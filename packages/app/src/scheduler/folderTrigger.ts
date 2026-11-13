/**
 * Folder trigger — fires a task when a NEW file appears in a watched folder.
 *
 * Design:
 *   - The folder must sit inside the user's attached folder scopes; that check
 *     happens before a watcher is ever created (`startFolderTrigger`).
 *   - Files present when watching starts are snapshotted and never fire; only
 *     names not seen before count as "new" (renames/edits of known files don't).
 *   - Bursts (a sync client dropping 40 files, an editor writing temp files) are
 *     debounced into ONE fire carrying the list of new names.
 *   - Hidden and partial-download files are ignored.
 *
 * `fs.watch` and the clock are injectable so the debounce and filtering are
 * unit-testable without touching the real filesystem.
 */
import * as fs from 'fs';
import * as path from 'path';
import { isFolderWithinScopes } from './automationPolicy';

/** Default quiet period before a burst of new files fires the task. */
export const FOLDER_DEBOUNCE_MS = 5_000;

/** Minimal watcher handle (subset of fs.FSWatcher). */
export interface WatchHandle { close(): void }

/** Injectable filesystem surface for the watcher. */
export interface FolderFs {
  watch(folder: string, listener: (event: string, filename: string | null) => void): WatchHandle;
  list(folder: string): string[];
  exists(p: string): boolean;
}

/** Real filesystem implementation. */
export const nodeFolderFs: FolderFs = {
  watch: (folder, listener) => fs.watch(folder, { persistent: false }, (e, f) => listener(e, f ? String(f) : null)),
  list: folder => { try { return fs.readdirSync(folder); } catch { return []; } },
  exists: p => fs.existsSync(p),
};

/** True for names a "new file" trigger should ignore (hidden, temp, partial). */
export function isIgnoredName(name: string): boolean {
  return name.startsWith('.') || name.startsWith('~$') ||
    /\.(crdownload|part|partial|download|tmp|swp)$/i.test(name);
}

/** Watches one folder and calls `onNewFiles` once per debounced burst. */
export class FolderWatcher {
  private handle: WatchHandle | null = null;
  private known = new Set<string>();
  private pending = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    readonly folder: string,
    private onNewFiles: (files: string[]) => void,
    private fsImpl: FolderFs = nodeFolderFs,
    private debounceMs = FOLDER_DEBOUNCE_MS,
  ) {}

  /** Snapshot current contents and begin watching. Idempotent. */
  start(): void {
    if (this.handle) return;
    this.known = new Set(this.fsImpl.list(this.folder));
    this.handle = this.fsImpl.watch(this.folder, (_event, filename) => this.onEvent(filename));
  }

  /** Handle one raw watch event; schedules (or extends) the debounce window. */
  private onEvent(filename: string | null): void {
    if (!filename) return;
    const name = path.basename(filename);
    if (isIgnoredName(name) || this.known.has(name)) return;
    if (!this.fsImpl.exists(path.join(this.folder, name))) return; // a delete/rename-away
    this.known.add(name);
    this.pending.add(name);
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), this.debounceMs);
  }

  /** Emit the accumulated burst as a single fire. */
  private flush(): void {
    this.timer = null;
    const files = [...this.pending];
    this.pending.clear();
    if (files.length) this.onNewFiles(files);
  }

  /** Stop watching and drop any pending (un-fired) burst. */
  stop(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    this.pending.clear();
    this.handle?.close();
    this.handle = null;
  }
}

/**
 * Create and start a watcher only if `folder` exists and is inside the user's
 * attached scopes. Returns the watcher, or an error string explaining why not.
 */
export function startFolderTrigger(
  folder: string,
  scopeFolders: string[],
  onNewFiles: (files: string[]) => void,
  fsImpl: FolderFs = nodeFolderFs,
  debounceMs = FOLDER_DEBOUNCE_MS,
): FolderWatcher | string {
  if (!isFolderWithinScopes(folder, scopeFolders)) {
    return `"${folder}" is not inside a folder you've attached to Artha. Attach it to a chat first.`;
  }
  if (!fsImpl.exists(folder)) return `Watched folder is missing: ${folder}`;
  const w = new FolderWatcher(folder, onNewFiles, fsImpl, debounceMs);
  w.start();
  return w;
}
