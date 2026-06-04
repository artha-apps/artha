/**
 * Act-guard — the "stop narrating, actually drive the browser" backstop.
 *
 * Small local models love to ANSWER a web-action request ("here's how you'd
 * send that email…") instead of DOING it. The ReAct loop ends the moment the
 * model returns plain text instead of a tool call, so that narration becomes
 * the final answer and nothing happens.
 *
 * These two pure functions are the decision seam the orchestrator uses to catch
 * that: detect when the user asked Artha to act on a website, and decide whether
 * a plain-text reply should be rejected (nudge + keep looping) instead of
 * accepted. Kept pure + dependency-free so the behaviour is unit-testable
 * without standing up the whole Electron/LLM/DB stack.
 */

/** Does the goal ask Artha to DO something on a website / in mail (send an
 *  email, submit a form, post, book…)? Deliberately narrow — the nudge it gates
 *  only ever fires when the model also made ZERO browser tool calls, so a false
 *  positive here is still harmless on a task the model handled some other way. */
export function detectsWebAction(goal: string): boolean {
  return (
    /\b(send|compose|reply|forward|write)\b[\s\S]{0,40}\b(e-?mails?|mail|messages?|gmail|outlook)\b/i.test(goal) ||
    /\b(fill|submit|complete)\b[\s\S]{0,24}\bforms?\b/i.test(goal) ||
    /\b(post|publish|tweet|comment|book|order|checkout|add to cart|sign in|log ?in)\b/i.test(goal) ||
    /\bin the browser\b|\bon (the )?(website|site|web ?page)\b/i.test(goal)
  );
}

/** Inputs the orchestrator feeds the guard at the moment the model returns a
 *  plain-text (no-tool-call) reply. */
export interface ActGuardState {
  /** The original user goal — tested for web-action intent. */
  goal: string;
  /** How many browser_* tools the model has called so far this run. */
  browserToolCalls: number;
  /** How many real mutations (file moves, etc.) happened this run. */
  mutationCount: number;
  /** How many act-nudges we've already injected this run. */
  nudges: number;
  /** Hard cap on nudges so a model that truly can't proceed still terminates. */
  maxNudges: number;
  /** The raw text the model just returned. */
  content: string;
}

/**
 * True when the plain-text reply should be REJECTED and replaced with an
 * "actually act" nudge. Fires only when:
 *   - the goal was a web-action request, AND
 *   - the model never drove the browser, AND
 *   - nothing else actually happened (no mutations), AND
 *   - we're under the nudge cap, AND
 *   - the reply isn't a genuine clarifying question (contains no "?").
 */
export function shouldNudgeToAct(s: ActGuardState): boolean {
  return (
    s.browserToolCalls === 0 &&
    s.mutationCount === 0 &&
    s.nudges < s.maxNudges &&
    !s.content.includes('?') &&
    detectsWebAction(s.goal)
  );
}
