/**
 * Zip-slip guard tests (shipped-surface audit, security finding).
 *
 * Bundle artifact names are attacker-controlled and were written to disk with
 * `path.join(extractedDir, name)` BEFORE the integrity check ran — so an entry
 * named `../../../../.zshrc` escaped the extraction directory entirely.
 */
import { describe, it, expect } from 'vitest';
import * as path from 'path';
import { sanitizeEntryName } from './bundle';

describe('sanitizeEntryName', () => {
  it('keeps ordinary names intact', () => {
    expect(sanitizeEntryName('report.docx')).toBe('report.docx');
    expect(sanitizeEntryName('Q3 summary (final).pdf')).toBe('Q3 summary (final).pdf');
  });

  it('strips POSIX traversal', () => {
    expect(sanitizeEntryName('../../../../.zshrc')).toBe('zshrc');
    expect(sanitizeEntryName('../secret.txt')).toBe('secret.txt');
    expect(sanitizeEntryName('a/b/c/payload.sh')).toBe('payload.sh');
  });

  it('strips Windows traversal and separators (must not rely on POSIX basename)', () => {
    expect(sanitizeEntryName('..\\..\\Windows\\System32\\evil.dll')).toBe('evil.dll');
    expect(sanitizeEntryName('C:\\Windows\\System32\\evil.dll')).toBe('evil.dll');
    expect(sanitizeEntryName('dir\\sub\\file.txt')).toBe('file.txt');
  });

  it('rejects names that reduce to nothing safe', () => {
    for (const bad of ['..', '.', '', '   ', '../..', '/', '\\', '...']) {
      expect(sanitizeEntryName(bad), bad).toBe('');
    }
  });

  it('rejects a bare drive prefix and strips control characters', () => {
    expect(sanitizeEntryName('C:')).toBe('');
    expect(sanitizeEntryName('safe\u0001name.txt')).toBe('safename.txt');
  });

  it('is defensive against non-string input', () => {
    expect(sanitizeEntryName(undefined as unknown as string)).toBe('');
    expect(sanitizeEntryName(null as unknown as string)).toBe('');
  });

  it('every sanitized name resolves INSIDE the extraction root', () => {
    const root = path.resolve('/tmp/artha-extract/bundle-1');
    const hostile = [
      '../../../../.zshrc', '..\\..\\evil.dll', '/etc/passwd',
      'C:\\Windows\\evil.dll', 'a/b/../../../../escape.txt', './../../x',
    ];
    for (const name of hostile) {
      const safe = sanitizeEntryName(name);
      if (!safe) continue;                       // rejected outright
      const dest = path.resolve(root, safe);
      expect(dest.startsWith(root + path.sep), `${name} -> ${dest}`).toBe(true);
    }
  });
});
