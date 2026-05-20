/**
 * Pure output-path resolution for the docs_generate tool. Kept free of Electron
 * so it's unit-testable. Honours absolute paths, defaults bare names to
 * ~/Documents, forces the extension to match the document type, and blocks
 * writes into OS-system directories (last line of defence vs. an LLM-supplied
 * path).
 */
import * as path from 'path';

export type DocType = 'docx' | 'pptx' | 'xlsx' | 'pdf';

const BLOCKED_DIRS = ['/System', '/Library/System', '/usr', '/etc', '/bin', '/sbin', '/private/etc'];

export function resolveDocOutPath(
  filename: string,
  type: DocType,
  homeDir: string,
  blocked: string[] = BLOCKED_DIRS
): string {
  let base = path.isAbsolute(filename) ? filename : path.join(homeDir, 'Documents', filename);
  const ext = path.extname(base).toLowerCase();
  if (ext !== `.${type}`) {
    base = (ext ? base.slice(0, base.length - ext.length) : base) + `.${type}`;
  }
  const resolved = path.resolve(base);
  if (blocked.some(b => resolved === b || resolved.startsWith(b + path.sep))) {
    throw new Error(`Access denied: cannot write to system directory "${resolved}"`);
  }
  return resolved;
}
