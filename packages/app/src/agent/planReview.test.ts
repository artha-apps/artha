/**
 * Plan review decision tests (agent/planReview.ts):
 *   - step comments reach the planner's revision prompt verbatim;
 *   - the planner revises at most once, later comments ride into execution;
 *   - Reject (or anything unrecognised) never yields an executing/completed
 *     outcome — it is always cancelled.
 */
import { describe, it, expect } from 'vitest';
import { decidePlanReview, buildPlanRevisionPrompt, buildExecutorReviewBlock, buildReviewNotes, sanitizeComments, type PlanReview } from './planReview';

const steps = [
  { index: 0, description: 'List files in ~/Desktop', toolName: 'fs_list_directory' },
  { index: 1, description: 'Delete old screenshots', toolName: 'fs_delete_file' },
];
const goal = 'Tidy my desktop';

describe('plan review', () => {
  it('step comments reach the revision prompt', () => {
    const action = decidePlanReview(
      { decision: 'accept_with_comments', comments: [{ step_index: 1, original_text: '', comment: 'Move them to Archive instead of deleting' }] },
      { goal, steps, revisions: 0 },
    );
    expect(action.kind).toBe('revise');
    if (action.kind !== 'revise') return;
    expect(action.revisionPrompt).toContain(goal);
    expect(action.revisionPrompt).toContain('Step 2 ("Delete old screenshots"): Move them to Archive instead of deleting');
    expect(action.revisionPrompt).toContain('1. List files in ~/Desktop [fs_list_directory]');
  });

  it('revises only once; later comments are carried into execution', () => {
    const review: PlanReview = { decision: 'accept_with_comments', comments: [{ step_index: 0, original_text: 'x', comment: 'Include hidden files' }] };
    const action = decidePlanReview(review, { goal, steps, revisions: 1 });
    expect(action).toEqual({ kind: 'execute', reviewNotes: expect.stringContaining('Include hidden files') });
  });

  it('accept with no usable comments just executes', () => {
    const action = decidePlanReview({ decision: 'accept_with_comments', comments: [{ step_index: 9, original_text: '', comment: 'bad index' }] }, { goal, steps, revisions: 0 });
    expect(action).toEqual({ kind: 'execute', reviewNotes: null });
    expect(decidePlanReview({ decision: 'accept' }, { goal, steps, revisions: 0 })).toEqual({ kind: 'execute', reviewNotes: null });
  });

  it('reject never yields completed — always cancelled with the reason', () => {
    const reviews: PlanReview[] = [
      { decision: 'reject', reason: 'Wrong folder' },
      { decision: 'reject' },
      { decision: 'reject', comments: [{ step_index: 0, original_text: '', comment: 'also this' }] },
      { decision: 'bogus' as PlanReview['decision'] },
    ];
    for (const r of reviews) {
      const action = decidePlanReview(r, { goal, steps, revisions: 0 });
      expect(action.kind).toBe('cancel');
      if (action.kind === 'cancel') expect(action.status).toBe('cancelled');
    }
    const first = decidePlanReview(reviews[0], { goal, steps, revisions: 0 });
    expect(first).toEqual({ kind: 'cancel', status: 'cancelled', reason: 'Wrong folder' });
  });

  it('sanitizeComments quotes the real step text and drops empties', () => {
    expect(sanitizeComments(steps, [
      { step_index: 0, original_text: 'spoofed', comment: '  keep  ' },
      { step_index: 1, original_text: '', comment: '   ' },
      'junk',
    ])).toEqual([{ step_index: 0, original_text: 'List files in ~/Desktop', comment: 'keep' }]);
    expect(buildPlanRevisionPrompt(goal, steps, [])).toContain('Current plan:');
  });
});

describe('buildExecutorReviewBlock (live QA 2026-11-13)', () => {
  const revised = [{ index: 0, description: 'Copy the file a.txt to plan-renamed.txt', toolName: 'fs_copy_file' }];
  const comment = { step_index: 0, original_text: 'Copy the file a.txt to plan-first.txt', comment: 'Name the copy plan-renamed.txt instead' };

  it('tells the executor the comment that revised the plan AND the approved steps, and which wins', () => {
    const block = buildExecutorReviewBlock({ steps: revised, revisionComments: [comment], reviewNotes: null });
    expect(block).toContain('Name the copy plan-renamed.txt instead');
    expect(block).toContain('1. Copy the file a.txt to plan-renamed.txt [fs_copy_file]');
    expect(block).toMatch(/the approved plan and the user's comments win/);
  });

  it('includes comments accepted without another revision', () => {
    const notes = buildReviewNotes([{ step_index: 0, original_text: 'x', comment: 'keep the originals' }]);
    const block = buildExecutorReviewBlock({ steps: revised, revisionComments: [], reviewNotes: notes });
    expect(block).toContain('keep the originals');
    expect(block).toContain('APPROVED PLAN');
  });

  it('adds nothing when the user left no comments', () => {
    expect(buildExecutorReviewBlock({ steps: revised, revisionComments: [], reviewNotes: null })).toBe('');
  });
});
