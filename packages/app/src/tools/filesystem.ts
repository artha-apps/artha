/**
 * Built-in Filesystem Tools — gives Artha real ability to read, move,
 * search, and organise files on the user's machine.
 *
 * Security: all paths are validated to stay within the user's home directory.
 * System directories are blocked on BOTH platforms — POSIX (/System, /usr,
 * /etc, …) and Windows (C:\Windows, C:\Program Files, C:\ProgramData, UNC
 * shares, …). See `isSystemPath`.
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
/** POSIX OS-system roots the agent may never touch. Segment-aware matching
 *  below means `/etc` blocks `/etc` and `/etc/x` but NOT `/etched`. */
const POSIX_SYSTEM_DIRS = ['/System', '/Library/System', '/usr', '/etc', '/bin', '/sbin', '/private/etc'];

/**
 * True when `resolved` is inside a protected OS-system location. Pure and
 * platform-parameterized so BOTH the POSIX and Windows blocklists are testable
 * on any host (pass `platform` explicitly in tests).
 *
 * Closes the Windows gap (#43): the old POSIX-only list matched none of
 * `C:\Windows\System32`, `C:\Program Files`, … so on Windows the system-path
 * guard was effectively absent — the agent could move/delete OS files.
 */
export function isSystemPath(resolved: string, platform: NodeJS.Platform = process.platform): boolean {
  if (platform === 'win32') {
    // Windows FS is case-insensitive and accepts both separators.
    const n = resolved.replace(/\//g, '\\').toLowerCase();
    if (n.startsWith('\\\\')) return true; // UNC share — never a user-data path
    return [
      /^[a-z]:\\windows(\\|$)/,
      /^[a-z]:\\program files( \(x86\))?(\\|$)/,
      /^[a-z]:\\programdata(\\|$)/,
      /^[a-z]:\\system volume information(\\|$)/,
      /^[a-z]:\\\$recycle\.bin(\\|$)/,
      /^[a-z]:\\recovery(\\|$)/,
    ].some(re => re.test(n));
  }
  return POSIX_SYSTEM_DIRS.some(b => resolved === b || resolved.startsWith(b + '/'));
}

function safePath(p: string, allowedRoots?: ScopeRoot[] | null): string {
  if (!p || typeof p !== 'string') {
    throw new Error(`Invalid path argument: received ${JSON.stringify(p)}`);
  }
  const resolved = path.resolve(p);
  // Validate the symlink-resolved path too, so a symlink can't escape the
  // sandbox or reach a system dir through an allowed folder.
  const real = realResolve(resolved);
  if (isSystemPath(resolved) || isSystemPath(real)) {
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

/** Max entries a single listing/search returns to the model. A real Downloads
 *  folder (500+ files) rendered as pretty JSON with a full path per entry was
 *  ~95k chars ≈ 30k tokens — it overflowed a 32k local context and cost a 72B
 *  model 5+ minutes of prompt evaluation before Node's fetch gave up. Listings
 *  are for orientation; anything bigger should be narrowed with fs_search_files. */
export const MAX_LISTING_ENTRIES = 150;

async function listDirectoryImpl(dirPath: string, roots?: ScopeRoot[] | null): Promise<string> {
  const resolved = safePath(expandTilde(dirPath), roots);
  const entries = await fsp.readdir(resolved, { withFileTypes: true });
  // Compact shape: the directory once, then bare names (folders marked with a
  // trailing "/") — the model joins directory + name itself. Folders first,
  // then files, case-insensitive, so a capped listing is still predictable.
  const sorted = [...entries].sort((a, b) => {
    const da = a.isDirectory() ? 0 : 1, dbb = b.isDirectory() ? 0 : 1;
    return da - dbb || a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
  });
  const shown = sorted.slice(0, MAX_LISTING_ENTRIES).map(e => e.isDirectory() ? `${e.name}/` : e.name);
  const omitted = sorted.length - shown.length;
  return JSON.stringify({
    directory: resolved,
    count: sorted.length,
    entries: shown,
    ...(omitted > 0 ? {
      truncated: omitted,
      hint: `${omitted} more entries not shown. Use fs_search_files with a pattern (e.g. "*.xlsx", "Trinity*") to find specific files.`,
    } : {}),
  });
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
  const shown = matches.slice(0, MAX_LISTING_ENTRIES);
  const omitted = matches.length - shown.length;
  return JSON.stringify({
    pattern, directory: resolved, count: matches.length, files: shown,
    ...(omitted > 0 ? { truncated: omitted, hint: `${omitted} more matches not shown — use a narrower pattern.` } : {}),
  });
}

async function createDirectoryImpl(dirPath: string, roots?: ScopeRoot[] | null): Promise<string> {
  const resolved = safePath(expandTilde(dirPath), roots);
  await fsp.mkdir(resolved, { recursive: true });
  return JSON.stringify({ created: resolved, success: true });
}

// ── Model-independent path repair ────────────────────────────────────────────
// Small local models (and the planner that feeds them) routinely (a) drop the
// file extension the user never spoke aloud ("Trinity customer DB" for
// "…DB.xlsx"), (b) name a destination folder without the filename, and (c)
// invent a parent chain ("in noopurtrivedi" → ~/noopurtrivedi/Project). The
// old code then mkdir'd the invented chain and failed the rename, leaving junk
// folders on disk and an ENOENT the model rarely recovers from. These helpers
// make the obvious repairs deterministically and refuse the dangerous one.

/** If `src` does not exist, look in its parent for exactly one entry that is
 *  the same name or that name plus an extension (case-insensitive). */
export async function resolveExistingSource(src: string): Promise<{ path: string; repaired: boolean }> {
  try { await fsp.access(src); return { path: src, repaired: false }; } catch { /* try repair */ }
  const dir = path.dirname(src);
  const base = path.basename(src).toLowerCase();
  let names: string[] = [];
  try { names = await fsp.readdir(dir); } catch { return { path: src, repaired: false }; }
  const hits = names.filter(n => { const l = n.toLowerCase(); return l === base || l.startsWith(`${base}.`); });
  if (hits.length === 1) return { path: path.join(dir, hits[0]), repaired: true };
  if (hits.length > 1) {
    throw new Error(`Ambiguous source "${path.basename(src)}" in ${dir}: matches ${hits.map(h => `"${h}"`).join(', ')}. Use the exact filename.`);
  }
  // Nothing close — surface near misses so the model can correct once.
  const word = base.split(/[\s._-]+/)[0];
  const near = word.length >= 3 ? names.filter(n => n.toLowerCase().includes(word)).slice(0, 5) : [];
  throw new Error(`Source not found: ${src}${near.length ? `. Similar names in ${dir}: ${near.map(n => `"${n}"`).join(', ')}` : ''}`);
}

/** Folders a bare project/folder name is likely to live in, in probe order. */
function likelyParents(): string[] {
  const home = os.homedir();
  return [home, path.join(home, 'Desktop'), path.join(home, 'Documents'), path.join(home, 'Downloads'), path.join(home, 'Projects')];
}

/** Resolve the destination for a move/copy of `src`:
 *  - an existing directory → move INTO it (append the source filename);
 *  - a path whose parent exists → use as-is (one new leaf folder is created);
 *  - a path whose parent does NOT exist → refuse (never mkdir an invented chain),
 *    suggesting a same-named folder that does exist under the usual roots. */
export async function resolveDestination(src: string, dst: string): Promise<string> {
  try {
    const st = await fsp.stat(dst);
    if (st.isDirectory()) return path.join(dst, path.basename(src));
    return dst;
  } catch { /* dst does not exist yet */ }
  const parent = path.dirname(dst);
  try { await fsp.access(parent); return dst; } catch { /* parent missing */ }
  // One new leaf folder under an EXISTING grandparent is a legitimate "put it
  // in a new subfolder" — allowed. Anything deeper is an invented chain.
  try { await fsp.access(path.dirname(parent)); return dst; } catch { /* chain missing */ }
  // Parent chain is missing. Is the intended folder actually somewhere obvious?
  const wanted = [path.basename(parent), path.basename(dst)];
  const found: string[] = [];
  for (const root of likelyParents()) {
    for (const w of wanted) {
      const candidate = path.join(root, w);
      try { if ((await fsp.stat(candidate)).isDirectory() && !found.includes(candidate)) found.push(candidate); } catch { /* no */ }
    }
  }
  throw new Error(
    `Destination folder does not exist: ${parent}. Artha does not create missing parent folders from a guessed path.` +
    (found.length
      ? ` A folder with that name exists at ${found.map(f => `"${f}"`).join(' or ')} — use that path (include the filename).`
      : ` Check the path, or create the folder first with fs_create_directory.`),
  );
}

async function moveFileImpl(source: string, destination: string, roots?: ScopeRoot[] | null): Promise<string> {
  const srcRaw = safePath(expandTilde(source), roots);
  const { path: src, repaired } = await resolveExistingSource(srcRaw);
  const dst = safePath(await resolveDestination(src, safePath(expandTilde(destination), roots)), roots);
  await fsp.mkdir(path.dirname(dst), { recursive: true }); // parent verified to exist; creates at most one leaf
  await fsp.rename(src, dst);
  return JSON.stringify({ moved: src, to: dst, success: true, ...(repaired ? { note: `source resolved from "${path.basename(srcRaw)}"` } : {}) });
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
      const { path: src } = await resolveExistingSource(safePath(expandTilde(source), roots));
      const dst = safePath(await resolveDestination(src, safePath(expandTilde(destination), roots)), roots);
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
  const { path: src } = await resolveExistingSource(safePath(expandTilde(source), roots));
  const dst = safePath(await resolveDestination(src, safePath(expandTilde(destination), roots)), roots);
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
