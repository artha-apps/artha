/** Delegate parity helpers (lib/delegateParity.ts): outbox composer + plan step comments. */
import { describe, it, expect } from 'vitest';
import {
  isDelegateRunning, delegateComposerMode, delegateComposerPlaceholder, shouldFollowRun,
  draftsToComments, delegatePlanReviewOutcome,
} from './delegateParity';

describe('Delegate outbox composer', () => {
  it('sends when no run is active and queues while one is', () => {
    expect(delegateComposerMode('completed', 's1', null)).toBe('send');
    expect(delegateComposerMode('needs_review', 's1', { active: false })).toBe('send');
    expect(delegateComposerMode('executing', 's1', null)).toBe('queue');
    // Main's outbox driver says a run is active even if the view thinks it ended.
    expect(delegateComposerMode('completed', 's1', { active: true })).toBe('queue');
  });

  it('is disabled while a run starts with no session to queue into', () => {
    expect(delegateComposerMode('understanding', null, null)).toBe('disabled');
    expect(delegateComposerPlaceholder('disabled')).toMatch(/starting/);
    expect(delegateComposerPlaceholder('queue')).toMatch(/queued/);
  });

  it('treats the awaiting-approval gate and terminal states as not running', () => {
    for (const s of ['idle', 'completed', 'needs_review', 'failed', 'awaiting_confirmation'] as const) {
      expect(isDelegateRunning(s)).toBe(false);
    }
    for (const s of ['understanding', 'planning', 'executing', 'reviewing'] as const) {
      expect(isDelegateRunning(s)).toBe(true);
    }
  });

  it('follows a drained run only for the task on screen and only once', () => {
    expect(shouldFollowRun({ sessionId: 's1', runId: 'r1' }, { sessionId: 's1', runId: 'r2' })).toBe(true);
    expect(shouldFollowRun({ sessionId: 's1', runId: 'r2' }, { sessionId: 's1', runId: 'r2' })).toBe(false);
    expect(shouldFollowRun({ sessionId: 's1', runId: 'r1' }, { sessionId: 's2', runId: 'r9' })).toBe(false);
    expect(shouldFollowRun({ sessionId: null, runId: null }, { sessionId: 's1', runId: 'r9' })).toBe(false);
  });
});

describe('Delegate plan step comments', () => {
  const plan = { goal: 'Email the Q3 summary to Priya', steps: [
    { index: 0, description: 'Draft the summary' },
    { index: 1, description: 'Send the email' },
  ] };

  it('turns drafts into S5 comments, dropping empty ones', () => {
    expect(draftsToComments(plan, { 0: '  use bullet points ', 1: '   ' })).toEqual([
      { step_index: 0, original_text: 'Draft the summary', comment: 'use bullet points' },
    ]);
  });

  it('accept runs the original goal unchanged', () => {
    expect(delegatePlanReviewOutcome(plan, { decision: 'accept' })).toEqual({ kind: 'run', goal: plan.goal, notes: null });
  });

  it('accept with comments carries the notes into the run instead of re-planning', () => {
    const out = delegatePlanReviewOutcome(plan, {
      decision: 'accept_with_comments',
      comments: [{ step_index: 1, original_text: 'Send the email', comment: 'cc me' }],
    });
    expect(out.kind).toBe('run');
    if (out.kind !== 'run') return;
    expect(out.goal.startsWith(plan.goal)).toBe(true);
    expect(out.notes).toContain('Step 2 ("Send the email"): cc me');
    expect(out.goal).toContain(out.notes!);
  });

  it('reject (or an unknown decision) never runs the task', () => {
    expect(delegatePlanReviewOutcome(plan, { decision: 'reject', reason: 'wrong person' })).toEqual({ kind: 'reject', reason: 'wrong person' });
    expect(delegatePlanReviewOutcome(plan, { decision: 'bogus' as never }).kind).toBe('reject');
  });
});
