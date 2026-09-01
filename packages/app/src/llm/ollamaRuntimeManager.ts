/**
 * Artha-managed Ollama runtime — install and update Ollama THROUGH Artha.
 *
 * Why this exists: Ollama gates new model architectures on the server version
 * (pulling Muse Glimmer on Ollama 0.32.x fails with a raw 412 "requires a newer
 * version of Ollama … download at ollama.com"). Sending users to a website to
 * upgrade a dependency by hand is exactly the kind of terminal-shaped chore
 * Artha promises to absorb. So Artha keeps its OWN copy of the Ollama engine:
 *
 *   <userData>/ollama-runtime/
 *     versions/<version>/   extracted official release (binary + libs)
 *     downloads/            in-flight archive (+ .part), deleted after install
 *     current.json          { version, binPath } → the copy `ollamaRuntime.ts`
 *                           prefers when starting the server
 *
 * Trust model — nothing here is "curl | sh":
 *   - The version to install is a curated pin (artha.space/ollama-runtime.json,
 *     with a bundled fallback), NOT "whatever is newest" — we ship a version
 *     we've actually run Artha against.
 *   - Binaries come from the official GitHub release for that exact tag over
 *     TLS, and the archive's SHA-256 MUST match that release's sha256sum.txt
 *     before a single byte is extracted. Mismatch → deleted + honest error.
 *   - Extraction uses the OS's own `tar` (bsdtar on macOS/Windows, GNU tar on
 *     Linux) into a fresh directory; nothing outside ollama-runtime/ is
 *     touched, no sudo, no Homebrew, no PATH edits, no quarantine tricks.
 *   - The user's existing Ollama install (menubar app, Homebrew, systemd) is
 *     NEVER modified or removed. Switching which server answers on :11434 is
 *     a separate, consent-gated step in ollamaRuntime.ts.
 *
 * Pure with respect to Electron: callers pass the userData dir so this module
 * is unit-testable and the bootstrap-safety invariant (no profile-dependent
 * init before the profile root is resolved) stays in main.ts's hands.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { parseVersion } from './ollamaVersion';

const execFileAsync = promisify(execFile);

/** Curated pin — which Ollama release Artha installs/updates to. Remote so a
 *  newer tested version reaches installed apps without an Artha release. */
const PIN_URL = 'https://artha.space/ollama-runtime.json';
/** Bundled fallback pin (offline / fetch failure). Keep in sync with
 *  landing/public/ollama-runtime.json when bumping. */
export const BUNDLED_PIN_VERSION = '0.33.2';
const PIN_FETCH_TIMEOUT_MS = 5_000;

const RELEASE_BASE = 'https://github.com/ollama/ollama/releases/download';

export type ArchiveKind = 'tgz' | 'zip' | 'tar.zst';
export interface RuntimeAsset {
  /** File name inside the GitHub release, e.g. 'ollama-darwin.tgz'. */
  asset: string;
  kind: ArchiveKind;
  /** Executable name after extraction. */
  binName: string;
  /** Approximate download size for the UI (bytes; from the 0.33.x releases). */
  approxBytes: number;
}

/** Which official release asset runs on this machine. Null = unsupported. */
export function assetForPlatform(platform: NodeJS.Platform, arch: string): RuntimeAsset | null {
  if (platform === 'darwin') {
    // Universal macOS standalone CLI (Apple Silicon + Intel), no .app bundle.
    return { asset: 'ollama-darwin.tgz', kind: 'tgz', binName: 'ollama', approxBytes: 151 * 1024 * 1024 };
  }
  if (platform === 'win32') {
    if (arch === 'arm64') return { asset: 'ollama-windows-arm64.zip', kind: 'zip', binName: 'ollama.exe', approxBytes: 199 * 1024 * 1024 };
    if (arch === 'x64') return { asset: 'ollama-windows-amd64.zip', kind: 'zip', binName: 'ollama.exe', approxBytes: 1392 * 1024 * 1024 };
    return null;
  }
  if (platform === 'linux') {
    if (arch === 'arm64') return { asset: 'ollama-linux-arm64.tar.zst', kind: 'tar.zst', binName: 'ollama', approxBytes: 1471 * 1024 * 1024 };
    if (arch === 'x64') return { asset: 'ollama-linux-amd64.tar.zst', kind: 'tar.zst', binName: 'ollama', approxBytes: 1356 * 1024 * 1024 };
    return null;
  }
  return null;
}

