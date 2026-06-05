/**
 * Built-in Filesystem Tools — gives Artha real ability to read, move,
 * search, and organise files on the user's machine.
 *
 * Security: all paths are validated to stay within the user's home directory.
 * System directories (/System, /Library, /usr, /etc etc.) are blocked.
 */
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import OpenAI from 'openai';
import type { ScopeRoot } from '../db/scopes';
import { recordFilesystemEffect } from '../agent/undo';

const HOME = os.homedir();

// ── Path safety ─────────────────────────────────────────────────────────────

/** True when `child` is `parent` itself or lives anywhere beneath it. Uses
 *  path.relative so it's not fooled by `/foo` vs `/foobar` prefix overlap. */
function isWithin(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** Canonicalise `resolved` by following symlinks. The target may not exist yet
 *  (writes/creates), so we realpath the deepest EXISTING ancestor and re-append
 *  the non-existent tail. Without this a symlink inside an allowed folder could
 *  point at a system file and slip past the prefix/scope checks below. */
function realResolve(resolved: string): string {
  let existing = resolved;
  const tail: string[] = [];
  while (!fs.existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) break; // reached filesystem root
    tail.unshift(path.basename(existing));
    existing = parent;
  }
  let real: string;
  try { real = fs.realpathSync(existing); } catch { real = existing; }
  return tail.length ? path.join(real, ...tail) : real;
}

/** Resolve a user-supplied path and reject (1) anything under a known OS-system
 *  directory and (2) — when the chat has attached scopes — anything outside
 *  them. The agent runs with the user's full uid, so this is the last line of
 *  defence between an LLM hallucination and `rm /etc`, and the mechanism that
 *  confines a scoped chat to its selected folders/files.
 *
 *  `allowedRoots` empty/undefined ⇒ no per-chat scope; fall back to the
 *  historical home-directory-wide behaviour (system dirs still blocked). */
function safePath(p: string, allowedRoots?: ScopeRoot[] | null): string {
  if (!p || typeof p !== 'string') {
    throw new Error(`Invalid path argument: received ${JSON.stringify(p)}`);
  }
  const resolved = path.resolve(p);
  // Validate the symlink-resolved path too, so a symlink can't escape the
  // sandbox or reach a system dir through an allowed folder.
  const real = realResolve(resolved);
  const blocked = ['/System', '/Library/System', '/usr', '/etc', '/bin', '/sbin', '/private/etc'];
  if (blocked.some(b => resolved.startsWith(b) || real.startsWith(b))) {
    throw new Error(`Access denied: cannot access system directory "${resolved}"`);
  }
  if (allowedRoots && allowedRoots.length) {
    const ok = allowedRoots.some(r => {
      const root = path.resolve(r.path);
      const realRoot = realResolve(root);
      // A file scope grants access to that exact file only; a folder scope
      // grants its whole subtree. Both the literal and symlink-resolved paths
      // must satisfy the scope.
      return r.kind === 'file'
        ? resolved === root && real === realRoot
        : isWithin(resolved, root) && isWithin(real, realRoot);
    });
    if (!ok) {
      const roots = allowedRoots.map(r => r.path).join(', ');
      throw new Error(
        `Access denied: "${resolved}" is outside this chat's selected folders (${roots}). ` +
        `Attach the folder to this chat to allow it.`
      );
    }
  }
  return resolved;
}

// ── Tool schemas (OpenAI function format) ────────────────────────────────────
// One entry per built-in filesystem tool. Descriptions are tuned for *the
// model*, not human readers — they include hints like "always call this first"
// that shape ReAct planning. Keep them concrete; bare wording like "list files"
// is enough to make small models hallucinate args.

