/**
 * System-path guard tests (release gate #43).
 *
 * The guard is platform-parameterized, so both the POSIX and the Windows
 * blocklists are exercised on ANY host — no Windows machine required. Before
 * this, the denylist was POSIX-only, so on Windows the agent could move/delete
 * C:\Windows\System32 etc. with no protection at all.
 */
import { describe, it, expect } from 'vitest';
import { isSystemPath } from './filesystem';

describe('isSystemPath — POSIX', () => {
  const P = 'linux' as const;
  it('blocks OS-system roots and their subtrees', () => {
    for (const p of ['/etc', '/etc/passwd', '/usr/bin/x', '/System', '/System/Library', '/bin/sh', '/sbin', '/private/etc/hosts', '/Library/System/z']) {
      expect(isSystemPath(p, P), p).toBe(true);
    }
  });
  it('does NOT block user paths — including prefix lookalikes', () => {
    for (const p of ['/Users/x/Documents/a.txt', '/home/x/etc-notes.txt', '/etched', '/usrlocal', '/binky/file', '/tmp/x']) {
      expect(isSystemPath(p, P), p).toBe(false);
    }
  });
});

describe('isSystemPath — Windows (#43, the gap this closes)', () => {
  const W = 'win32' as const;
  it('blocks Windows system dirs on any drive, case-insensitively, both separators', () => {
    for (const p of [
      'C:\\Windows', 'C:\\Windows\\System32', 'c:\\windows\\system32\\cmd.exe',
      'C:/Windows/System32', 'D:\\Windows\\notepad.exe',
      'C:\\Program Files', 'C:\\Program Files\\App', 'C:\\Program Files (x86)\\X',
      'C:\\ProgramData\\y', 'C:\\$Recycle.Bin', 'E:\\System Volume Information',
      'C:\\Recovery', '\\\\server\\share\\file',
    ]) {
      expect(isSystemPath(p, W), p).toBe(true);
    }
  });
  it('does NOT block a user file under the profile or other folders', () => {
    for (const p of [
      'C:\\Users\\noopur\\Documents\\report.pdf',
      'D:\\projects\\artha\\readme.md',
      'C:\\Windowsly\\x.txt',           // lookalike, not the Windows dir
      'C:\\Program Filesx\\y.txt',      // lookalike
    ]) {
      expect(isSystemPath(p, W), p).toBe(false);
    }
  });
});
