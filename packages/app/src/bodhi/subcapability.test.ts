/**
 * Tests for composable sub-capability scope intersection — the core safety
 * property is permission monotonicity: a child can never exceed its parent.
 */
import { describe, it, expect } from 'vitest';
import { intersectToolScopes } from './subcapability';

describe('intersectToolScopes', () => {
  it('parent unrestricted (∅) → child scope stands', () => {
    expect(intersectToolScopes([], ['fs_', 'web_search'])).toEqual(['fs_', 'web_search']);
  });

  it('child unrestricted (∅) → clamps to the parent scope', () => {
    expect(intersectToolScopes(['fs_'], [])).toEqual(['fs_']);
  });

  it('parent prefix covers child exact names under it', () => {
    expect(intersectToolScopes(['fs_'], ['fs_move_file', 'web_search'])).toEqual(['fs_move_file']);
  });

  it('parent prefix covers an equal/narrower child prefix', () => {
    expect(intersectToolScopes(['fs_'], ['fs_'])).toEqual(['fs_']);
  });

  it('parent exact name only permits that exact child name', () => {
    expect(intersectToolScopes(['fs_read_file'], ['fs_read_file', 'fs_delete_file']))
      .toEqual(['fs_read_file']);
  });

  it('"*" parent permits anything the child asks for', () => {
    expect(intersectToolScopes(['*'], ['fs_delete_file'])).toEqual(['fs_delete_file']);
  });

  it('disjoint scopes yield a grant-nothing sentinel, never "all tools"', () => {
    const result = intersectToolScopes(['web_'], ['fs_delete_file']);
    expect(result).toEqual(['__no_tools__']);
    // Critically NOT [] (which would mean "all tools").
    expect(result).not.toEqual([]);
  });

  it('the result can never widen the parent (no escalation)', () => {
    const parent = ['fs_read_file', 'web_'];
    const child = ['fs_read_file', 'fs_delete_file', 'web_search', 'browser_click'];
    expect(intersectToolScopes(parent, child)).toEqual(['fs_read_file', 'web_search']);
  });
});
