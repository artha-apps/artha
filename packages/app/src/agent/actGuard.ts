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

/** Does the goal ask Artha to SEND a message/email (a consequential delivery,
 *  not merely draft one)? Used to catch the "the model made a draft and called
 *  it done" false-completion: a send goal is only satisfied by an actual,
 *  confirmed send. Deliberately focused on send/deliver verbs + a mail/message
 *  object so it doesn't fire on "read my email". */
export function detectsSendIntent(goal: string): boolean {
  const g = goal || '';
  return (
    (/\b(send|deliver|fire off|shoot(?:\s+over)?|forward)\b/i.test(g) &&
      /\b(e-?mails?|mail|messages?|gmail|outlook|note|reply)\b/i.test(g)) ||
    /\bsend\s+(it|this|that|them|the (e-?mail|message|note|reply))\b/i.test(g) ||
    /\b(e-?mail|message)\s+\S+@\S+/i.test(g)   // "email jane@x.com …"
  );
}

/**
 * Extract {to, subject, body} from a send request WITHOUT a model — pure string
 * parsing. This is what makes the send model-independent: for the common
 * "email X, subject "Y", body "Z"" shape, no LLM is involved at all, so
 * switching models can't break it. Returns null when the structured fields
 * aren't present (free-form phrasing), leaving an LLM fallback to try.
 */
export function parseEmailFieldsFromGoal(goal: string): { to: string; subject: string; body: string } | null {
  const g = goal || '';
  const email = g.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
  if (!email) return null;
  const to = email[0];

  // Grab quoted text that follows a labelled prefix (subject/body). Handles
  // straight and curly double quotes.
  const grab = (prefix: string): string => {
    const m = g.match(new RegExp(prefix + '\\s*["“]([^"”]+)["”]', 'i'));
    return m ? m[1].trim() : '';
  };
  const subject = grab('subject(?:\\s*line)?\\s*(?:say|saying|says|:|is|=|of|reads?|that)?');
  let body = grab('body\\s*(?:say|saying|says|:|is|=|of|text|reads?|that)?');
  if (!body) body = grab('(?:saying|message(?:\\s*body)?|content)');

  // Need a recipient AND at least one of subject/body to send deterministically.
  if (!subject && !body) return null;
  return { to, subject, body };
}

/** Inputs for the send-nudge decision, taken when the model returns a
 *  plain-text reply on a send-intent goal. */
export interface SendGuardState {
  goal: string;
  /** Did a real send get CONFIRMED this run (an external_actions row)? */
  sendConfirmed: boolean;
  /** How many send-nudges we've already injected this run. */
  nudges: number;
  maxNudges: number;
  /** The text the model just returned. */
  content: string;
}

/**
 * True when the model is about to end a SEND task without a confirmed send —
 * e.g. it created a draft (email_compose) and stopped. Pushes it to actually
 * call email_send instead. Fires only under the nudge cap and never on a
 * genuine clarifying question.
 */
export function shouldNudgeToSend(s: SendGuardState): boolean {
  return (
    detectsSendIntent(s.goal) &&
    !s.sendConfirmed &&
    s.nudges < s.maxNudges &&
    !s.content.includes('?')
  );
}

/** Minimal structural shape of a chat message the DOM-compactor touches.
 *  Declared locally so this module stays dependency-free (no OpenAI import). */
export interface CompactableMessage {
  role: string;
  tool_call_id?: string;
  content?: unknown;
}

/**
 * In place: collapse every `browser_read_dom` tool result EXCEPT the most
 * recent one down to a tiny stub (keeping url/title).
 *
 * Each readDom payload is up to ~12k chars of page text, and the ReAct loop
 * otherwise re-sends every one of them on EVERY subsequent turn. A 6-step email
 * flow then drags 4-5 stale DOM dumps through context on each call — the main
 * driver of slow (and, on a paid API, expensive) browser-action runs. The model
 * only ever needs the latest snapshot to choose its next selector; older ones
 * are stale the moment the page changes. Returns how many it compacted.
 */
export function compactStaleDomDumps(
  messages: CompactableMessage[],
  readDomCallIds: Set<string>,
): number {
  const domIdxs: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.role === 'tool' && typeof m.tool_call_id === 'string' && readDomCallIds.has(m.tool_call_id)) {
      domIdxs.push(i);
    }
  }
  let compacted = 0;
  // Keep the last index untouched; stub everything before it.
  for (let k = 0; k < domIdxs.length - 1; k++) {
    const m = messages[domIdxs[k]];
    // Skip ones already stubbed (idempotent — the stub is well under 400 chars).
    if (typeof m.content === 'string' && m.content.length > 400) {
      let url: unknown;
      let title: unknown;
      try {
        const p = JSON.parse(m.content);
        url = p.url;
        title = p.title;
      } catch {
        /* non-JSON payload — keep url/title undefined */
      }
      m.content = JSON.stringify({
        url,
        title,
        note: 'Earlier page DOM omitted to save context — call browser_read_dom again if you need the current page.',
      });
      compacted++;
    }
  }
  return compacted;
}
