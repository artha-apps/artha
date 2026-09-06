import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { resolveExistingSource, resolveDestination, invokeFilesystemTool } from './filesystem';

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'artha-pathrepair-'));
  fs.mkdirSync(path.join(root, 'Downloads'));
  fs.mkdirSync(path.join(root, 'Project'));
  fs.writeFileSync(path.join(root, 'Downloads', 'Trinity customer DB B2C (US).xlsx'), 'x');
});
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

describe('resolveExistingSource', () => {
  it('repairs a source that omitted its extension when exactly one file matches', async () => {
    const r = await resolveExistingSource(path.join(root, 'Downloads', 'Trinity customer DB B2C (US)'));
    expect(r.repaired).toBe(true);
    expect(path.basename(r.path)).toBe('Trinity customer DB B2C (US).xlsx');
  });
  it('is case-insensitive and leaves an existing path alone', async () => {
    const r1 = await resolveExistingSource(path.join(root, 'Downloads', 'trinity customer db b2c (us)'));
    expect(r1.repaired).toBe(true);
    const r2 = await resolveExistingSource(path.join(root, 'Downloads', 'Trinity customer DB B2C (US).xlsx'));
    expect(r2.repaired).toBe(false);
  });
  it('refuses ambiguity and names near misses when nothing matches', async () => {
    fs.writeFileSync(path.join(root, 'Downloads', 'Trinity customer DB B2C (US).csv'), 'y');
    await expect(resolveExistingSource(path.join(root, 'Downloads', 'Trinity customer DB B2C (US)'))).rejects.toThrow(/Ambiguous/);
    await expect(resolveExistingSource(path.join(root, 'Downloads', 'Trinity.docx'))).rejects.toThrow(/Similar names/);
  });
});

describe('resolveDestination', () => {
  const src = () => path.join(root, 'Downloads', 'Trinity customer DB B2C (US).xlsx');
  it('moves INTO an existing directory when the destination has no filename', async () => {
    expect(await resolveDestination(src(), path.join(root, 'Project'))).toBe(path.join(root, 'Project', 'Trinity customer DB B2C (US).xlsx'));
  });
  it('allows exactly one new leaf folder under an existing parent', async () => {
    const dst = path.join(root, 'Project', 'data', 'db.xlsx');
    expect(await resolveDestination(src(), dst)).toBe(dst);
  });
  it('refuses an invented parent chain instead of mkdir-ing junk', async () => {
    const dst = path.join(root, 'noopurtrivedi', 'Project', 'db.xlsx');
    await expect(resolveDestination(src(), dst)).rejects.toThrow(/does not create missing parent folders/);
    expect(fs.existsSync(path.join(root, 'noopurtrivedi'))).toBe(false);
  });
});

describe('fs_move_file end to end with repairs', () => {
  it('moves an extension-less source into a directory destination', async () => {
    const out = JSON.parse(await invokeFilesystemTool('fs_move_file', {
      source: path.join(root, 'Downloads', 'Trinity customer DB B2C (US)'),
      destination: path.join(root, 'Project'),
    }, null));
    expect(out.success).toBe(true);
    expect(fs.existsSync(path.join(root, 'Project', 'Trinity customer DB B2C (US).xlsx'))).toBe(true);
    expect(out.note).toMatch(/source resolved/);
  });
});
