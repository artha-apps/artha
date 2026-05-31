/**
 * Pure output-path resolution for the docs_generate tool. Kept free of Electron
 * so it's unit-testable. Honours absolute paths, defaults bare names to
 * `defaultDir` (the chat's scoped folder) when given else ~/Documents, forces
 * the extension to match the document type, and blocks writes into OS-system
 * directories (last line of defence vs. an LLM-supplied path).
 */
import * as path from 'path';

/** Document formats supported by the `docs_generate` tool. */
export type DocType = 'docx' | 'pptx' | 'xlsx' | 'pdf';

/** OS directories that must never receive agent-generated files. Mirrors the
 *  list used in filesystem.ts so both guards stay in sync. */
const BLOCKED_DIRS = ['/System', '/Library/System', '/usr', '/etc', '/bin', '/sbin', '/private/etc'];

/**
 * Resolve the absolute output path for a generated document.
 *
 * Rules applied in order:
 *   1. Absolute `filename` is used as-is.
 *   2. Bare name + `defaultDir` (absolute) → `defaultDir/<filename>`.
 *   3. Bare name + no valid `defaultDir` → `homeDir/Documents/<filename>`.
 *   4. Extension is replaced if it doesn't match `type`.
 *   5. Any path inside a system directory throws.
 *
 * @param filename   Agent-supplied filename, e.g. "report.docx" or "/tmp/x.pdf".
 * @param type       Desired document format — used to enforce the extension.
 * @param homeDir    User home directory (injected so the function stays testable).
 * @param defaultDir Absolute path to the chat's scoped folder; ignored when
 *                   relative or absent.
 * @param blocked    Override the blocked-directory list (used in tests).
 */
export function resolveDocOutPath(
  filename: string,
  type: DocType,
  homeDir: string,
  defaultDir?: string,
  blocked: string[] = BLOCKED_DIRS
): string {
  const baseDir = defaultDir && path.isAbsolute(defaultDir) ? defaultDir : path.join(homeDir, 'Documents');
  let base = path.isAbsolute(filename) ? filename : path.join(baseDir, filename);
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