/** Release download URL for one asset of one tag. */
export function releaseAssetUrl(version: string, asset: string): string {
  return `${RELEASE_BASE}/v${version}/${asset}`;
}

/** Parse GitHub's sha256sum.txt ("<hex>  ./<file>") → Map<file, hex>. */
export function parseSha256Sums(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    const m = /^([0-9a-fA-F]{64})\s+\*?(?:\.\/)?(\S+)$/.exec(line);
    if (m) out.set(m[2], m[1].toLowerCase());
  }
  return out;
}

/** The curated pin document served from artha.space. */
export interface RuntimePin {
  version: string;
  source: 'remote' | 'bundled';
}

/** Resolve which version to install: remote pin when well-formed, bundled
 *  otherwise. Never throws; never trusts a non-semver string. */
export async function resolvePinnedVersion(fetchFn: typeof fetch = fetch): Promise<RuntimePin> {
  try {
    const res = await fetchFn(PIN_URL, { signal: AbortSignal.timeout(PIN_FETCH_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`pin fetch ${res.status}`);
    const json = (await res.json()) as { schemaVersion?: number; version?: unknown };
    if (json.schemaVersion !== 1 || typeof json.version !== 'string' || !parseVersion(json.version)) {
      throw new Error('pin schema mismatch');
    }
    // Only ever move FORWARD from the bundled pin: a stale/rolled-back remote
    // file must not downgrade users below what this build was tested with.
    const remote = json.version.replace(/^v/, '');
    const [a, b] = [parseVersion(remote)!, parseVersion(BUNDLED_PIN_VERSION)!];
    const newer = a[0] > b[0] || (a[0] === b[0] && (a[1] > b[1] || (a[1] === b[1] && a[2] >= b[2])));
    return newer ? { version: remote, source: 'remote' } : { version: BUNDLED_PIN_VERSION, source: 'bundled' };
  } catch {
    return { version: BUNDLED_PIN_VERSION, source: 'bundled' };
  }
}

// ── On-disk layout ─────────────────────────────────────────────────────────

export function runtimeRoot(userDataDir: string): string {
  return path.join(userDataDir, 'ollama-runtime');
}

export interface ManagedRuntime {
  version: string;
  binPath: string;
  dir: string;
}

interface CurrentFile { version: string; binPath: string }

/** The installed managed runtime, or null when absent/broken (binary gone). */
export function readManagedRuntime(userDataDir: string): ManagedRuntime | null {
  try {
    const p = path.join(runtimeRoot(userDataDir), 'current.json');
    const cur = JSON.parse(fs.readFileSync(p, 'utf8')) as Partial<CurrentFile>;
    if (typeof cur.version !== 'string' || typeof cur.binPath !== 'string' || !parseVersion(cur.version)) return null;
    // The pointer must stay INSIDE our root — a hand-edited current.json must
    // never make Artha execute an arbitrary path.
    const root = path.resolve(runtimeRoot(userDataDir));
    const bin = path.resolve(cur.binPath);
    if (!bin.startsWith(root + path.sep)) return null;
    if (!fs.existsSync(bin)) return null;
    return { version: cur.version, binPath: bin, dir: path.dirname(bin) };
  } catch {
    return null;
  }
}

/** Locate the extracted executable (flat on macOS/Windows, `bin/` on Linux). */
export function locateBinary(extractDir: string, binName: string): string | null {
  for (const candidate of [path.join(extractDir, binName), path.join(extractDir, 'bin', binName)]) {
    try { if (fs.statSync(candidate).isFile()) return candidate; } catch { /* next */ }
  }
  // Some archives nest a single top-level folder.
  try {
    for (const ent of fs.readdirSync(extractDir, { withFileTypes: true })) {
      if (!ent.isDirectory()) continue;
      for (const candidate of [path.join(extractDir, ent.name, binName), path.join(extractDir, ent.name, 'bin', binName)]) {
        try { if (fs.statSync(candidate).isFile()) return candidate; } catch { /* next */ }
      }
    }
  } catch { /* ignore */ }
  return null;
}

/** `tar` invocation for one archive kind — the OS tool, never a shell string. */
export function extractArgs(kind: ArchiveKind, archive: string, dest: string): string[] {
  switch (kind) {
    case 'tgz': return ['-xzf', archive, '-C', dest];
    case 'zip': return ['-xf', archive, '-C', dest];       // bsdtar reads zip natively
    case 'tar.zst': return ['--zstd', '-xf', archive, '-C', dest];
  }
}

// ── Install pipeline ───────────────────────────────────────────────────────

export type RuntimeProgressPhase =
  | 'resolving' | 'downloading' | 'verifying' | 'extracting' | 'installed' | 'error' | 'cancelled';
export interface RuntimeProgress {
  phase: RuntimeProgressPhase;
  version?: string;
  receivedBytes?: number;
  totalBytes?: number;
  percent?: number;
  error?: string;
}

export interface InstallOptions {
  userDataDir: string;
  emit?: (p: RuntimeProgress) => void;
  signal?: AbortSignal;
  fetchFn?: typeof fetch;
  platform?: NodeJS.Platform;
  arch?: string;
  /** Override the pinned version (tests / explicit rollback). */
  version?: string;
}

export type InstallResult =
  | { ok: true; runtime: ManagedRuntime; alreadyInstalled: boolean }
  | { ok: false; error: string; cancelled?: boolean };

/** Stream `url` to `dest`, hashing as we go. Returns the hex SHA-256. */
async function downloadToFile(
  url: string,
  dest: string,
  fetchFn: typeof fetch,
  signal: AbortSignal | undefined,
  onProgress: (received: number, total: number | undefined) => void,
): Promise<string> {
  const res = await fetchFn(url, { signal, redirect: 'follow' });
  if (!res.ok || !res.body) throw new Error(`download failed (${res.status})`);
  const lenHeader = res.headers.get('content-length');
  const total = lenHeader && Number(lenHeader) > 0 ? Number(lenHeader) : undefined;
  const hash = crypto.createHash('sha256');
  const out = fs.createWriteStream(dest);
  const reader = (res.body as ReadableStream<Uint8Array>).getReader();
  let received = 0;
  let lastEmit = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      hash.update(value);
      received += value.byteLength;
      if (!out.write(value)) await new Promise<void>(r => out.once('drain', () => r()));
      const now = Date.now();
      if (now - lastEmit > 250) { lastEmit = now; onProgress(received, total); }
    }
  } finally {
    await new Promise<void>((resolve, reject) => { out.end((err?: Error | null) => (err ? reject(err) : resolve())); });
  }
  onProgress(received, total);
  return hash.digest('hex');
}