export const FILESYSTEM_TOOL_SCHEMAS: OpenAI.ChatCompletionTool[] = [
  {
    type: 'function',
    function: {
      name: 'fs_list_directory',
      description: 'List all files and folders in a directory. Always call this first before moving or organising files so you know what exists.',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Absolute path to the directory, e.g. /Users/username/Desktop or ~/Desktop',
          },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'fs_search_files',
      description: 'Search for files in a directory matching a pattern. Use patterns like "*.png", "Screenshot*", "*.pdf". Returns matching file paths.',
      parameters: {
        type: 'object',
        properties: {
          directory: {
            type: 'string',
            description: 'Directory to search in (absolute path or ~/...)',
          },
          pattern: {
            type: 'string',
            description: 'Glob-style pattern, e.g. "*.png", "Screenshot*", "*.pdf", "*2024*"',
          },
          recursive: {
            type: 'boolean',
            description: 'Whether to search subdirectories too. Default false.',
          },
        },
        required: ['directory', 'pattern'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'fs_create_directory',
      description: 'Create a new folder (including all parent folders if needed).',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Absolute path of the directory to create',
          },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'fs_move_file',
      description: 'Move or rename a SINGLE file or folder. To move many files at once (e.g. organising a folder), use fs_move_batch instead — it is far faster.',
      parameters: {
        type: 'object',
        properties: {
          source: {
            type: 'string',
            description: 'Absolute path of the file/folder to move',
          },
          destination: {
            type: 'string',
            description: 'Absolute destination path (include filename at the end)',
          },
        },
        required: ['source', 'destination'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'fs_move_batch',
      description: 'Move MANY files/folders in ONE call. ALWAYS prefer this over repeated fs_move_file when organising or reorganising a folder — it does every move in a single step instead of one slow round-trip per file. Destination directories are created automatically.',
      parameters: {
        type: 'object',
        properties: {
          moves: {
            type: 'array',
            description: 'List of { source, destination } pairs, each an absolute path. Include the filename at the end of each destination.',
            items: {
              type: 'object',
              properties: {
                source: { type: 'string', description: 'Absolute path of the file/folder to move' },
                destination: { type: 'string', description: 'Absolute destination path (include filename at the end)' },
              },
              required: ['source', 'destination'],
            },
          },
        },
        required: ['moves'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'fs_copy_file',
      description: 'Copy a file from one location to another.',
      parameters: {
        type: 'object',
        properties: {
          source: {
            type: 'string',
            description: 'Absolute path of the file to copy',
          },
          destination: {
            type: 'string',
            description: 'Absolute destination path',
          },
        },
        required: ['source', 'destination'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'fs_read_file',
      description: 'Read the text content of a file. Only works on text files (not images or binaries). Limit: 100KB.',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Absolute path to the file',
          },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'fs_get_file_info',
      description: 'Get metadata about a file or directory: size, type, creation date, last modified date.',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Absolute path to the file or directory',
          },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'fs_delete_file',
      description: 'Move a file to Trash (macOS) or delete it permanently. Use with caution — only when explicitly requested.',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Absolute path of the file to delete',
          },
          permanent: {
            type: 'boolean',
            description: 'If true, permanently delete. If false (default), move to Trash.',
          },
        },
        required: ['path'],
      },
    },
  },
];

// ── Tool implementations ─────────────────────────────────────────────────────

/** Resolve a leading `~` to the user's home dir. Models hand us either form
 *  interchangeably, so we normalise before the `safePath` guard runs. */
function expandTilde(p: string): string {
  if (p.startsWith('~/') || p === '~') {
    return path.join(HOME, p.slice(1));
  }
  return p;
}

/** Match a filename against a glob-style pattern (*, ?). We compile to a
 *  RegExp rather than pulling in minimatch — the patterns are user-typed
 *  filenames, not full shell globs, so this is sufficient and dependency-free. */
function matchPattern(filename: string, pattern: string): boolean {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`, 'i').test(filename);
}

async function listDirectoryImpl(dirPath: string, roots?: ScopeRoot[] | null): Promise<string> {
  const resolved = safePath(expandTilde(dirPath), roots);
  const entries = await fsp.readdir(resolved, { withFileTypes: true });
  const result = entries.map(e => ({
    name: e.name,
    type: e.isDirectory() ? 'folder' : 'file',
    path: path.join(resolved, e.name),
  }));
  return JSON.stringify({ directory: resolved, count: result.length, entries: result }, null, 2);
}

async function searchFilesImpl(directory: string, pattern: string, recursive = false, roots?: ScopeRoot[] | null): Promise<string> {
  const resolved = safePath(expandTilde(directory), roots);
  const matches: string[] = [];

  async function walk(dir: string) {
    let entries: fs.Dirent[];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (recursive) await walk(fullPath);
      } else {
        if (matchPattern(entry.name, pattern)) {
          matches.push(fullPath);
        }
      }
    }
  }

  await walk(resolved);
  return JSON.stringify({ pattern, directory: resolved, count: matches.length, files: matches }, null, 2);
}

async function createDirectoryImpl(dirPath: string, roots?: ScopeRoot[] | null): Promise<string> {
  const resolved = safePath(expandTilde(dirPath), roots);
  await fsp.mkdir(resolved, { recursive: true });
  return JSON.stringify({ created: resolved, success: true });
}

async function moveFileImpl(source: string, destination: string, roots?: ScopeRoot[] | null): Promise<string> {
  const src = safePath(expandTilde(source), roots);
  const dst = safePath(expandTilde(destination), roots);

  // Auto-create the destination directory so the LLM doesn't have to chain a
  // separate mkdir call; matches the spirit of `mv` in interactive use.
  await fsp.mkdir(path.dirname(dst), { recursive: true });
  await fsp.rename(src, dst);
  return JSON.stringify({ moved: src, to: dst, success: true });
}

/** Move many files in one shot. Each move is independent: a failure on one
 *  (bad path, missing source) is recorded and the rest still proceed, so a
 *  single typo doesn't abort an entire folder reorganisation. */
async function moveBatchImpl(
  moves: Array<{ source?: string; src?: string; destination?: string; dst?: string; dest?: string }>,
  roots?: ScopeRoot[] | null,
): Promise<string> {
  if (!Array.isArray(moves) || moves.length === 0) {
    return JSON.stringify({ error: 'fs_move_batch requires a non-empty "moves" array of { source, destination } pairs.' });
  }
  const results: Array<{ source: string; to?: string; ok: boolean; error?: string }> = [];
  let moved = 0;
  for (const m of moves) {
    const source = (m.source ?? m.src) as string;
    const destination = (m.destination ?? m.dst ?? m.dest) as string;
    try {
      const src = safePath(expandTilde(source), roots);
      const dst = safePath(expandTilde(destination), roots);
      await fsp.mkdir(path.dirname(dst), { recursive: true });
      await fsp.rename(src, dst);
      results.push({ source: src, to: dst, ok: true });
      moved++;
    } catch (err) {
      results.push({ source: String(source), ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return JSON.stringify({ success: moved > 0, moved, failed: moves.length - moved, results });
}

async function copyFileImpl(source: string, destination: string, roots?: ScopeRoot[] | null): Promise<string> {
  const src = safePath(expandTilde(source), roots);
  const dst = safePath(expandTilde(destination), roots);
  await fsp.mkdir(path.dirname(dst), { recursive: true });
  await fsp.copyFile(src, dst);
  return JSON.stringify({ copied: src, to: dst, success: true });
}

async function readFileImpl(filePath: string, roots?: ScopeRoot[] | null): Promise<string> {
  const resolved = safePath(expandTilde(filePath), roots);
  const stat = await fsp.stat(resolved);
  if (stat.size > 100 * 1024) {
    return JSON.stringify({ error: 'File too large (>100KB). Use fs_get_file_info instead.' });
  }
  const content = await fsp.readFile(resolved, 'utf-8');
  return JSON.stringify({ path: resolved, content });
}

async function getFileInfoImpl(filePath: string, roots?: ScopeRoot[] | null): Promise<string> {
  const resolved = safePath(expandTilde(filePath), roots);
  const stat = await fsp.stat(resolved);
  return JSON.stringify({
    path: resolved,
    name: path.basename(resolved),
    type: stat.isDirectory() ? 'directory' : 'file',
    size: stat.size,
    sizeHuman: stat.size > 1024 * 1024
      ? `${(stat.size / 1024 / 1024).toFixed(1)} MB`
      : `${(stat.size / 1024).toFixed(1)} KB`,
    created: stat.birthtime.toISOString(),
    modified: stat.mtime.toISOString(),
  });
}

async function deleteFileImpl(filePath: string, permanent = false, roots?: ScopeRoot[] | null): Promise<string> {
  const resolved = safePath(expandTilde(filePath), roots);
  if (permanent) {
    const stat = await fsp.stat(resolved);
    if (stat.isDirectory()) {
      await fsp.rm(resolved, { recursive: true });
    } else {
      await fsp.unlink(resolved);
    }
    return JSON.stringify({ deleted: resolved, permanent: true });
  }
  // Default path: move to ~/.Trash so the user can recover from a wrong move.
  // Note: this is a plain rename, not an osascript "Move to Bin" — clashing
  // basenames will overwrite rather than auto-rename. Acceptable trade-off
  // for a Phase-1 agent; permanent=true is gated behind explicit user intent.
  const trashDir = path.join(HOME, '.Trash');
  const trashPath = path.join(trashDir, path.basename(resolved));
  await fsp.rename(resolved, trashPath);
  return JSON.stringify({ trashed: resolved, location: trashPath });
}

// ── Main dispatch ────────────────────────────────────────────────────────────

/** Central dispatcher used by MCPRegistry. Argument aliasing
 *  (`source`/`src`, `destination`/`dst`/`dest`) accommodates the way
 *  smaller / quantised models often shorten field names — preventing a
 *  retry loop where the agent re-issues the call with a different alias. */
export async function invokeFilesystemTool(
  name: string,
  args: Record<string, unknown>,
  allowedRoots?: ScopeRoot[] | null
): Promise<string> {
  const result = await dispatchFilesystemTool(name, args, allowedRoots);
  // Record reversible mutations so the user can Undo them. Wrapped so undo
  // bookkeeping can never break a tool call.
  try { recordFilesystemEffect(name, result); } catch { /* non-fatal */ }
  return result;
}

async function dispatchFilesystemTool(
  name: string,
  args: Record<string, unknown>,
  allowedRoots?: ScopeRoot[] | null
): Promise<string> {
  switch (name) {
    case 'fs_list_directory':
      return listDirectoryImpl(args.path as string, allowedRoots);
    case 'fs_search_files':
      return searchFilesImpl(args.directory as string, args.pattern as string, args.recursive as boolean, allowedRoots);
    case 'fs_create_directory':
      return createDirectoryImpl(args.path as string, allowedRoots);
    case 'fs_move_file':
      return moveFileImpl(
        (args.source ?? args.src) as string,
        (args.destination ?? args.dst ?? args.dest) as string,
        allowedRoots
      );
    case 'fs_move_batch':
      return moveBatchImpl(
        (args.moves ?? []) as Array<{ source?: string; destination?: string }>,
        allowedRoots
      );
    case 'fs_copy_file':
      return copyFileImpl(
        (args.source ?? args.src) as string,
        (args.destination ?? args.dst ?? args.dest) as string,
        allowedRoots
      );
    case 'fs_read_file':
      return readFileImpl(args.path as string, allowedRoots);
    case 'fs_get_file_info':
      return getFileInfoImpl(args.path as string, allowedRoots);
    case 'fs_delete_file':
      return deleteFileImpl(args.path as string, args.permanent as boolean, allowedRoots);
    default:
      throw new Error(`Unknown filesystem tool: ${name}`);
  }
}

export function isFilesystemTool(name: string): boolean {
  return name.startsWith('fs_');
}
