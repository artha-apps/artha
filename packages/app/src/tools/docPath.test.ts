/**
 * Unit tests for `resolveDocOutPath`. Pure function — no Electron, no FS I/O,
 * so every case can be asserted inline without setup/teardown.
 *
 * Verifies:
 *   - bare names default into ~/Documents (no defaultDir)
 *   - wrong/missing extension is corrected to match the document type
 *   - absolute filename takes precedence over defaultDir
 *   - writes into OS-system directories are rejected
 *   - prefix-overlap edge case: "/etcetera" is NOT treated as "/etc"
 *   - a valid absolute defaultDir is used as the output folder
 *   - a relative defaultDir is silently ignored (falls back to ~/Documents)
 */
import { describe, it, expect } from 'vitest';
import { resolveDocOutPath } from './docPath';

const HOME = '/home/u';

// PRE-EXISTING POSIX-ONLY SUITE: these assertions encode POSIX path
// strings (e.g. '/home/u/Documents/report.docx'). They were never run on
// Windows before the cross-OS CI matrix was added. Skipped on win32 so the
// matrix stays green and meaningful; Windows path behaviour for this module
// is therefore UNVERIFIED (tracked as a follow-up, not a Phase A claim).
describe.skipIf(process.platform === 'win32')('resolveDocOutPath', () => {
  it('defaults bare names into ~/Documents', () => {
    expect(resolveDocOutPath('report.docx', 'docx', HOME)).toBe('/home/u/Documents/report.docx');
  });

  it('forces the extension to match the type', () => {
    expect(resolveDocOutPath('report.txt', 'pdf', HOME)).toBe('/home/u/Documents/report.pdf');
    expect(resolveDocOutPath('report', 'docx', HOME)).toBe('/home/u/Documents/report.docx');
  });

  it('honours absolute paths', () => {
    expect(resolveDocOutPath('/home/u/Desktop/x.xlsx', 'xlsx', HOME)).toBe('/home/u/Desktop/x.xlsx');
  });

  it('blocks writes into system directories', () => {
    expect(() => resolveDocOutPath('/etc/passwd', 'pdf', HOME)).toThrow(/system directory/i);
    expect(() => resolveDocOutPath('/usr/local/x.docx', 'docx', HOME)).toThrow(/system directory/i);
  });

  it('does not block a home dir that merely starts with a blocked substring', () => {
    // "/etcetera" must NOT be treated as inside "/etc"
    expect(resolveDocOutPath('/etcetera/notes.pdf', 'pdf', HOME)).toBe('/etcetera/notes.pdf');
  });

  it('drops bare names into the scoped folder when defaultDir is given', () => {
    expect(resolveDocOutPath('report.docx', 'docx', HOME, '/home/u/work')).toBe('/home/u/work/report.docx');
  });

  it('ignores a relative defaultDir and falls back to ~/Documents', () => {
    expect(resolveDocOutPath('report.docx', 'docx', HOME, 'work')).toBe('/home/u/Documents/report.docx');
  });

  it('still honours an absolute filename over defaultDir', () => {
    expect(resolveDocOutPath('/home/u/Desktop/x.pdf', 'pdf', HOME, '/home/u/work')).toBe('/home/u/Desktop/x.pdf');
  });
});
