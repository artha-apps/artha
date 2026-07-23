/**
 * Hard-sandbox tests for the filesystem tools. When a chat has attached scopes,
 * reads/writes outside them must be rejected; with no scopes, behaviour falls
 * back to the historical home-dir-wide access (system dirs still blocked).
 *
 * Verifies:
 *   - folder scopes allow access to the whole subtree but nothing adjacent
 *   - file scopes grant only the exact file, not its siblings
 *   - writes (moves) whose *destination* escapes the scope are also blocked
 *   - an empty scope list is treated as "no scopes" (open access, minus system dirs)
 *   - system directories are blocked independently of any scope setting
 *   - path prefix overlap (/workdir vs /workdir-2) is handled correctly
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { invokeFilesystemTool } from './filesystem';
import type { ScopeRoot } from '../db/scopes';

// Temp directory layout:
//   <base>/
//     workdir/          ← the attached folder scope (root)
//       note.txt        ← insideFile
//     elsewhere/        ← sibling NOT in scope (outside)
//       single.txt      ← scopedFile (attached as an exact-file scope)
let root: string;        // an attached folder scope
let outside: string;     // a sibling folder NOT in scope
let insideFile: string;
let scopedFile: string;  // a standalone file scope

beforeAll(() => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'artha-scope-'));
  root = path.join(base, 'workdir');
  outside = path.join(base, 'elsewhere');
  fs.mkdirSync(root);
  fs.mkdirSync(outside);
  insideFile = path.join(root, 'note.txt');
  fs.writeFileSync(insideFile, 'hello from inside');
  scopedFile = path.join(outside, 'single.txt');
  fs.writeFileSync(scopedFile, 'standalone file scope');
});

afterAll(() => {
  try { fs.rmSync(path.dirname(root), { recursive: true, force: true }); } catch { /* ignore */ }
});

// ── Folder scope ─────────────────────────────────────────────────────────────
describe('filesystem hard sandbox', () => {
  it('allows reads inside an attached folder', async () => {
    const roots: ScopeRoot[] = [{ path: root, kind: 'folder' }];
    const out = await invokeFilesystemTool('fs_read_file', { path: insideFile }, roots);
    expect(out).toContain('hello from inside');
  });

  it('rejects reads outside attached scopes', async () => {
    const roots: ScopeRoot[] = [{ path: root, kind: 'folder' }];
    const outsideFile = path.join(outside, 'secret.txt');
    fs.writeFileSync(outsideFile, 'nope');
    await expect(invokeFilesystemTool('fs_read_file', { path: outsideFile }, roots))
      .rejects.toThrow(/outside this chat's selected folders/i);
  });

  it('rejects writes (move) whose destination escapes the scope', async () => {
    const roots: ScopeRoot[] = [{ path: root, kind: 'folder' }];
    await expect(invokeFilesystemTool('fs_move_file', { source: insideFile, destination: path.join(outside, 'note.txt') }, roots))
      .rejects.toThrow(/outside this chat's selected folders/i);
  });

  // ── File scope ───────────────────────────────────────────────────────────
  it('a file scope grants its exact file but not its siblings', async () => {
    const roots: ScopeRoot[] = [{ path: scopedFile, kind: 'file' }];
    const ok = await invokeFilesystemTool('fs_read_file', { path: scopedFile }, roots);
    expect(ok).toContain('standalone file scope');
    const sibling = path.join(outside, 'single.txt.bak');
    fs.writeFileSync(sibling, 'x');
    await expect(invokeFilesystemTool('fs_read_file', { path: sibling }, roots))
      .rejects.toThrow(/outside this chat's selected folders/i);
  });

  // ── Fallback / edge cases ────────────────────────────────────────────────
  it('falls back to home-dir-wide access when no scopes are attached', async () => {
    const out = await invokeFilesystemTool('fs_read_file', { path: scopedFile }, []);
    expect(out).toContain('standalone file scope');
  });

  // POSIX-ONLY: asserts the macOS/Linux blocklist (/etc, /System, …). On
  // Windows those paths don't exist, so the call fails with ENOENT before
  // reaching the guard. Skipped there rather than asserting a behaviour the
  // code does not implement — see the Windows system-path gap recorded in
  // docs/testing/SECURITY_TRIAGE_DEPENDENCIES.md (pre-existing, not Phase A).
  it.skipIf(process.platform === 'win32')('still blocks OS-system directories regardless of scopes', async () => {
    await expect(invokeFilesystemTool('fs_list_directory', { path: '/etc' }, []))
      .rejects.toThrow(/system directory/i);
  });

  it('is not fooled by prefix overlap (/workdir vs /workdir-2)', async () => {
    const roots: ScopeRoot[] = [{ path: root, kind: 'folder' }];
    const lookalike = root + '-2';
    fs.mkdirSync(lookalike);
    fs.writeFileSync(path.join(lookalike, 'a.txt'), 'x');
    await expect(invokeFilesystemTool('fs_read_file', { path: path.join(lookalike, 'a.txt') }, roots))
      .rejects.toThrow(/outside this chat's selected folders/i);
  });

  // ── Symlink escape ─────────────────────────────────────────────────────────
  it('blocks a symlink inside the scope that points OUTSIDE it', async () => {
    const roots: ScopeRoot[] = [{ path: root, kind: 'folder' }];
    // A link living inside the allowed folder but resolving to a sibling file.
    const link = path.join(root, 'escape-link.txt');
    try { fs.symlinkSync(scopedFile, link); } catch { return; /* FS without symlink support — skip */ }
    await expect(invokeFilesystemTool('fs_read_file', { path: link }, roots))
      .rejects.toThrow(/outside this chat's selected folders/i);
  });

  // POSIX-ONLY: asserts the macOS/Linux blocklist (/etc, /System, …). On
  // Windows those paths don't exist, so the call fails with ENOENT before
  // reaching the guard. Skipped there rather than asserting a behaviour the
  // code does not implement — see the Windows system-path gap recorded in
  // docs/testing/SECURITY_TRIAGE_DEPENDENCIES.md (pre-existing, not Phase A).
  it.skipIf(process.platform === 'win32')('blocks a symlink that points at a system directory', async () => {
    const roots: ScopeRoot[] = [{ path: root, kind: 'folder' }];
    const link = path.join(root, 'etc-link');
    try { fs.symlinkSync('/etc', link); } catch { return; /* skip if unsupported */ }
    await expect(invokeFilesystemTool('fs_list_directory', { path: link }, roots))
      .rejects.toThrow(/system directory|outside this chat/i);
  });
});
