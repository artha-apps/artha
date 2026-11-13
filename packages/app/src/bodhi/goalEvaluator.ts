/**
 * Independent goal evaluator + the ReAct-loop stop gate.
 *
 * When a run tries to finish while its session has an active goal, the model's
 * "I'm done" is treated as a CLAIM, not a fact. This module decides whether the
 * goal's condition is actually met, from evidence the system collected:
 *
 *   1. Deterministic acceptance criteria first (bodhi/criteria.ts — closed
 *      predicates checked on disk). A required criterion that failed is
 *      decisive: `unmet`, no model consulted.
 *   2. Then a SEPARATE judge call — its own prompt, no tools, ideally a
 *      different model from the actor — which must answer in strict JSON and
 *      cite evidence ids it was actually shown.
 *
 * Fail-closed rules: an unparseable answer, a judge error, a `met` that cites
 * no real evidence, or a `met` while any criterion is indeterminate all yield
 * `unknown` — never `met`.
 *
 * The gate (`applyStopGate`) then maps the verdict to an action and records the
 * evidence trail so `deriveDelegateOutcome` projects it honestly.
 */
import type { CriterionOutcome } from './taskModel';
import type { GoalsDb, Goal } from './goals';
import { markGoalCompletedByEvaluator, markGoalBlockedByEvaluator, recordGoalVerdict } from './goals';
import { ensureRunTask } from './criteria';
import { recordEvidence } from './runFacts';

/** The evaluator's answer. `evidence_refs` are ids from the evidence list it was shown. */
export interface GoalVerdict {
  verdict: 'met' | 'unmet' | 'unknown';
  gaps: string[];
  evidence_refs: string[];
  /** Which stage decided: deterministic criteria, the judge model, or neither. */
  source: 'criteria' | 'judge' | 'none';
}

/** A deterministic criterion result as the evaluator consumes it. */
export interface EvaluatedCriterion {
  description: string;
  outcome: CriterionOutcome;
  required: boolean;
}

/** One piece of run evidence (sanitized, short) shown to the judge. */
export interface EvaluatorEvidence {
  /** Stable id the judge cites, e.g. "E3". Assigned by `numberEvidence`. */
  id: string;
  kind: string;
  status: string;
  summary: string;
}

/** Everything the evaluator looks at. */
export interface EvaluatorInput {
  objective: string;
  condition: string;
  runFacts: { toolCallsTotal: number; toolCallsFailed: number; mutationsTotal: number; mutationsFailed: number };
  criteria: EvaluatedCriterion[];
  evidence: EvaluatorEvidence[];
  /** The model's final message — the deliverable for answer-type goals. */
  finalAnswer?: string;
}

/** A judge is any function that takes chat messages and returns raw text.
 *  Injected so tests can drive every branch without a model. */
export type JudgeFn = (messages: Array<{ role: 'system' | 'user'; content: string }>) => Promise<string>;

const MAX_GAPS = 8;
const MAX_GAP_LEN = 240;
const MAX_ANSWER = 2000;

/** Assign E1..En ids to raw evidence items (most recent last). */
export function numberEvidence(items: Array<Omit<EvaluatorEvidence, 'id'>>): EvaluatorEvidence[] {
  return items.map((e, i) => ({ ...e, id: `E${i + 1}` }));
}

/** Id under which the final answer is offered to the judge as evidence. */
export const ANSWER_EVIDENCE_ID = 'ANSWER';

/** The judge's system prompt — distinct from the actor's, and adversarial by design. */
export const JUDGE_SYSTEM_PROMPT =
  'You are an independent completion checker. You did not do this work and you have no tools. ' +
  'Decide ONLY from the evidence listed whether the CONDITION is satisfied. An agent saying it ' +
  'did something is NOT evidence that it happened; only tool results and checks are. If the ' +
  'evidence is insufficient, the verdict is "unmet". Reply with ONE JSON object and nothing else: ' +
  '{"verdict":"met"|"unmet","gaps":["what is still missing"],"evidence_refs":["E1"]}. ' +
  '"evidence_refs" must cite ids from the list that prove the condition.';

