/**
 * Adversarial false-completion suite (Phase A.5).
 *
 * Every case is built to induce a confident-but-unsupported success claim.
 * **The deterministic false-completion rate must be zero**: no fixture below
 * may produce `isComplete === true` unless the objective is genuinely verified.
 */
import { describe, it, expect } from 'vitest';
import {
  userFacingOutcome, deriveVerification, deriveTaskStatus, legacyStatusToOutcome,
  isVerifiablePredicate, type TaskFacts, type Criterion, type RunFacts,
} from './taskModel';

const run = (o: Partial<RunFacts> = {}): RunFacts => ({
  outcome: 'succeeded', toolCallsTotal: 0, toolCallsFailed: 0, toolCallsBlocked: 0,
  mutationsTotal: 0, mutationsFailed: 0, ...o,
});
const facts = (o: Partial<TaskFacts> = {}): TaskFacts => ({
  run: run(), criteria: [], acceptanceMode: 'system_verified',
  externalActionStates: [], evidenceCount: 0, ...o,
});
const predicate = (outcome: Criterion['outcome'], description = 'report.docx exists'): Criterion =>
  ({ kind: 'predicate', predicate: 'file_exists', description, required: true, outcome });
const prose = (description = 'Make the proposal compelling'): Criterion =>
  ({ kind: 'prose', predicate: null, description, required: true, outcome: 'awaiting_user_review' });

/** The bar: nothing in this file may claim completion without verification. */
const assertNotComplete = (f: TaskFacts) => {
  const out = userFacingOutcome(f);
  expect(out.isComplete, `false completion: ${out.label} — ${out.message}`).toBe(false);
  expect(out.taskStatus).not.toBe('completed');
  expect(out.message.toLowerCase()).not.toMatch(/\bsuccessfully completed\b|\beverything is done\b/);
  return out;
};

describe('adversarial: the model claims done, the evidence does not', () => {
  it('no run was created because approval is required', () => {
    const out = assertNotComplete(facts({ run: run({ approvalRequired: true }) }));
    expect(out.taskStatus).toBe('awaiting_approval');
    expect(out.message).toMatch(/No consequential action was performed/i);
    expect(out.requiredUserAction).toBeTruthy();
  });

  it('every tool call failed but the executor finished', () => {
    const out = assertNotComplete(facts({ run: run({ toolCallsTotal: 4, toolCallsFailed: 4 }) }));
    expect(out.taskStatus).toBe('partially_completed');
    expect(out.message).toMatch(/every tool call failed/i);
  });

  it('one tool succeeded and one failed', () => {
    const out = assertNotComplete(facts({ run: run({ toolCallsTotal: 2, toolCallsFailed: 1 }) }));
    expect(out.message).toMatch(/1 failed tool call/i);
  });

  it('model stopped requesting tools before the objective was met', () => {
    // Executor "succeeded", required artifact criterion never evaluated.
    const out = assertNotComplete(facts({ criteria: [predicate('not_evaluated')] }));
    expect(out.verification).toBe('unverified');
    expect(out.remainingWork).toContain('report.docx exists');
  });

  it('no output was produced at all', () => {
    assertNotComplete(facts({ run: run({ toolCallsTotal: 0 }), evidenceCount: 0 }));
  });

  it('required artifact is missing', () => {
    const out = assertNotComplete(facts({ criteria: [predicate('failed')] }));
    expect(out.verification).toBe('verification_failed');
    expect(out.taskStatus).toBe('blocked');
  });

  it('test command fails', () => {
    const out = assertNotComplete(facts({
      criteria: [{ kind: 'predicate', predicate: 'test_suite_passed', description: 'unit tests pass', required: true, outcome: 'failed' }],
    }));
    expect(out.taskStatus).toBe('blocked');
  });

  it('external action outcome is unknown', () => {
    const out = assertNotComplete(facts({
      criteria: [predicate('passed')], externalActionStates: ['outcome_unknown'],
    }));
    expect(out.verification).toBe('unverified');
    expect(out.message).toMatch(/could not be confirmed/i);
  });

  it('run interrupted by app quit', () => {
    const out = assertNotComplete(facts({ run: run({ outcome: 'interrupted' }) }));
    expect(out.message).toMatch(/interrupted/i);
  });

  it('orphaned running status after restart is never complete', () => {
    const out = assertNotComplete(facts({ run: run({ outcome: 'running' }) }));
    expect(out.taskStatus).toBe('active');
  });

  it('run timed out', () => {
    const out = assertNotComplete(facts({ run: run({ outcome: 'timed_out' }) }));
    expect(out.message).toMatch(/time limit/i);
  });

  it('scheduler path returned without throwing but performed no work', () => {
    // The exact S1/S2 shape: executor "succeeded", zero tools, zero evidence.
    const out = assertNotComplete(facts({ run: run({ toolCallsTotal: 0 }), criteria: [] }));
    expect(out.taskStatus).toBe('partially_completed');
    expect(out.message).toMatch(/not verified/i);
  });

  it('legacy completed run with no evidence is never relabelled verified', () => {
    const out = assertNotComplete(facts({ legacy: true }));
    expect(out.verification).toBe('unknown_legacy');
    expect(out.message).toMatch(/predates verification/i);
  });

  it('all consequential tools blocked as unattended', () => {
    assertNotComplete(facts({ run: run({ toolCallsTotal: 3, toolCallsBlocked: 3 }) }));
  });
});

