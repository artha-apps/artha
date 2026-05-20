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

  it('extracts text from a real .xlsx workbook', async () => {
    const f = path.join(tmp, 'sheet.xlsx');
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet([['Name', 'Role'], ['Ada', 'Engineer']]);
    XLSX.utils.book_append_sheet(wb, ws, 'People');
    XLSX.writeFile(wb, f);

    const out = await extractText(f);
    expect(out).toContain('People');
    expect(out).toContain('Ada');
    expect(out).toContain('Engineer');
  });

  it('returns empty string for a corrupt file of a binary type', async () => {
    const f = path.join(tmp, 'broken.pdf');
    fs.writeFileSync(f, 'not actually a pdf');
    expect(await extractText(f)).toBe('');
  });
});
