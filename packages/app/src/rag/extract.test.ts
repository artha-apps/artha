/**
 * Integration tests for `rag/extract.ts`.
 *
 * Verifies: plain-text (UTF-8) passthrough for .md and .json files, real XLSX
 * workbook extraction via SheetJS, and graceful empty-string fallback for a
 * corrupt binary file. Tests write real files into a temp directory so the
 * extractors exercise their actual parse paths rather than mocked I/O.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as XLSX from 'xlsx';
import { extractText } from './extract';

let tmp: string;

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'artha-extract-'));
});
afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('extractText', () => {
  // ── Plain text (UTF-8) passthrough ─────────────────────────────────────────

  it('reads plain text files as UTF-8', async () => {
    const f = path.join(tmp, 'note.md');
    fs.writeFileSync(f, '# Heading\n\nSome **markdown** content.');
    expect(await extractText(f)).toContain('Some **markdown** content.');
  });

  it('reads JSON files', async () => {
    const f = path.join(tmp, 'data.json');
    fs.writeFileSync(f, JSON.stringify({ hello: 'world' }));
    expect(await extractText(f)).toContain('"hello":"world"');
  });

  // ── Binary format extraction ────────────────────────────────────────────────

  it('extracts text from a real .xlsx workbook', async () => {
    const f = path.join(tmp, 'sheet.xlsx');
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet([['Name', 'Role'], ['Ada', 'Engineer']]);
    XLSX.utils.book_append_sheet(wb, ws, 'People');
    // Buffer write — the SheetJS CDN build is ESM and does not auto-wire fs.
    fs.writeFileSync(f, XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer);

    const out = await extractText(f);
    expect(out).toContain('People');
    expect(out).toContain('Ada');
    expect(out).toContain('Engineer');
  });

  // ── Error resilience ───────────────────────────────────────────────────────

  it('returns empty string for a corrupt file of a binary type', async () => {
    const f = path.join(tmp, 'broken.pdf');
    fs.writeFileSync(f, 'not actually a pdf');
    expect(await extractText(f)).toBe('');
  });
});