describe('subjective work never self-verifies', () => {
  it('prose criteria cap at awaiting_user_review even when everything else passed', () => {
    const out = userFacingOutcome(facts({ criteria: [predicate('passed'), prose()] }));
    expect(out.isComplete).toBe(false);
    expect(out.verification).toBe('awaiting_user_review');
    expect(out.message).toMatch(/ready for your review/i);
  });

  it('a prose-only task is review-gated, never verified', () => {
    const out = userFacingOutcome(facts({ criteria: [prose('Write a strong proposal')] }));
    expect(out.verification).toBe('awaiting_user_review');
    expect(out.isComplete).toBe(false);
  });

  it('the predicate vocabulary is closed', () => {
    expect(isVerifiablePredicate('file_exists')).toBe(true);
    expect(isVerifiablePredicate('looks_good')).toBe(false);
    expect(isVerifiablePredicate(null)).toBe(false);
    // A "predicate" criterion naming an unregistered check cannot verify.
    const out = userFacingOutcome(facts({
      criteria: [{ kind: 'predicate', predicate: 'looks_good', description: 'looks good', required: true, outcome: 'passed' }],
    }));
    expect(out.isComplete).toBe(false);
  });
});

describe('the ONE path to completion', () => {
  it('all required machine-checkable criteria passed, no prose, no unknowns', () => {
    const out = userFacingOutcome(facts({
      criteria: [predicate('passed'), {
        kind: 'predicate', predicate: 'test_suite_passed', description: 'tests pass', required: true, outcome: 'passed',
      }],
      externalActionStates: ['confirmed'], evidenceCount: 3,
    }));
    expect(out.isComplete).toBe(true);
    expect(out.taskStatus).toBe('completed');
    expect(out.verification).toBe('verified');
    expect(out.remainingWork).toEqual([]);
  });

  it('user_accepted mode stays open even when fully verified', () => {
    const out = userFacingOutcome(facts({
      criteria: [predicate('passed')], acceptanceMode: 'user_accepted',
    }));
    expect(out.isComplete).toBe(false);
    expect(out.taskStatus).toBe('awaiting_user_review');
  });

  it('optional criteria do not block completion', () => {
    const out = userFacingOutcome(facts({
      criteria: [predicate('passed'), { ...prose(), required: false }],
    }));
    expect(out.isComplete).toBe(true);
  });
});

describe('legacy mapping preserves honesty', () => {
  it('legacy completed means the executor finished, not that the objective is done', () => {
    expect(legacyStatusToOutcome('completed')).toBe('succeeded');
    expect(legacyStatusToOutcome('failed')).toBe('failed');
    expect(legacyStatusToOutcome('cancelled')).toBe('cancelled');
    expect(legacyStatusToOutcome('running')).toBe('running');
    expect(legacyStatusToOutcome(null)).toBe('queued');
  });

  it('a succeeded run with zero evidence is never verified', () => {
    expect(deriveVerification(facts())).toBe('not_evaluated');
    expect(deriveTaskStatus(facts(), 'not_evaluated')).toBe('partially_completed');
  });
});

describe('illegal combinations are unreachable', () => {
  it('a failed run can never be verified-complete', () => {
    for (const v of ['verified', 'awaiting_user_review', 'not_evaluated'] as const) {
      expect(deriveTaskStatus(facts({ run: run({ outcome: 'failed' }) }), v)).toBe('failed');
    }
  });

  it('completion requires zero unresolved required criteria', () => {
    const out = userFacingOutcome(facts({ criteria: [predicate('passed'), predicate('not_evaluated', 'summary.pdf exists')] }));
    expect(out.isComplete).toBe(false);
    expect(out.remainingWork).toContain('summary.pdf exists');
  });
});
