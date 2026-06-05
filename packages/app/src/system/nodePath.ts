/**
 * Augmented PATH for spawning user-installed CLIs (npx/node) from a packaged app.
 *
 * On macOS a GUI app launched from Finder/Dock inherits a minimal PATH
 * (`/usr/bin:/bin:/usr/sbin:/sbin`) — it does NOT include Homebrew, nvm, Volta,
 * fnm, or asdf. So an MCP connector spawned with `npx` fails with ENOENT even
 * though the user has Node installed. This computes a best-effort PATH that adds
 * the common Node install locations, used for BOTH the MCP server spawn and the
 * `system:checkRuntime` probe so detection matches what can actually launch.
 */
import os from 'os';
import path from 'path';
import fs from 'fs';

let cached: string | null = null;

function dir(...p: string[]): string {
  return path.join(...p);
}

/** Bin directories for every version under a version-manager root (newest first). */
function versionBins(root: string, suffix = 'bin'): string[] {
  try {
    return fs.readdirSync(root).sort().reverse().map(v => dir(root, v, suffix));
  } catch {
    return [];
  }
}

/**
 * PATH = the inherited PATH, plus common Node locations that exist on disk.
 * Inherited entries are kept verbatim and first (so an already-resolvable npx is
 * used as-is); added candidates are de-duped and existence-checked. Cached for
 * the process — PATH doesn't change at runtime.
 */
export function augmentedPath(): string {
  if (cached) return cached;
  const home = os.homedir();

  const candidates: string[] = [
    '/opt/homebrew/bin',  // Apple-silicon Homebrew
    '/usr/local/bin',     // Intel Homebrew / common installs
    '/opt/local/bin',     // MacPorts
    dir(home, '.volta', 'bin'),
    dir(home, '.asdf', 'shims'),
    dir(home, '.local', 'bin'),
    dir(home, 'bin'),
    ...versionBins(dir(home, '.nvm', 'versions', 'node')),
    ...versionBins(dir(home, 'Library', 'Application Support', 'fnm', 'node-versions'), 'installation/bin'),
    ...versionBins(dir(home, '.local', 'share', 'fnm', 'node-versions'), 'installation/bin'),
  ];

  const seen = new Set<string>();
  const ordered: string[] = [];
  // Inherited entries first, verbatim, de-duped (some shells export dupes).
  for (const d of (process.env.PATH ?? '').split(path.delimiter)) {
    if (d && !seen.has(d)) { seen.add(d); ordered.push(d); }
  }
  // Then any common Node location that exists on disk and isn't already present.
  for (const d of candidates) {
    if (!d || seen.has(d)) continue;
    let exists = false;
    try { exists = fs.existsSync(d); } catch { exists = false; }
    if (exists) { seen.add(d); ordered.push(d); }
  }

  cached = ordered.join(path.delimiter);
  return cached;
}

/** Process env with the augmented PATH — the env to spawn MCP servers with. */
export function spawnEnv(extra?: Record<string, string>): Record<string, string> {
  const base: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (typeof v === 'string') base[k] = v;
  return { ...base, ...extra, PATH: augmentedPath() };
}