/**
 * Install (or update to) the pinned Ollama release under userData. Idempotent:
 * if that exact version is already the current managed runtime, returns it
 * without downloading. Emits progress for the UI; never throws.
 */
export async function installManagedRuntime(opts: InstallOptions): Promise<InstallResult> {
  const emit = opts.emit ?? (() => {});
  const fetchFn = opts.fetchFn ?? fetch;
  const platform = opts.platform ?? process.platform;
  const arch = opts.arch ?? process.arch;
  const fail = (error: string): InstallResult => { emit({ phase: 'error', error }); return { ok: false, error }; };

  const asset = assetForPlatform(platform, arch);
  if (!asset) return fail(`Artha can't install Ollama automatically on ${platform}/${arch} yet — install it from ollama.com and Artha will use it.`);

  emit({ phase: 'resolving' });
  const version = opts.version ?? (await resolvePinnedVersion(fetchFn)).version;

  const existing = readManagedRuntime(opts.userDataDir);
  if (existing && existing.version === version) {
    emit({ phase: 'installed', version, percent: 100 });
    return { ok: true, runtime: existing, alreadyInstalled: true };
  }

  const root = runtimeRoot(opts.userDataDir);
  const downloads = path.join(root, 'downloads');
  const versionDir = path.join(root, 'versions', version);
  const tmpDir = `${versionDir}.tmp`;
  const archive = path.join(downloads, asset.asset);
  const partial = `${archive}.part`;
  const cleanupPartial = () => { try { fs.rmSync(partial, { force: true }); } catch { /* ignore */ } };

  try {
    fs.mkdirSync(downloads, { recursive: true });
    fs.rmSync(tmpDir, { recursive: true, force: true });

    // 1. Expected hash for THIS release — fetched first so a bad network never
    //    leaves us holding an unverifiable archive.
    const sumsRes = await fetchFn(releaseAssetUrl(version, 'sha256sum.txt'), { signal: opts.signal, redirect: 'follow' });
    if (!sumsRes.ok) return fail(`Couldn't fetch the checksum list for Ollama ${version} (${sumsRes.status}).`);
    const expected = parseSha256Sums(await sumsRes.text()).get(asset.asset);
    if (!expected) return fail(`Ollama ${version} publishes no checksum for ${asset.asset} — refusing to install unverified.`);

    // 2. Download with progress.
    emit({ phase: 'downloading', version, receivedBytes: 0, totalBytes: asset.approxBytes, percent: 0 });
    const actual = await downloadToFile(
      releaseAssetUrl(version, asset.asset), partial, fetchFn, opts.signal,
      (received, total) => {
        const t = total ?? asset.approxBytes;
        emit({ phase: 'downloading', version, receivedBytes: received, totalBytes: t, percent: Math.min(99, Math.round((received / t) * 100)) });
      },
    );

    // 3. Verify BEFORE extracting anything.
    emit({ phase: 'verifying', version, percent: 99 });
    if (actual !== expected) {
      cleanupPartial();
      return fail(`The downloaded Ollama ${version} didn't match its published checksum — discarded. Try again; if it repeats, something is tampering with the download.`);
    }
    fs.renameSync(partial, archive);

    // 4. Extract into a fresh temp dir, then atomically swing it into place.
    emit({ phase: 'extracting', version, percent: 99 });
    fs.mkdirSync(tmpDir, { recursive: true });
    try {
      await execFileAsync('tar', extractArgs(asset.kind, archive, tmpDir), { maxBuffer: 8 * 1024 * 1024, timeout: 10 * 60_000, windowsHide: true });
    } catch (err) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      const detail = err instanceof Error ? err.message : String(err);
      const hint = asset.kind === 'tar.zst' ? ' (Linux needs `zstd` installed for tar to unpack it.)' : '';
      return fail(`Couldn't unpack Ollama ${version}: ${detail}${hint}`);
    }
    const foundBin = locateBinary(tmpDir, asset.binName);
    if (!foundBin) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      return fail(`Unpacked Ollama ${version} but couldn't find its executable — the release layout may have changed.`);
    }
    if (platform !== 'win32') fs.chmodSync(foundBin, 0o755);
    fs.rmSync(versionDir, { recursive: true, force: true });
    fs.renameSync(tmpDir, versionDir);
    const binPath = path.join(versionDir, path.relative(tmpDir, foundBin));

    // 5. Record the pointer, drop the archive.
    const cur: CurrentFile = { version, binPath };
    fs.writeFileSync(path.join(root, 'current.json'), JSON.stringify(cur, null, 2));
    try { fs.rmSync(archive, { force: true }); } catch { /* ignore */ }
    // Keep at most one previous version around for rollback; prune older.
    pruneOldVersions(root, version);

    const runtime: ManagedRuntime = { version, binPath, dir: path.dirname(binPath) };
    emit({ phase: 'installed', version, percent: 100 });
    return { ok: true, runtime, alreadyInstalled: false };
  } catch (err) {
    cleanupPartial();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
    if (opts.signal?.aborted || (err instanceof Error && err.name === 'AbortError')) {
      emit({ phase: 'cancelled', version });
      return { ok: false, error: 'Update cancelled.', cancelled: true };
    }
    return fail(err instanceof Error ? err.message : String(err));
  }
}

/** Keep the new version plus the single newest other one; delete the rest. */
function pruneOldVersions(root: string, keep: string): void {
  try {
    const dir = path.join(root, 'versions');
    const others = fs.readdirSync(dir, { withFileTypes: true })
      .filter(d => d.isDirectory() && d.name !== keep && !d.name.endsWith('.tmp') && parseVersion(d.name))
      .map(d => d.name)
      .sort((a, b) => {
        const [pa, pb] = [parseVersion(a)!, parseVersion(b)!];
        for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pb[i] - pa[i];
        return 0;
      });
    for (const old of others.slice(1)) fs.rmSync(path.join(dir, old), { recursive: true, force: true });
  } catch { /* best-effort */ }
}