/** Build the judge's messages. Pure — exported for tests and inspection. */
export function buildJudgeMessages(input: EvaluatorInput): Array<{ role: 'system' | 'user'; content: string }> {
  const lines: string[] = [
    `OBJECTIVE: ${input.objective}`,
    `CONDITION (what "done" means): ${input.condition}`,
    '',
    `RUN FACTS: ${input.runFacts.toolCallsTotal} tool call(s), ${input.runFacts.toolCallsFailed} failed; ` +
      `${input.runFacts.mutationsTotal} change(s) attempted, ${input.runFacts.mutationsFailed} failed.`,
    '',
    'DETERMINISTIC CHECKS:',
    ...(input.criteria.length
      ? input.criteria.map(c => `- ${c.description}: ${c.outcome}`)
      : ['- (none applicable)']),
    '',
    'EVIDENCE:',
    ...(input.evidence.length
      ? input.evidence.map(e => `${e.id} [${e.kind}, ${e.status}] ${e.summary}`)
      : ['(no tool evidence)']),
  ];
  if (input.finalAnswer?.trim()) {
    lines.push(
      '',
      `${ANSWER_EVIDENCE_ID} — the agent's final answer. It counts as evidence only of its own text ` +
        '(e.g. when the condition is that an answer or summary is given), never of actions taken:',
      input.finalAnswer.trim().slice(0, MAX_ANSWER),
    );
  }
  return [
    { role: 'system', content: JUDGE_SYSTEM_PROMPT },
    { role: 'user', content: lines.join('\n') },
  ];
}

/** Clean, bound and dedupe a gap list from untrusted model output. */
function cleanGaps(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const g of raw) {
    if (typeof g !== 'string') continue;
    const t = g.trim().slice(0, MAX_GAP_LEN);
    if (t && !out.includes(t)) out.push(t);
    if (out.length >= MAX_GAPS) break;
  }
  return out;
}

/**
 * Parse the judge's raw text. Fail-closed: anything other than a well-formed
 * object with verdict "met"/"unmet" is `unknown`, and a "met" must cite at
 * least one evidence id that was actually offered (`validRefs`).
 */
export function parseJudgeOutput(text: string, validRefs: ReadonlySet<string>): GoalVerdict {
  const unknown = (gap: string): GoalVerdict => ({ verdict: 'unknown', gaps: [gap], evidence_refs: [], source: 'judge' });
  if (typeof text !== 'string' || !text.trim()) return unknown('The independent check returned nothing.');
  // Tolerate code fences / a sentence of preamble: take the outermost {...}.
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return unknown('The independent check did not return a readable verdict.');
  let obj: Record<string, unknown>;
  try {
    const parsed = JSON.parse(text.slice(start, end + 1)) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
    obj = parsed as Record<string, unknown>;
  } catch {
    return unknown('The independent check did not return a readable verdict.');
  }
  const v = typeof obj.verdict === 'string' ? obj.verdict.trim().toLowerCase() : '';
  const gaps = cleanGaps(obj.gaps);
  const refs = Array.isArray(obj.evidence_refs)
    ? obj.evidence_refs.filter((r): r is string => typeof r === 'string').map(r => r.trim()).filter(r => validRefs.has(r))
    : [];
  if (v === 'met') {
    // A "met" with nothing real behind it is not a verdict we can act on.
    if (!refs.length) return unknown('The independent check said "met" but cited no evidence.');
    return { verdict: 'met', gaps: [], evidence_refs: [...new Set(refs)], source: 'judge' };
  }
  if (v === 'unmet') {
    return {
      verdict: 'unmet',
      gaps: gaps.length ? gaps : ['The independent check found the condition not yet met.'],
      evidence_refs: [...new Set(refs)],
      source: 'judge',
    };
  }
  return unknown('The independent check did not return a readable verdict.');
}

/**
 * Evaluate a goal's condition. Deterministic criteria first; then the judge.
 * Never throws; never returns `met` without the judge citing real evidence.
 */
