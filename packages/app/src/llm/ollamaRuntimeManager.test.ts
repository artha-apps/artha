/**
 * ollamaRuntimeManager tests — the install pipeline end-to-end against a
 * FAKE release served through an injected fetch: a real tar.gz built in a temp
 * dir, a real sha256sum.txt, real extraction with the OS tar. Covers the trust
 * rules (checksum mismatch → discarded, no checksum → refused, pointer outside
 * root → ignored) and the pin's forward-only rule.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import { execFileSync } from 'child_process';
import {
  assetForPlatform, parseSha256Sums, resolvePinnedVersion, readManagedRuntime, runtimeRoot,
  installManagedRuntime, extractArgs, locateBinary, BUNDLED_PIN_VERSION, releaseAssetUrl,
} from './ollamaRuntimeManager';

let tmp: string;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'artha-ollama-rt-')); });
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

/** Build a tiny fake `ollama-darwin.tgz` containing a shell-script "ollama". */
function fakeRelease(version: string): { tgz: Buffer; sums: string } {
  const src = path.join(tmp, `src-${version}`);
  fs.mkdirSync(src, { recursive: true });
  fs.writeFileSync(path.join(src, 'ollama'), `#!/bin/sh\necho ${version}\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(src, 'libggml-base.dylib'), 'not really a dylib');
  const tgzPath = path.join(tmp, `ollama-darwin-${version}.tgz`);
  execFileSync('tar', ['-czf', tgzPath, '-C', src, 'ollama', 'libggml-base.dylib']);
  const tgz = fs.readFileSync(tgzPath);
  const hex = crypto.createHash('sha256').update(tgz).digest('hex');
  const sums = `deadbeef${'0'.repeat(56)}  ./Ollama.dmg\n${hex}  ./ollama-darwin.tgz\n`;
  return { tgz, sums };
}

/** fetch stub that serves the fake release for one version. */
function releaseFetch(version: string, over: { sums?: string; tgz?: Buffer } = {}) {
  const rel = fakeRelease(version);
  const sums = over.sums ?? rel.sums;
  const tgz = over.tgz ?? rel.tgz;
  return vi.fn(async (url: string | URL) => {
    const u = String(url);
    if (u === releaseAssetUrl(version, 'sha256sum.txt')) {
      return { ok: true, status: 200, text: async () => sums } as unknown as Response;
    }
    if (u === releaseAssetUrl(version, 'ollama-darwin.tgz')) {
      const stream = new ReadableStream<Uint8Array>({
        start(c) {
          // Two chunks so the progress path runs more than once.
          const mid = Math.floor(tgz.length / 2);
          c.enqueue(new Uint8Array(tgz.subarray(0, mid)));
          c.enqueue(new Uint8Array(tgz.subarray(mid)));
          c.close();
        },
      });
      return {
        ok: true, status: 200, body: stream,
        headers: { get: (k: string) => (k === 'content-length' ? String(tgz.length) : null) },
      } as unknown as Response;
    }
    return { ok: false, status: 404 } as unknown as Response;
  });
}

describe('assetForPlatform', () => {
  it('maps every shipped platform to an official release asset', () => {
    expect(assetForPlatform('darwin', 'arm64')?.asset).toBe('ollama-darwin.tgz');
    expect(assetForPlatform('darwin', 'x64')?.asset).toBe('ollama-darwin.tgz');
    expect(assetForPlatform('win32', 'x64')?.asset).toBe('ollama-windows-amd64.zip');
    expect(assetForPlatform('win32', 'arm64')?.binName).toBe('ollama.exe');
    expect(assetForPlatform('linux', 'x64')?.kind).toBe('tar.zst');
    expect(assetForPlatform('linux', 'arm64')?.asset).toBe('ollama-linux-arm64.tar.zst');
  });
  it('is honest about unsupported combos', () => {
    expect(assetForPlatform('freebsd', 'x64')).toBeNull();
    expect(assetForPlatform('win32', 'ia32')).toBeNull();
  });
});

describe('parseSha256Sums', () => {
  it('parses GitHub\'s "<hex>  ./file" lines and ignores junk', () => {
    const m = parseSha256Sums(`${'a'.repeat(64)}  ./ollama-darwin.tgz\nnot a line\n${'B'.repeat(64)} *Ollama.dmg\n`);
    expect(m.get('ollama-darwin.tgz')).toBe('a'.repeat(64));
    expect(m.get('Ollama.dmg')).toBe('b'.repeat(64));
    expect(m.size).toBe(2);
  });
});

describe('extractArgs', () => {
  it('never builds a shell string', () => {
    expect(extractArgs('tgz', '/a/x.tgz', '/d')).toEqual(['-xzf', '/a/x.tgz', '-C', '/d']);
    expect(extractArgs('zip', '/a/x.zip', '/d')).toEqual(['-xf', '/a/x.zip', '-C', '/d']);
    expect(extractArgs('tar.zst', '/a/x.tar.zst', '/d')[0]).toBe('--zstd');
  });
});

describe('resolvePinnedVersion', () => {
  it('uses a well-formed newer remote pin', async () => {
    const f = vi.fn(async () => ({ ok: true, json: async () => ({ schemaVersion: 1, version: '9.9.9' }) }) as unknown as Response);
    expect(await resolvePinnedVersion(f as unknown as typeof fetch)).toEqual({ version: '9.9.9', source: 'remote' });
  });
  it('never moves BACKWARD from the bundled pin', async () => {
    const f = vi.fn(async () => ({ ok: true, json: async () => ({ schemaVersion: 1, version: '0.1.0' }) }) as unknown as Response);
    expect(await resolvePinnedVersion(f as unknown as typeof fetch)).toEqual({ version: BUNDLED_PIN_VERSION, source: 'bundled' });
  });
  it('falls back on HTTP error, throw, or a non-semver version', async () => {
    for (const f of [
      vi.fn(async () => ({ ok: false, status: 500 }) as unknown as Response),
      vi.fn(async () => { throw new Error('offline'); }),
      vi.fn(async () => ({ ok: true, json: async () => ({ schemaVersion: 1, version: 'latest' }) }) as unknown as Response),
      vi.fn(async () => ({ ok: true, json: async () => ({ schemaVersion: 2, version: '9.9.9' }) }) as unknown as Response),
    ]) {
      expect((await resolvePinnedVersion(f as unknown as typeof fetch)).source).toBe('bundled');
    }
  });
});

describe('readManagedRuntime', () => {
  it('returns null with nothing installed', () => {
    expect(readManagedRuntime(tmp)).toBeNull();
  });
  it('refuses a pointer outside the runtime root', () => {
    fs.mkdirSync(runtimeRoot(tmp), { recursive: true });
    const evil = path.join(tmp, 'evil');
    fs.writeFileSync(evil, '#!/bin/sh\n');
    fs.writeFileSync(path.join(runtimeRoot(tmp), 'current.json'), JSON.stringify({ version: '0.33.2', binPath: evil }));
    expect(readManagedRuntime(tmp)).toBeNull();
  });
  it('returns null when the recorded binary is gone', () => {
    fs.mkdirSync(runtimeRoot(tmp), { recursive: true });
    fs.writeFileSync(path.join(runtimeRoot(tmp), 'current.json'),
      JSON.stringify({ version: '0.33.2', binPath: path.join(runtimeRoot(tmp), 'versions', '0.33.2', 'ollama') }));
    expect(readManagedRuntime(tmp)).toBeNull();
  });
});

describe('locateBinary', () => {
  it('finds flat, bin/, and single-nested layouts', () => {
    const a = path.join(tmp, 'a'); fs.mkdirSync(a); fs.writeFileSync(path.join(a, 'ollama'), '');
    expect(locateBinary(a, 'ollama')).toBe(path.join(a, 'ollama'));
    const b = path.join(tmp, 'b', 'bin'); fs.mkdirSync(b, { recursive: true }); fs.writeFileSync(path.join(b, 'ollama'), '');
    expect(locateBinary(path.join(tmp, 'b'), 'ollama')).toBe(path.join(b, 'ollama'));
    const c = path.join(tmp, 'c', 'ollama-0.33'); fs.mkdirSync(c, { recursive: true }); fs.writeFileSync(path.join(c, 'ollama'), '');
    expect(locateBinary(path.join(tmp, 'c'), 'ollama')).toBe(path.join(c, 'ollama'));
    expect(locateBinary(path.join(tmp, 'nope-missing'), 'ollama')).toBeNull();
  });
});

describe('installManagedRuntime', () => {
  const base = { platform: 'darwin' as const, arch: 'arm64' };

  it('downloads, verifies, extracts, records current.json, and the binary runs', async () => {
    const events: string[] = [];
    const res = await installManagedRuntime({
      ...base, userDataDir: tmp, version: '0.33.2',
      fetchFn: releaseFetch('0.33.2') as unknown as typeof fetch,
      emit: p => events.push(p.phase),
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.runtime.version).toBe('0.33.2');
    expect(fs.existsSync(res.runtime.binPath)).toBe(true);
    expect(res.runtime.binPath.startsWith(runtimeRoot(tmp))).toBe(true);
    // The recorded pointer round-trips through the reader.
    expect(readManagedRuntime(tmp)?.binPath).toBe(res.runtime.binPath);
    // Executable bit set and it actually runs. The fake binary is a shell
    // script, so this last assertion is POSIX-only (the pipeline itself is
    // exercised identically on Windows — download, verify, tar, pointer).
    if (process.platform !== 'win32') {
      expect(execFileSync(res.runtime.binPath).toString().trim()).toBe('0.33.2');
    }
    // Archive and temp dirs are gone.
    expect(fs.existsSync(path.join(runtimeRoot(tmp), 'downloads', 'ollama-darwin.tgz'))).toBe(false);
    expect(fs.existsSync(path.join(runtimeRoot(tmp), 'versions', '0.33.2.tmp'))).toBe(false);
    expect(events[0]).toBe('resolving');
    expect(events).toContain('downloading');
    expect(events).toContain('verifying');
    expect(events).toContain('extracting');
    expect(events[events.length - 1]).toBe('installed');
  });

  it('is idempotent for the already-installed version (no download)', async () => {
    const f = releaseFetch('0.33.2');
    await installManagedRuntime({ ...base, userDataDir: tmp, version: '0.33.2', fetchFn: f as unknown as typeof fetch });
    const calls = f.mock.calls.length;
    const again = await installManagedRuntime({ ...base, userDataDir: tmp, version: '0.33.2', fetchFn: f as unknown as typeof fetch });
    expect(again.ok && again.alreadyInstalled).toBe(true);
    expect(f.mock.calls.length).toBe(calls);
  });

  it('discards an archive whose checksum does not match, and installs nothing', async () => {
    const sums = `${'f'.repeat(64)}  ./ollama-darwin.tgz\n`;
    const res = await installManagedRuntime({
      ...base, userDataDir: tmp, version: '0.33.2',
      fetchFn: releaseFetch('0.33.2', { sums }) as unknown as typeof fetch,
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toMatch(/checksum/);
    expect(readManagedRuntime(tmp)).toBeNull();
    expect(fs.existsSync(path.join(runtimeRoot(tmp), 'versions', '0.33.2'))).toBe(false);
    const dl = path.join(runtimeRoot(tmp), 'downloads');
    expect(fs.existsSync(dl) ? fs.readdirSync(dl) : []).toEqual([]);
  });

  it('refuses to install when the release publishes no checksum for the asset', async () => {
    const res = await installManagedRuntime({
      ...base, userDataDir: tmp, version: '0.33.2',
      fetchFn: releaseFetch('0.33.2', { sums: `${'a'.repeat(64)}  ./Ollama.dmg\n` }) as unknown as typeof fetch,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/unverified/);
  });

  it('updates from an older managed version and keeps one previous for rollback', async () => {
    await installManagedRuntime({ ...base, userDataDir: tmp, version: '0.33.0', fetchFn: releaseFetch('0.33.0') as unknown as typeof fetch });
    await installManagedRuntime({ ...base, userDataDir: tmp, version: '0.33.1', fetchFn: releaseFetch('0.33.1') as unknown as typeof fetch });
    const res = await installManagedRuntime({ ...base, userDataDir: tmp, version: '0.33.2', fetchFn: releaseFetch('0.33.2') as unknown as typeof fetch });
    expect(res.ok).toBe(true);
    expect(readManagedRuntime(tmp)?.version).toBe('0.33.2');
    const versions = fs.readdirSync(path.join(runtimeRoot(tmp), 'versions')).sort();
    expect(versions).toEqual(['0.33.1', '0.33.2']);
  });

  it('reports unsupported platforms honestly instead of trying', async () => {
    const res = await installManagedRuntime({ platform: 'freebsd', arch: 'x64', userDataDir: tmp, version: '0.33.2', fetchFn: vi.fn() as unknown as typeof fetch });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/can't install Ollama automatically/);
  });
});
