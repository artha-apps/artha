/**
 * Tests for buildShallowTree — the folder-tree helper that seeds the
 * working-scope preamble so the agent can orient itself without extra tool
 * calls. Verifies filtering, ordering, depth limiting, entry capping, and
 * graceful handling of empty/missing directories.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { buildShallowTree } from './folderTree';

let root: string;

// Create a realistic temp project tree that mirrors a typical repo layout.
// node_modules, .git, and .env are deliberately included to confirm they're
// filtered out.
beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'artha-tree-'));
  fs.writeFileSync(path.join(root, 'README.md'), '# App');
  fs.writeFileSync(path.join(root, 'package.json'), '{}');
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'src', 'index.ts'), 'export {}');
  fs.mkdirSync(path.join(root, 'node_modules'));
  fs.writeFileSync(path.join(root, 'node_modules', 'junk.js'), '//');
  fs.mkdirSync(path.join(root, '.git'));
  fs.writeFileSync(path.join(root, '.env'), 'SECRET=1');
});

afterAll(() => {
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
});

// ── Core behaviour ────────────────────────────────────────────────────────────

describe('buildShallowTree', () => {
  // Confirms directories are recursed and files within them are listed.
  it('lists files and recurses into real subdirectories', () => {
    const tree = buildShallowTree(root);
    expect(tree).toContain('README.md');
    expect(tree).toContain('package.json');
    expect(tree).toContain('src/');
    expect(tree).toContain('index.ts');
  });

  // node_modules/.git/hidden-files bloat context — assert they're invisible.
  it('skips heavy dirs (node_modules, .git) and hidden files', () => {
    const tree = buildShallowTree(root);
    expect(tree).not.toContain('node_modules');
    expect(tree).not.toContain('.git');
    expect(tree).not.toContain('.env');
  });

  // Directory-first ordering helps the model scan structure at a glance.
  it('sorts directories before files', () => {
    const tree = buildShallowTree(root);
    expect(tree.indexOf('src/')).toBeLessThan(tree.indexOf('README.md'));
  });

  // At depth 1 the src/ dir appears but its children must not.
  it('respects maxDepth (no recursion past the limit)', () => {
    const tree = buildShallowTree(root, { maxDepth: 1 });
    expect(tree).toContain('src/');
    expect(tree).not.toContain('index.ts');
  });

  // Generates 80 files then caps at 10 — the "… (more)" line must appear.
  it('caps entries and marks truncation', () => {
    const big = fs.mkdtempSync(path.join(os.tmpdir(), 'artha-tree-big-'));
    for (let i = 0; i < 80; i++) fs.writeFileSync(path.join(big, `f${i}.txt`), 'x');
    const tree = buildShallowTree(big, { maxEntries: 10 });
    expect(tree.split('\n').filter(l => l.includes('.txt')).length).toBeLessThanOrEqual(10);
    expect(tree).toMatch(/truncated|more/i);
    fs.rmSync(big, { recursive: true, force: true });
  });

  // Both an empty dir and a non-existent path must return '' (not throw).
  it('returns empty string for an empty or missing folder', () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'artha-tree-empty-'));
    expect(buildShallowTree(empty)).toBe('');
    expect(buildShallowTree(path.join(empty, 'does-not-exist'))).toBe('');
    fs.rmSync(empty, { recursive: true, force: true });
  });
});