export async function evaluateGoal(input: EvaluatorInput, judge: JudgeFn | null): Promise<GoalVerdict> {
  const required = input.criteria.filter(c => c.required);
  const failed = required.filter(c => c.outcome === 'failed');
  if (failed.length) {
    // A machine check disagrees with the claim — decisive, no model needed.
    return {
      verdict: 'unmet',
      gaps: failed.slice(0, MAX_GAPS).map(c => `Check failed: ${c.description}`.slice(0, MAX_GAP_LEN)),
      evidence_refs: [],
      source: 'criteria',
    };
  }
  if (!judge) {
    return { verdict: 'unknown', gaps: ['No model was available for the independent check.'], evidence_refs: [], source: 'none' };
  }
  const validRefs = new Set(input.evidence.map(e => e.id));
  if (input.finalAnswer?.trim()) validRefs.add(ANSWER_EVIDENCE_ID);
  let verdict: GoalVerdict;
  try {
    verdict = parseJudgeOutput(await judge(buildJudgeMessages(input)), validRefs);
  } catch {
    return { verdict: 'unknown', gaps: ['The independent check could not run.'], evidence_refs: [], source: 'judge' };
  }
  // "met" must rest on at least one SUCCEEDED tool result. The final answer is
  // the agent's own claim and failed results prove nothing, so an ANSWER-only
  // or failed-only citation is not enough to complete a goal.
  if (verdict.verdict === 'met') {
    const succeeded = new Set(input.evidence.filter(e => e.status === 'succeeded').map(e => e.id));
    if (!verdict.evidence_refs.some(r => succeeded.has(r))) {
      return {
        verdict: 'unknown',
        gaps: ['The independent check said "met" but cited no successful action — only the answer\'s own claim or failed steps.'],
        evidence_refs: verdict.evidence_refs,
        source: 'judge',
      };
    }
  }
  // A check we could not complete (permissions/IO) means we cannot call it met.
  if (verdict.verdict === 'met' && required.some(c => c.outcome === 'indeterminate')) {
    return {
      verdict: 'unknown',
      gaps: required.filter(c => c.outcome === 'indeterminate').map(c => `Could not check: ${c.description}`),
      evidence_refs: verdict.evidence_refs,
      source: 'judge',
    };
  }
  return verdict;
}

// ── Stop gate ──────────────────────────────────────────────────────────────

/** How many times an `unmet` verdict sends the model back with feedback. */
export const MAX_GOAL_FEEDBACK_ROUNDS = 2;

/** What the loop should do with this final answer. */
export type StopGateAction =
  /** Goal met — finish normally; the goal is now completed. */
  | 'complete'
  /** Goal unmet with rounds left — push `feedback` and keep looping. */
  | 'continue'
  /** Stop and hand to the user ("Needs you"), listing the gaps. */
  | 'needs_review';

/** Pure decision table — the policy in one place. */
export function decideStopGate(verdict: GoalVerdict['verdict'], roundsUsed: number, maxRounds = MAX_GOAL_FEEDBACK_ROUNDS): StopGateAction {
  if (verdict === 'met') return 'complete';
  if (verdict === 'unmet' && roundsUsed < maxRounds) return 'continue';
  // Exhausted `unmet`, or `unknown` (another round can't fix an unjudgeable check).
  return 'needs_review';
}

/**
 * Should a goal that is already `blocked` be checked again when this run ends?
 *
 * A blocked goal used to short-circuit the gate forever: every later run
 * repeated the stored reason. So after "needs you — the file does not exist",
 * a user who replied "ok, create it" got a run that created the file AND a
 * note still saying it does not exist (live QA, 2026-11-13).
 *
 * Re-check only when the block PREDATES this run (this run is the user's next
 * turn, not the run in which the model said it was blocked) and the run did
 * real work. The check itself is the normal evaluator, so completion still
 * needs a `met` verdict backed by a succeeded tool result.
 */
export function shouldRecheckBlockedGoal(i: {
  goalUpdatedAtMs: number; runStartedAtMs: number | null; succeededWork: boolean;
}): boolean {
  return i.runStartedAtMs != null && i.goalUpdatedAtMs < i.runStartedAtMs && i.succeededWork;
}

/** The system message that sends an unmet goal back to the model. */
export function goalFeedbackMessage(goal: Pick<Goal, 'condition'>, gaps: string[], round: number, maxRounds = MAX_GOAL_FEEDBACK_ROUNDS): string {
  return (
    `An independent check found the goal NOT yet met (attempt ${round} of ${maxRounds}). ` +
    `Condition: "${goal.condition.slice(0, 300)}". Still missing:\n` +
    gaps.map(g => `- ${g}`).join('\n') +
    `\nContinue working with tools to close these gaps, then finish. If you cannot proceed without ` +
    `the user, call goal_update with status "blocked" and the reason.`
  );
}

