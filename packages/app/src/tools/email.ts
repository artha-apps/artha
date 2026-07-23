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
        'Compose an email and open it pre-filled for the user to review and send. ' +
        'USE THIS TOOL for ANY request to send, write, draft or compose an email — ' +
        "including phrasings like \"open my Gmail and send…\" or \"email X\". Prefer it " +
        'over browser automation: do NOT navigate to gmail.com and click around, that ' +
        'hits the login wall. If the user names their provider (Gmail, Outlook, Yahoo), ' +
        "pass `open_in` so it opens THAT provider's web compose; otherwise it opens the " +
        "user's default mail client. " +
        'IMPORTANT: this does NOT send the email — it opens it ready to send and the user ' +
        'presses send. Artha cannot send email in the background. Never tell the user their ' +
        'email has been sent; say the message is open, pre-filled, for them to review and send.',
      parameters: {
        type: 'object',
        properties: {
          to: { type: 'string', description: 'Recipient address. Comma-separate multiple recipients.' },
          subject: { type: 'string', description: 'Subject line.' },
          body: { type: 'string', description: 'Plain-text body of the message.' },
          cc: { type: 'string', description: 'Optional CC addresses, comma-separated.' },
          bcc: { type: 'string', description: 'Optional BCC addresses, comma-separated.' },
          open_in: {
            type: 'string',
            enum: ['default', 'gmail', 'outlook', 'yahoo'],
            description:
              "Where to open the pre-filled message. 'gmail'/'outlook'/'yahoo' open that " +
              "provider's web compose in the browser (best when the user says 'open my Gmail'); " +
              "'default' (the fallback) opens the user's default desktop mail client.",
          },
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

export type OpenIn = 'default' | 'gmail' | 'outlook' | 'yahoo';

interface Draft { to: string; subject: string; body: string; cc?: string; bcc?: string; }

/** mailto: is a URL — every field must be encoded or a body containing an
 *  ampersand silently truncates the message. */
function buildMailto(a: Draft): string {
  const params = new URLSearchParams();
  params.set('subject', a.subject);
  params.set('body', a.body);
  if (a.cc?.trim()) params.set('cc', a.cc.trim());
  if (a.bcc?.trim()) params.set('bcc', a.bcc.trim());
  // encodeURIComponent (not URLSearchParams' + form encoding) for the address,
  // and swap +→%20 so spaces in the body survive as spaces, not plus signs.
  return `mailto:${encodeURIComponent(a.to.trim())}?${params.toString().replace(/\+/g, '%20')}`;
}

/** Web-compose URLs open the provider's compose window in the browser with the
 *  message pre-filled — matching a user request to "open my Gmail". These never
 *  send; the compose window still requires the user to press send. Each provider
 *  uses different field names; unknown fields are simply ignored by the provider. */
function buildWebCompose(kind: Exclude<OpenIn, 'default'>, a: Draft): string {
  const enc = (s: string) => encodeURIComponent(s);
  const to = a.to.trim();
  switch (kind) {
    case 'gmail': {
      // Gmail full-screen compose. `su`=subject, `body`, `cc`, `bcc`.
      const p = [`view=cm`, `fs=1`, `to=${enc(to)}`, `su=${enc(a.subject)}`, `body=${enc(a.body)}`];
      if (a.cc?.trim()) p.push(`cc=${enc(a.cc.trim())}`);
      if (a.bcc?.trim()) p.push(`bcc=${enc(a.bcc.trim())}`);
      return `https://mail.google.com/mail/?${p.join('&')}`;
    }
    case 'outlook': {
      const p = [`to=${enc(to)}`, `subject=${enc(a.subject)}`, `body=${enc(a.body)}`];
      if (a.cc?.trim()) p.push(`cc=${enc(a.cc.trim())}`);
      if (a.bcc?.trim()) p.push(`bcc=${enc(a.bcc.trim())}`);
      return `https://outlook.live.com/mail/0/deeplink/compose?${p.join('&')}`;
    }
    case 'yahoo': {
      const p = [`to=${enc(to)}`, `subject=${enc(a.subject)}`, `body=${enc(a.body)}`];
      if (a.cc?.trim()) p.push(`cc=${enc(a.cc.trim())}`);
      if (a.bcc?.trim()) p.push(`bcc=${enc(a.bcc.trim())}`);
      return `https://compose.mail.yahoo.com/?${p.join('&')}`;
    }
  }
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
  const openIn: OpenIn =
    args.open_in === 'gmail' || args.open_in === 'outlook' || args.open_in === 'yahoo'
      ? args.open_in
      : 'default';

  if (!to) return 'Error: "to" is required — no recipient was provided.';
  const invalid = to.split(',').map(s => s.trim()).filter(a => a && !looksLikeAddress(a));
  if (invalid.length) {
    return `Error: these recipients don't look like email addresses: ${invalid.join(', ')}`;
  }
  if (!subject && !body) {
    return 'Error: the email has no subject and no body — nothing to compose.';
  }

  const draft = { to, subject, body, cc, bcc };
  const url = openIn === 'default' ? buildMailto(draft) : buildWebCompose(openIn, draft);
  // mailto: URLs can be refused by some desktop clients when very long; web
  // compose URLs tolerate far more. Only warn for the desktop path.
  const oversized = openIn === 'default' && url.length > 2000;
  const where =
    openIn === 'default' ? 'your default mail client'
    : openIn === 'gmail' ? 'Gmail web compose'
    : openIn === 'outlook' ? 'Outlook web compose'
    : 'Yahoo web compose';

  try {
    await shell.openExternal(url);
  } catch (err) {
    return `Error: could not open ${where} — ${err instanceof Error ? err.message : String(err)}. The message was not opened.`;
  }

  return JSON.stringify({
    drafted: true,
    sent: false,
    to,
    subject,
    opened_in: where,
    user_action_required: `The email is open and pre-filled in ${where}. Review it and press Send — Artha cannot send it for you.`,
    ...(oversized
      ? { warning: 'The message is long; some desktop mail clients truncate large drafts. Check the body before sending.' }
      : {}),
  });
}
