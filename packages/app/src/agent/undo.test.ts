/**
 * Undo registry tests — exercise the real reversal against a temp filesystem
 * for each reversible kind (move / copy / create_dir / trash).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { promises as fsp } from 'fs';
import * as fs from 'fs';
import * as os from 'os';
import path from 'path';
import { recordFilesystemEffect, mostRecentUndoable, revert, listUndoable } from './undo';

let dir: string;

beforeEach(async () => {
  dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'artha-undo-'));
});

/** Revert the most recently recorded action and return its result. */
async function undoLast() {
  const last = mostRecentUndoable();
  expect(last).not.toBeNull();
  return revert(last!.id);
}

describe('undo: move', () => {
  it('moves the file back to its origin', async () => {
    const a = path.join(dir, 'a.txt');
    const b = path.join(dir, 'sub', 'a.txt');
    await fsp.writeFile(a, 'hi');
    await fsp.mkdir(path.dirname(b), { recursive: true });
    await fsp.rename(a, b);

    recordFilesystemEffect('fs_move_file', JSON.stringify({ moved: a, to: b, success: true }));
    const r = await undoLast();

    expect(r.ok).toBe(true);
    expect(fs.existsSync(a)).toBe(true);
    expect(fs.existsSync(b)).toBe(false);
  });
});

describe('undo: move_batch', () => {
  it('reverses every successful move', async () => {
    const srcs = ['x.txt', 'y.txt'].map((n) => path.join(dir, n));
    const dsts = srcs.map((s) => path.join(dir, 'out', path.basename(s)));
    await fsp.mkdir(path.join(dir, 'out'), { recursive: true });
    for (let i = 0; i < srcs.length; i++) { await fsp.writeFile(srcs[i], 'x'); await fsp.rename(srcs[i], dsts[i]); }

    recordFilesystemEffect('fs_move_batch', JSON.stringify({
      success: true, moved: 2,
      results: srcs.map((s, i) => ({ source: s, to: dsts[i], ok: true })),
    }));
    const r = await undoLast();

    expect(r.ok).toBe(true);
    expect(srcs.every((s) => fs.existsSync(s))).toBe(true);
    expect(dsts.every((d) => !fs.existsSync(d))).toBe(true);
  });
});

describe('undo: copy', () => {
  it('deletes the copy, leaving the source', async () => {
    const a = path.join(dir, 'orig.txt');
    const b = path.join(dir, 'copy.txt');
    await fsp.writeFile(a, 'data');
    await fsp.copyFile(a, b);

    recordFilesystemEffect('fs_copy_file', JSON.stringify({ copied: a, to: b, success: true }));
    const r = await undoLast();

    expect(r.ok).toBe(true);
    expect(fs.existsSync(a)).toBe(true);
    expect(fs.existsSync(b)).toBe(false);
  });
});

describe('undo: create_dir', () => {
  it('removes an empty created folder', async () => {
    const d = path.join(dir, 'newfolder');
    await fsp.mkdir(d);
    recordFilesystemEffect('fs_create_directory', JSON.stringify({ created: d, success: true }));
    const r = await undoLast();
    expect(r.ok).toBe(true);
    expect(fs.existsSync(d)).toBe(false);
  });

  it('leaves a non-empty folder in place with a friendly note', async () => {
    const d = path.join(dir, 'busy');
    await fsp.mkdir(d);
    recordFilesystemEffect('fs_create_directory', JSON.stringify({ created: d, success: true }));
    await fsp.writeFile(path.join(d, 'added-later.txt'), 'x'); // user added a file
    const r = await undoLast();
    expect(r.ok).toBe(false);
    expect(fs.existsSync(d)).toBe(true);
  });
});

describe('undo: trash', () => {
  it('restores a trashed file to its original path', async () => {
    const orig = path.join(dir, 'doomed.txt');
    const trash = path.join(dir, '.trash', 'doomed.txt');
    await fsp.writeFile(orig, 'bye');
    await fsp.mkdir(path.dirname(trash), { recursive: true });
    await fsp.rename(orig, trash);

    recordFilesystemEffect('fs_delete_file', JSON.stringify({ trashed: orig, location: trash }));
    const r = await undoLast();

    expect(r.ok).toBe(true);
    expect(fs.existsSync(orig)).toBe(true);
    expect(fs.existsSync(trash)).toBe(false);
  });
});

describe('undo: bookkeeping', () => {
  it('ignores failed tool results and permanent deletes', async () => {
    const before = listUndoable().length;
    recordFilesystemEffect('fs_move_file', JSON.stringify({ error: 'nope' }));
    recordFilesystemEffect('fs_delete_file', JSON.stringify({ deleted: '/x', permanent: true }));
    expect(listUndoable().length).toBe(before);
  });

  it('marks an entry undone so it cannot be reverted twice', async () => {
    const d = path.join(dir, 'once');
    await fsp.mkdir(d);
    recordFilesystemEffect('fs_create_directory', JSON.stringify({ created: d, success: true }));
    const id = mostRecentUndoable()!.id;
    expect((await revert(id)).ok).toBe(true);
    expect((await revert(id)).ok).toBe(false);
  });
});

describe('undo: no-clobber safety (audit H20/H21)', () => {
  it('refuses a move-undo when the origin is now occupied, preserving BOTH files', async () => {
    const a = path.join(dir, 'note.txt');
    const b = path.join(dir, 'sub', 'note.txt');
    await fsp.mkdir(path.dirname(b), { recursive: true });
    await fsp.writeFile(b, 'the moved content'); // move already happened
    recordFilesystemEffect('fs_move_file', JSON.stringify({ moved: a, to: b, success: true }));

    // The user then created a NEW file at the original path.
    await fsp.writeFile(a, 'important new file');

    const r = await undoLast();
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/occupied|could not be undone/i);
    // fs.rename would have destroyed the new file; it must survive.
    expect(fs.readFileSync(a, 'utf8')).toBe('important new file');
    expect(fs.readFileSync(b, 'utf8')).toBe('the moved content');
  });

  it('reports a partial batch undo rather than a false clean one', async () => {
    const okFrom = path.join(dir, 'a.txt'), okTo = path.join(dir, 'sub', 'a.txt');
    const blkFrom = path.join(dir, 'b.txt'), blkTo = path.join(dir, 'sub', 'b.txt');
    await fsp.mkdir(path.join(dir, 'sub'), { recursive: true });
    await fsp.writeFile(okTo, 'A');
    await fsp.writeFile(blkTo, 'B');
    await fsp.writeFile(blkFrom, 'new b'); // b's origin now occupied

    recordFilesystemEffect('fs_move_batch', JSON.stringify({
      results: [
        { source: okFrom, to: okTo, ok: true },
        { source: blkFrom, to: blkTo, ok: true },
      ],
      success: true,
    }));
    const r = await undoLast();
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/1 of 2|could not be undone/i);
    expect(fs.readFileSync(okFrom, 'utf8')).toBe('A');   // safe one reverted
    expect(fs.readFileSync(blkFrom, 'utf8')).toBe('new b'); // new file preserved
  });

  it('reports honestly when the moved file is already gone', async () => {
    const a = path.join(dir, 'x.txt'), b = path.join(dir, 'y.txt');
    recordFilesystemEffect('fs_move_file', JSON.stringify({ moved: a, to: b, success: true }));
    const r = await undoLast(); // neither file exists
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/missing|could not be undone|nothing was reverted/i);
  });
});
