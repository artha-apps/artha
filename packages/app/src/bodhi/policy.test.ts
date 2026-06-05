/**
 * Tests for the pure policy/receipt helpers (pattern matching, effect
 * descriptions, hashing). DB-backed CRUD/evaluation is covered by integration.
 */
import { describe, it, expect } from 'vitest';
import { policyMatches } from './policy';
import { hashResult, describeEffect } from './receipts';

describe('policyMatches', () => {
  it('"*" matches every tool', () => {
    expect(policyMatches('*', 'fs_delete_file')).toBe(true);
    expect(policyMatches('*', 'web_search')).toBe(true);
  });

  it('a trailing "_" is a name prefix', () => {
    expect(policyMatches('browser_', 'browser_click')).toBe(true);
    expect(policyMatches('browser_', 'fs_move_file')).toBe(false);
  });

  it('any other pattern is an exact name', () => {
    expect(policyMatches('fs_delete_file', 'fs_delete_file')).toBe(true);
    expect(policyMatches('fs_delete_file', 'fs_delete_folder')).toBe(false);
  });
});

describe('describeEffect', () => {
  it('describes a move in before→after form', () => {
    const e = describeEffect('fs_move_file', { source: '/a/x.png', destination: '/b/x.png' }, '{}', 'ok');
    expect(e).toBe('Moved /a/x.png → /b/x.png');
  });

  it('surfaces fs_move_batch counts from the real result', () => {
    const e = describeEffect('fs_move_batch', {}, JSON.stringify({ moved: 5, failed: 1 }), 'ok');
    expect(e).toContain('5 file(s)');
    expect(e).toContain('1 failed');
  });

  it('labels blocked and dry-run calls without claiming execution', () => {
    expect(describeEffect('fs_delete_file', { path: '/x' }, '', 'blocked')).toMatch(/not executed/i);
    expect(describeEffect('fs_delete_file', { path: '/x' }, '', 'skipped')).toMatch(/not executed/i);
  });
});

describe('hashResult', () => {
  it('is deterministic and changes when the result changes', () => {
    expect(hashResult('hello')).toBe(hashResult('hello'));
    expect(hashResult('hello')).not.toBe(hashResult('world'));
    expect(hashResult('hello')).toHaveLength(16);
  });
});
