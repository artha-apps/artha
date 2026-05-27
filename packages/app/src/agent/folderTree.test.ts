/**
 * Tests for the shallow folder-tree helper that seeds the working-scope
 * preamble so the agent can see a folder's structure without tool calls.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { buildShallowTree } from './folderTree';

let root: string;

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

describe('buildShallowTree', () => {
  it('lists files and recurses into real subdirectories', () => {
    const tree = buildShallowTree(root);
    expect(tree).toContain('README.md');
    expect(tree).toContain('package.json');
    expect(tree).toContain('src/');
    expect(tree).toContain('index.ts');
  });

  it('skips heavy dirs (node_modules, .git) and hidden files', () => {
    const tree = buildShallowTree(root);
    expect(tree).not.toContain('node_modules');
    expect(tree).not.toContain('.git');
    expect(tree).not.toContain('.env');
  });

  it('sorts directories before files', () => {
    const tree = buildShallowTree(root);
    expect(tree.indexOf('src/')).toBeLessThan(tree.indexOf('README.md'));
  });

  it('respects maxDepth (no recursion past the limit)', () => {
    const tree = buildShallowTree(root, { maxDepth: 1 });
    expect(tree).toContain('src/');
    expect(tree).not.toContain('index.ts');
  });

  it('caps entries and marks truncation', () => {
    const big = fs.mkdtempSync(path.join(os.tmpdir(), 'artha-tree-big-'));
    for (let i = 0; i < 80; i++) fs.writeFileSync(path.join(big, `f${i}.txt`), 'x');
    const tree = buildShallowTree(big, { maxEntries: 10 });
    expect(tree.split('\n').filter(l => l.includes('.txt')).length).toBeLessThanOrEqual(10);
    expect(tree).toMatch(/truncated|more/i);
    fs.rmSync(big, { recursive: true, force: true });
  });

  it('returns empty string for an empty or missing folder', () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'artha-tree-empty-'));
    expect(buildShallowTree(empty)).toBe('');
    expect(buildShallowTree(path.join(empty, 'does-not-exist'))).toBe('');
    fs.rmSync(empty, { recursive: true, force: true });
  });
});
