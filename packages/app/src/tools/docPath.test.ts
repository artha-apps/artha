import { describe, it, expect } from 'vitest';
import { resolveDocOutPath } from './docPath';

const HOME = '/home/u';

describe('resolveDocOutPath', () => {
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
});
