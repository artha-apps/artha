/** Task file round-trip and validation tests. */
import { describe, it, expect } from 'vitest';
import { exportTaskMarkdown, parseTaskMarkdown } from './taskFile';

describe('task files', () => {
  it('round-trips name, schedule, prompt and notify', () => {
    const md = exportTaskMarkdown({ name: 'Morning: invoices', cron: '0 8 * * 1-5', prompt: 'Check invoices.\n\nSummarise.', notify: 'on_change' });
    expect(md.startsWith('---\n')).toBe(true);
    expect(parseTaskMarkdown(md)).toEqual({
      name: 'Morning: invoices', schedule: '0 8 * * 1-5', prompt: 'Check invoices.\n\nSummarise.', notify: 'on_change',
    });
  });

  it('accepts CRLF, a BOM, and an empty schedule (trigger-only task)', () => {
    const md = '\uFEFF---\r\nname: Watch scans\r\nschedule:\r\n---\r\nFile new scans.\r\n';
    expect(parseTaskMarkdown(md)).toMatchObject({ name: 'Watch scans', schedule: null, notify: 'always' });
  });

  it('rejects malformed files with a reason', () => {
    expect(() => parseTaskMarkdown('no frontmatter')).toThrow(/frontmatter/);
    expect(() => parseTaskMarkdown('---\nschedule: 0 8 * * *\n---\nx')).toThrow(/name/);
    expect(() => parseTaskMarkdown('---\nname: a\n---\n')).toThrow(/prompt/);
    expect(() => parseTaskMarkdown('---\nname: a\nnotify: loud\n---\nx')).toThrow(/notify/);
  });

  it('ignores unknown keys — a file cannot switch on triggers', () => {
    const t = parseTaskMarkdown('---\nname: a\nwebhook_enabled: 1\nwatch_folder: /\n---\nx');
    expect(Object.keys(t).sort()).toEqual(['name', 'notify', 'prompt', 'schedule']);
  });
});
