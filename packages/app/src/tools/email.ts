/**
 * Email composition.
 *
 * Artha previously had NO email capability of any kind: no built-in tool, and
 * the Google integration is `gmail.readonly` (it cannot send). Asked to "send
 * an email", the agent planned around tools that do not exist and failed —
 * a capability gap surfacing as a task error.
 *
 * This closes the gap the honest way. Artha PREPARES the message and hands it
 * to the user's own mail client with everything pre-filled; the user reviews
 * and presses send. Consequences of that design, all deliberate:
 *   - no credentials, no OAuth scope escalation, nothing to leak;
 *   - the consequential action stays under human control, which is the
 *     product rule for send/submit/purchase-class actions;
 *   - the tool can never claim the mail was sent, because it wasn't — it
 *     reports exactly what it did, which is open a draft.
 *
 * True background sending (Gmail API with `gmail.send`) is a separate,
 * larger piece: it needs a new consent scope and must run through the
 * write-ahead intent log so a crash can't double-send. Until that exists,
 * this tool must never imply it happened.
 */
import type OpenAI from 'openai';
import { shell } from 'electron';

export const EMAIL_TOOL_SCHEMAS: OpenAI.ChatCompletionTool[] = [
  {
    type: 'function',
    function: {
      name: 'email_compose',
      description:
        "Prepare an email and open it in the user's default mail client with recipient, " +
        'subject and body pre-filled, ready for them to review and send. ' +
        'IMPORTANT: this does NOT send the email — the user sends it themselves. ' +
        'Artha cannot send email in the background. Never tell the user their email ' +
        'has been sent; say the draft is open for their review.',
      parameters: {
        type: 'object',
        properties: {
          to: { type: 'string', description: 'Recipient address. Comma-separate multiple recipients.' },
          subject: { type: 'string', description: 'Subject line.' },
          body: { type: 'string', description: 'Plain-text body of the message.' },
          cc: { type: 'string', description: 'Optional CC addresses, comma-separated.' },
          bcc: { type: 'string', description: 'Optional BCC addresses, comma-separated.' },
        },
        required: ['to', 'subject', 'body'],
      },
    },
  },
];

const EMAIL_TOOL_NAMES = new Set(EMAIL_TOOL_SCHEMAS.map(t => t.function.name));
export function isEmailTool(name: string): boolean {
  return EMAIL_TOOL_NAMES.has(name);
}

/** Loose address check — enough to catch an obviously bad recipient before we
 *  hand it to the OS, without pretending to validate deliverability. */
function looksLikeAddress(a: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(a.trim());
}

/** mailto: is a URL — every field must be encoded or a body containing an
 *  ampersand silently truncates the message. */
function buildMailto(a: {
  to: string; subject: string; body: string; cc?: string; bcc?: string;
}): string {
  const params = new URLSearchParams();
  params.set('subject', a.subject);
  params.set('body', a.body);
  if (a.cc?.trim()) params.set('cc', a.cc.trim());
  if (a.bcc?.trim()) params.set('bcc', a.bcc.trim());
  // encodeURIComponent (not URLSearchParams' + form encoding) for the address,
  // and swap +→%20 so spaces in the body survive as spaces, not plus signs.
  return `mailto:${encodeURIComponent(a.to.trim())}?${params.toString().replace(/\+/g, '%20')}`;
}

export async function invokeEmailTool(
  name: string,
  args: Record<string, unknown>,
): Promise<string> {
  if (name !== 'email_compose') throw new Error(`Unknown email tool: ${name}`);

  const to = typeof args.to === 'string' ? args.to.trim() : '';
  const subject = typeof args.subject === 'string' ? args.subject : '';
  const body = typeof args.body === 'string' ? args.body : '';
  const cc = typeof args.cc === 'string' ? args.cc : undefined;
  const bcc = typeof args.bcc === 'string' ? args.bcc : undefined;

  if (!to) return 'Error: "to" is required — no recipient was provided.';
  const invalid = to.split(',').map(s => s.trim()).filter(a => a && !looksLikeAddress(a));
  if (invalid.length) {
    return `Error: these recipients don't look like email addresses: ${invalid.join(', ')}`;
  }
  if (!subject && !body) {
    return 'Error: the email has no subject and no body — nothing to compose.';
  }

  const url = buildMailto({ to, subject, body, cc, bcc });
  // Some mail clients refuse very long mailto URLs; warn rather than silently
  // truncating the user's message.
  const oversized = url.length > 2000;

  try {
    await shell.openExternal(url);
  } catch (err) {
    return `Error: could not open your mail client — ${err instanceof Error ? err.message : String(err)}. The draft was not opened.`;
  }

  return JSON.stringify({
    drafted: true,
    sent: false,
    to,
    subject,
    opened_in: 'default mail client',
    user_action_required: 'The draft is open in your mail client. Review it and press send — Artha cannot send it for you.',
    ...(oversized
      ? { warning: 'The message is long; some mail clients truncate large drafts. Check the body before sending.' }
      : {}),
  });
}