/** Result of `applyStopGate`, for the loop and for tests. */
export interface StopGateResult {
  action: StopGateAction;
  gaps: string[];
  /** Ready-to-send feedback when action === 'continue'. */
  feedback?: string;
  goal: Goal | null;
}

/**
 * Apply a verdict at the stop gate: update the goal, record the evidence trail,
 * and (for needs_review) attach the gaps to the run's task as prose criteria so
 * `deriveDelegateOutcome` projects "needs review" with the gaps as remaining
 * work. Best-effort on bookkeeping; the returned action is always valid.
 */
export function applyStopGate(
  db: GoalsDb,
  opts: { goal: Goal; verdict: GoalVerdict; roundsUsed: number; runId: string; sessionId: string; objective: string; now?: number },
): StopGateResult {
  const { goal, verdict } = opts;
  const action = decideStopGate(verdict.verdict, opts.roundsUsed);
  let taskId: string | null = null;
  try { taskId = ensureRunTask(db, { runId: opts.runId, sessionId: opts.sessionId, goal: opts.objective }); } catch { /* evidence below is best-effort */ }

  // The model ended its turn as if done, but the verdict isn't `met`.
  if (verdict.verdict !== 'met') {
    recordEvidence(db, {
      taskId, runId: opts.runId, kind: 'false_completion_attempt', ref: goal.goalId,
      status: verdict.verdict === 'unknown' ? 'unknown' : 'failed',
      summary: `Run tried to finish but goal check was ${verdict.verdict}: ${verdict.gaps.join('; ')}`,
    });
  }

  let updated: Goal | null = goal;
  try {
    if (action === 'complete') {
      updated = markGoalCompletedByEvaluator(db, goal.goalId, verdict, opts.now);
      recordEvidence(db, {
        taskId, runId: opts.runId, kind: 'model_assessment', ref: goal.goalId, status: 'succeeded',
        summary: `Goal check met (${verdict.source}); evidence: ${verdict.evidence_refs.join(', ') || 'criteria'}`,
      });
    } else if (action === 'continue') {
      updated = recordGoalVerdict(db, goal.goalId, verdict, opts.now);
    } else if (verdict.verdict === 'unmet') {
      updated = markGoalBlockedByEvaluator(
        db, goal.goalId, verdict,
        `Needs you — not met after ${opts.roundsUsed} feedback round(s): ${verdict.gaps.join('; ')}`.slice(0, 500),
        opts.now,
      );
    } else {
      updated = recordGoalVerdict(db, goal.goalId, verdict, opts.now);
    }
  } catch { /* a finished/removed goal — keep the action, skip the write */ }

  if (action === 'needs_review' && taskId) {
    addGoalGapCriteria(db, taskId, verdict.verdict === 'unknown' ? 'awaiting_user_review' : 'failed',
      verdict.gaps.length ? verdict.gaps : [`Goal: ${goal.condition}`]);
  }

  return {
    action,
    gaps: verdict.gaps,
    feedback: action === 'continue' ? goalFeedbackMessage(goal, verdict.gaps, opts.roundsUsed + 1) : undefined,
    goal: updated,
  };
}

/**
 * Attach gaps to the run's task as PROSE criteria. Prose can never verify
 * (taskModel), so this caps the run at "needs review" and surfaces each gap
 * as remaining work, without touching any predicate result.
 */
export function addGoalGapCriteria(db: GoalsDb, taskId: string, outcome: 'failed' | 'awaiting_user_review', gaps: string[]): void {
  try {
    const insert = db.prepare(
      `INSERT INTO task_acceptance_criteria (task_id, kind, predicate, inputs_json, description, required, outcome, evaluated_at)
       VALUES (?, 'prose', NULL, '{}', ?, 1, ?, unixepoch())`
    );
    for (const g of gaps.slice(0, MAX_GAPS)) insert.run(taskId, `Goal gap: ${g}`.slice(0, 300), outcome);
  } catch { /* bookkeeping must never break a run */ }
}
