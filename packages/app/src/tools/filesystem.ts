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

const HOME = os.homedir();

// ── Path safety ─────────────────────────────────────────────────────────────

function safePath(p: string): string {
  const resolved = path.resolve(p);
  const blocked = ['/System', '/Library/System', '/usr', '/etc', '/bin', '/sbin', '/private/etc'];
  if (blocked.some(b => resolved.startsWith(b))) {
    throw new Error(`Access denied: cannot access system directory "${resolved}"`);
  }
  return resolved;
}

// ── Tool schemas (OpenAI function format) ────────────────────────────────────

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
      description: 'Move or rename a file or folder. Use this to organise files into folders.',
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

function expandTilde(p: string): string {
  if (p.startsWith('~/') || p === '~') {
    return path.join(HOME, p.slice(1));
  }
  return p;
}

/** Match a filename against a glob-style pattern (*, ?) */
function matchPattern(filename: string, pattern: string): boolean {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`, 'i').test(filename);
}

async function listDirectoryImpl(dirPath: string): Promise<string> {
  const resolved = safePath(expandTilde(dirPath));
  const entries = await fsp.readdir(resolved, { withFileTypes: true });
  const result = entries.map(e => ({
    name: e.name,
    type: e.isDirectory() ? 'folder' : 'file',
    path: path.join(resolved, e.name),
  }));
  return JSON.stringify({ directory: resolved, count: result.length, entries: result }, null, 2);
}

async function searchFilesImpl(directory: string, pattern: string, recursive = false): Promise<string> {
  const resolved = safePath(expandTilde(directory));
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

async function createDirectoryImpl(dirPath: string): Promise<string> {
  const resolved = safePath(expandTilde(dirPath));
  await fsp.mkdir(resolved, { recursive: true });
  return JSON.stringify({ created: resolved, success: true });
}

async function moveFileImpl(source: string, destination: string): Promise<string> {
  const src = safePath(expandTilde(source));
  const dst = safePath(expandTilde(destination));

  // Ensure destination directory exists
  await fsp.mkdir(path.dirname(dst), { recursive: true });
  await fsp.rename(src, dst);
  return JSON.stringify({ moved: src, to: dst, success: true });
}

async function copyFileImpl(source: string, destination: string): Promise<string> {
  const src = safePath(expandTilde(source));
  const dst = safePath(expandTilde(destination));
  await fsp.mkdir(path.dirname(dst), { recursive: true });
  await fsp.copyFile(src, dst);
  return JSON.stringify({ copied: src, to: dst, success: true });
}

async function readFileImpl(filePath: string): Promise<string> {
  const resolved = safePath(expandTilde(filePath));
  const stat = await fsp.stat(resolved);
  if (stat.size > 100 * 1024) {
    return JSON.stringify({ error: 'File too large (>100KB). Use fs_get_file_info instead.' });
  }
  const content = await fsp.readFile(resolved, 'utf-8');
  return JSON.stringify({ path: resolved, content });
}

async function getFileInfoImpl(filePath: string): Promise<string> {
  const resolved = safePath(expandTilde(filePath));
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

async function deleteFileImpl(filePath: string, permanent = false): Promise<string> {
  const resolved = safePath(expandTilde(filePath));
  if (permanent) {
    const stat = await fsp.stat(resolved);
    if (stat.isDirectory()) {
      await fsp.rm(resolved, { recursive: true });
    } else {
      await fsp.unlink(resolved);
    }
    return JSON.stringify({ deleted: resolved, permanent: true });
  }
  // Move to Trash on macOS
  const trashDir = path.join(HOME, '.Trash');
  const trashPath = path.join(trashDir, path.basename(resolved));
  await fsp.rename(resolved, trashPath);
  return JSON.stringify({ trashed: resolved, location: trashPath });
}

// ── Main dispatch ────────────────────────────────────────────────────────────

export async function invokeFilesystemTool(
  name: string,
  args: Record<string, unknown>
): Promise<string> {
  switch (name) {
    case 'fs_list_directory':
      return listDirectoryImpl(args.path as string);
    case 'fs_search_files':
      return searchFilesImpl(args.directory as string, args.pattern as string, args.recursive as boolean);
    case 'fs_create_directory':
      return createDirectoryImpl(args.path as string);
    case 'fs_move_file':
      return moveFileImpl(args.source as string, args.destination as string);
    case 'fs_copy_file':
      return copyFileImpl(args.source as string, args.destination as string);
    case 'fs_read_file':
      return readFileImpl(args.path as string);
    case 'fs_get_file_info':
      return getFileInfoImpl(args.path as string);
    case 'fs_delete_file':
      return deleteFileImpl(args.path as string, args.permanent as boolean);
    default:
      throw new Error(`Unknown filesystem tool: ${name}`);
  }
}

export function isFilesystemTool(name: string): boolean {
  return name.startsWith('fs_');
}
