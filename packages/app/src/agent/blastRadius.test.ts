/**
 * Tests for the pre-flight blast-radius estimator. Pure heuristic — verifies it
 * counts destructive vs additive ops, flags irreversibility, and detects web.
 */
import { describe, it, expect } from 'vitest';
import { estimateBlastRadius } from './blastRadius';
import type { WorkflowStep } from './orchestrator';

const step = (description: string, toolName?: string): WorkflowStep => ({
  index: 0, description, toolName, status: 'pending',
});

describe('estimateBlastRadius', () => {
  it('counts deletions and marks the plan not reversible', () => {
    const br = estimateBlastRadius([
      step('list the folder', 'fs_list_directory'),
      step('delete the old file', 'fs_delete_file'),
    ]);
    expect(br.deletions).toBe(1);
    expect(br.reversible).toBe(false);
    expect(br.summary).toContain('NOT reversible');
  });

  it('a move-only plan is reversible', () => {
    const br = estimateBlastRadius([
      step('move screenshots', 'fs_move_batch'),
    ]);
    expect(br.moves).toBe(1);
    expect(br.deletions).toBe(0);
    expect(br.reversible).toBe(true);
  });

  it('detects web access from tool names', () => {
    const br = estimateBlastRadius([step('fetch the page', 'web_fetch')]);
    expect(br.touchesWeb).toBe(true);
  });

  it('detects web intent from the goal even when steps are vague', () => {
    const br = estimateBlastRadius([step('do the thing')], 'look up the latest news online');
    expect(br.touchesWeb).toBe(true);
  });

  it('flags delegation to a sub-capability', () => {
    const br = estimateBlastRadius([step('delegate research', 'invoke_capability')]);
    expect(br.delegates).toBe(true);
  });

  it('falls back to scanning the description when toolName is absent', () => {
    const br = estimateBlastRadius([step('delete all the temp files')]);
    expect(br.deletions).toBe(1);
  });

  it('token estimate grows with step count and web payloads', () => {
    const small = estimateBlastRadius([step('one', 'fs_list_directory')]);
    const big = estimateBlastRadius([
      step('one', 'fs_list_directory'),
      step('two', 'web_fetch'),
      step('three', 'fs_move_file'),
    ]);
    expect(big.estTokens).toBeGreaterThan(small.estTokens);
  });
});
