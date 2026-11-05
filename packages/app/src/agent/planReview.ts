/**
 * Plan review — Accept / Accept with comments / Reject for a paused plan.
 *
 * The user can attach a comment to a specific step. Comments go back to the
 * planner, which revises the plan ONCE and asks again. Reject ends the run as
 * cancelled-by-user — never as completed.
 *
 * Kept pure (no DB, no LLM) so the decision logic is unit-tested directly;
 * the orchestrator only performs the action it returns.
 */

/** A comment pinned to one step of the plan. */
export interface PlanStepComment {
  step_index: number;
  /** The step's text as shown when the user commented (so the planner sees
   *  exactly what the comment refers to even if indices shift on revision). */
  original_text: string;
  comment: string;
}

export type PlanReviewDecision = 'accept' | 'accept_with_comments' | 'reject';

/** What the renderer submits. */
export interface PlanReview {
  decision: PlanReviewDecision;
  comments?: PlanStepComment[];
  /** Reject reason (optional, shown in the chat and recorded). */
  reason?: string;
}

/** Minimal step shape used here. */
export interface ReviewStep { index: number; description: string; toolName?: string }

/** How many planner revisions a single plan may go through from comments. */
export const MAX_PLAN_REVISIONS = 1;

/** The action the orchestrator must take. `cancel` always carries
 *  status 'cancelled' — there is no path from a reject to 'completed'. */
export type PlanReviewAction =
  | { kind: 'execute'; reviewNotes: string | null }
  | { kind: 'revise'; revisionPrompt: string; comments: PlanStepComment[] }
  | { kind: 'cancel'; status: 'cancelled'; reason: string };

/** Drop empty comments and out-of-range indices; fill `original_text` from the
 *  plan so a comment always quotes the real step. */
export function sanitizeComments(steps: ReviewStep[], comments: unknown): PlanStepComment[] {
  if (!Array.isArray(comments)) return [];
  const out: PlanStepComment[] = [];
  for (const c of comments as Record<string, unknown>[]) {
    const idx = typeof c?.step_index === 'number' ? Math.trunc(c.step_index) : NaN;
    const text = typeof c?.comment === 'string' ? c.comment.trim().slice(0, 2000) : '';
    const step = steps.find(s => s.index === idx);
    if (!step || !text) continue;
    out.push({ step_index: idx, original_text: step.description, comment: text });
  }
  return out;
}

/** The instruction handed to the planner for the one revision. Includes the
 *  original goal, the current plan, and every step comment verbatim. */
export function buildPlanRevisionPrompt(goal: string, steps: ReviewStep[], comments: PlanStepComment[]): string {
  const plan = steps.map(s => `${s.index + 1}. ${s.description}${s.toolName ? ` [${s.toolName}]` : ''}`).join('\n');
  const notes = comments
    .map(c => `- Step ${c.step_index + 1} ("${c.original_text}"): ${c.comment}`)
    .join('\n');
  return `${goal}

The user reviewed your proposed plan and left comments on specific steps. Revise the plan so every comment is addressed, keeping steps that had no comment unless a comment requires changing them.

Current plan:
${plan}

User comments:
${notes}`;
}

/** Notes injected into the executor's system prompt when a plan is accepted
 *  with comments that will not trigger another revision. */
export function buildReviewNotes(comments: PlanStepComment[]): string | null {
  if (!comments.length) return null;
  return `The user approved the plan with these step comments — honour them while executing:\n${
    comments.map(c => `- Step ${c.step_index + 1} ("${c.original_text}"): ${c.comment}`).join('\n')}`;
}

/** Decide what a review means. `revisions` is how many comment-driven
 *  revisions this plan has already had. */
export function decidePlanReview(
  review: PlanReview,
  ctx: { goal: string; steps: ReviewStep[]; revisions: number },
): PlanReviewAction {
  if (review?.decision === 'reject') {
    const reason = typeof review.reason === 'string' && review.reason.trim() ? review.reason.trim().slice(0, 500) : '';
    return { kind: 'cancel', status: 'cancelled', reason };
  }
  if (review?.decision === 'accept_with_comments') {
    const comments = sanitizeComments(ctx.steps, review.comments);
    if (comments.length && ctx.revisions < MAX_PLAN_REVISIONS) {
      return { kind: 'revise', revisionPrompt: buildPlanRevisionPrompt(ctx.goal, ctx.steps, comments), comments };
    }
    return { kind: 'execute', reviewNotes: buildReviewNotes(comments) };
  }
  if (review?.decision === 'accept') return { kind: 'execute', reviewNotes: null };
  // Unknown decision: fail closed — do not run an unreviewed plan.
  return { kind: 'cancel', status: 'cancelled', reason: 'unrecognised review decision' };
}
