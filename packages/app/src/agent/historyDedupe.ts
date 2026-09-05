/**
 * History de-duplication for the ReAct prompt.
 *
 * The renderer persists the user's message to `messages` BEFORE the
 * orchestrator runs, so `getSessionHistory()` already ends with the current
 * request — and the loop then appends the goal again as the final user turn.
 * The model therefore saw every request twice (verbatim), which wastes context
 * (on a 72B local model every extra token is ~17 ms of prompt eval) and reads
 * to the model like the user repeating themselves. This pure helper drops that
 * trailing echo and nothing else.
 */
import type OpenAI from 'openai';

/** Strip a leading "/slug " skill invocation so "/organize tidy ~/Desktop"
 *  compares equal to the slug-stripped goal "tidy ~/Desktop". */
function stripSlash(text: string): string {
  return text.replace(/^\/\S+\s*/, '').trim();
}

/** Remove the last history entry when it is the user's current request —
 *  exact match, slash-stripped match, or the goal is an enriched form of it
 *  (goal + clarification Q&A appended). Any other shape is returned unchanged. */
export function dropEchoedGoal(
  history: OpenAI.ChatCompletionMessageParam[],
  goal: string | undefined,
): OpenAI.ChatCompletionMessageParam[] {
  if (!goal || history.length === 0) return history;
  const last = history[history.length - 1];
  if (last.role !== 'user' || typeof last.content !== 'string') return history;
  const persisted = last.content.trim();
  const g = goal.trim();
  if (!persisted) return history;
  const echoed =
    persisted === g ||
    stripSlash(persisted) === g ||
    g.startsWith(persisted) ||
    g.startsWith(stripSlash(persisted));
  return echoed ? history.slice(0, -1) : history;
}
