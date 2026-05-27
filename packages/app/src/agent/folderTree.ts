/**
 * Shallow folder-tree rendering for the working-scope preamble. Giving the model
 * a folder's structure up front (Cowork-style) lets it answer "what is this?"
 * by reading the obvious files (README, package.json, …) directly, instead of
 * depending on a RAG index that may still be building or empty. Kept Electron-
 * free so it's unit-testable against a temp dir.
 */
import * as fs from 'fs';
import * as path from 'path';

export interface TreeOptions {
  /** Cap on total lines emitted (protects the context budget). Default 60. */
  maxEntries?: number;
  /** How many levels deep to recurse. Default 2. */
  maxDepth?: number;
}

/** Directories that are noise for understanding a project and would blow the
 *  entry cap. Skipped entirely (not recursed into). */
const IGNORE_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', '.next', '.cache',
  'coverage', '.venv', 'venv', '__pycache__', '.idea', '.vscode', '.turbo',
]);

/** Render a depth-limited, entry-capped tree of `rootPath`. Dirs sort before
 *  files; hidden entries and known heavy dirs are skipped. Returns '' when the
 *  folder is empty or unreadable. Marks truncation so the model knows more
 *  exists. */
export function buildShallowTree(rootPath: string, opts: TreeOptions = {}): string {
  const maxEntries = opts.maxEntries ?? 60;
  const maxDepth = opts.maxDepth ?? 2;
  const lines: string[] = [];
  let truncated = false;

  const walk = (dir: string, depth: number, prefix: string): void => {
    if (depth > maxDepth) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    const visible = entries
      .filter(e => !e.name.startsWith('.') && !IGNORE_DIRS.has(e.name))
      .sort((a, b) =>
        a.isDirectory() === b.isDirectory()
          ? a.name.localeCompare(b.name)
          : a.isDirectory() ? -1 : 1
      );
    for (const e of visible) {
      if (lines.length >= maxEntries) { truncated = true; return; }
      lines.push(`${prefix}${e.name}${e.isDirectory() ? '/' : ''}`);
      if (e.isDirectory()) walk(path.join(dir, e.name), depth + 1, prefix + '  ');
    }
  };

  walk(rootPath, 1, '  ');
  if (!lines.length) return '';
  return lines.join('\n') + (truncated ? '\n  … (more — use fs_list_directory to see the rest)' : '');
}
