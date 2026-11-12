/**
 * email_send — Artha actually sends the email, via the Gmail API.
 *
 * This is the consequential counterpart to email_compose (which only opens a
 * pre-filled draft). It is deliberately built to three hard rules:
 *
 *   1. NEVER send without approval. email_send is on the always-confirm policy
 *      floor (bodhi/policy.ts), so the orchestrator pauses for the user before
 *      it ever runs, and fails closed on unattended runs (nobody to approve).
 *
 *   2. NEVER double-send. Every send is written to the external_actions
 *      write-ahead log BEFORE the API call, keyed by a fingerprint of
 *      (recipients + subject + body). If a matching action is already
 *      'dispatching' or 'confirmed', we refuse rather than risk a second copy —
 *      this is what makes a crash mid-send safe.
 *
 *   3. NEVER claim sent unless Gmail confirmed it. "sent: true" is returned only
 *      when the API returns a message id. A throw during the request is recorded
 *      as outcome_unknown (it MIGHT have gone out), reported honestly, and never
 *      auto-retried.
 *
 * Tokens are read from oauth_tokens sealed-at-rest and refreshed on demand; they
 * are opened only for the outbound call to Google's own endpoint.
 */
import type OpenAI from 'openai';
import { createHash } from 'crypto';
import { getDb } from '../db/schema';
import { getRunContext } from '../agent/runContext';
import {
  sealSecretString, openSecretString, isSecretEncryptionAvailable,
} from '../security/secretString';
import { sendViaBrowser, type BrowserSendResult, type SendableWebContents, type BrowserDraft } from './gmailBrowserSend';

export const GMAIL_SEND_SCOPE = 'https://www.googleapis.com/auth/gmail.send';

export const EMAIL_SEND_TOOL_SCHEMAS: OpenAI.ChatCompletionTool[] = [
  {
    type: 'function',
    function: {
      name: 'email_send',
      description:
        'SEND an email now — it actually goes out (not a draft). This is the tool to ' +
        'use for any "send an email" / "email X and send it" request. By default it ' +
        'rides the user\'s existing Gmail login in Artha\'s browser (no setup, no ' +
        'OAuth); it falls back to the Gmail API only if Google is connected. Every ' +
        'send pauses for the user\'s approval first. If it returns login_required, the ' +
        'user needs to sign in to Gmail in Artha\'s browser once — tell them that. ' +
        'Only report the email as sent if this tool returns sent:true; on an ' +
        'unconfirmed/outcome_unknown result, tell the user to check their Sent folder ' +
        'rather than sending again. Use email_compose instead only when the user ' +
        'explicitly wants just a draft they will send themselves.',
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

const NAMES = new Set(EMAIL_SEND_TOOL_SCHEMAS.map(t => t.function.name));
export function isGmailSendTool(name: string): boolean {
  return NAMES.has(name);
}

function looksLikeAddress(a: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(a.trim());
}

// ── Access token: read sealed, refresh if near expiry ──────────────────────

interface TokenResult { token?: string; error?: string }

function readGoogleClientId(): string | undefined {
  const row = getDb().prepare(`SELECT settings_json FROM users WHERE user_id='default'`).get() as
    { settings_json: string } | undefined;
  try { return (JSON.parse(row?.settings_json ?? '{}').google_client_id as string) || undefined; }
  catch { return undefined; }
}

/** Return a live Gmail access token, refreshing it if it is within 60s of
 *  expiry. Any failure is returned as an actionable `error` (never thrown) so
 *  the caller can report it without sending. */
async function getGoogleAccessToken(): Promise<TokenResult> {
  if (!isSecretEncryptionAvailable()) {
    return { error: 'Secure key storage is unavailable, so Artha can’t read your Google sign-in. Connect Google again on a system with a keychain.' };
  }
  const db = getDb();
  const row = db.prepare(
    `SELECT access_token, refresh_token, expires_at, scope FROM oauth_tokens WHERE provider='google'`
  ).get() as { access_token: string | null; refresh_token: string | null; expires_at: number | null; scope: string | null } | undefined;

  if (!row || !row.access_token) {
    return { error: 'Google isn’t connected. Connect your Google account in the Cloud panel, then try again.' };
  }
  if (!row.scope || !row.scope.split(/\s+/).includes(GMAIL_SEND_SCOPE)) {
    return { error: 'Your Google connection doesn’t include send permission. Disconnect and reconnect Google to grant Gmail “send” access, then try again.' };
  }

  const now = Math.floor(Date.now() / 1000);
  if (row.expires_at && row.expires_at - now > 60) {
    return { token: openSecretString(row.access_token) };
  }

  // Expired (or nearly) — refresh.
  if (!row.refresh_token) {
    return { error: 'Your Google sign-in expired and there’s no refresh token. Reconnect Google and try again.' };
  }
  const clientId = readGoogleClientId();
  if (!clientId) return { error: 'No Google Client ID is configured, so the sign-in can’t be refreshed. Reconnect Google.' };

  try {
    const refreshToken = openSecretString(row.refresh_token);
    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: clientId }),
    });
    const tok = await res.json() as { access_token?: string; expires_in?: number; error_description?: string; error?: string };
    if (!res.ok || !tok.access_token) {
      return { error: `Couldn’t refresh your Google sign-in (${tok.error_description || tok.error || res.status}). Reconnect Google.` };
    }
    const expiresAt = now + (tok.expires_in ?? 3600);
    db.prepare(`UPDATE oauth_tokens SET access_token=?, expires_at=? WHERE provider='google'`)
      .run(sealSecretString(tok.access_token), expiresAt);
    return { token: tok.access_token };
  } catch (e) {
    return { error: `Couldn’t refresh your Google sign-in — ${e instanceof Error ? e.message : String(e)}.` };
  }
}

// ── MIME + fingerprint ─────────────────────────────────────────────────────

/** RFC 2047-encode a header value when it contains non-ASCII, so accented
 *  subjects don't arrive mojibaked. */
function encodeHeader(v: string): string {
  // eslint-disable-next-line no-control-regex
  return /^[\x00-\x7F]*$/.test(v) ? v : `=?UTF-8?B?${Buffer.from(v, 'utf8').toString('base64')}?=`;
}

function buildMime(a: { to: string; subject: string; body: string; cc?: string; bcc?: string }): string {
  const headers = [
    `To: ${a.to}`,
    a.cc?.trim() ? `Cc: ${a.cc.trim()}` : '',
    a.bcc?.trim() ? `Bcc: ${a.bcc.trim()}` : '',
    `Subject: ${encodeHeader(a.subject)}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: 8bit',
  ].filter(Boolean);
  return `${headers.join('\r\n')}\r\n\r\n${a.body}`;
}

/** Stable dedupe key for "the same logical email". */
function fingerprint(a: { to: string; subject: string; body: string; cc?: string; bcc?: string }): string {
  return createHash('sha256')
    .update([a.to, a.cc ?? '', a.bcc ?? '', a.subject, a.body].join(' '))
    .digest('hex');
}

/** Never store a recipient in the clear in the audit log. One address in,
 *  one short hash out (the format older rows already use for a bare address). */
function hashAddress(addr: string): string {
  return 'sha256:' + createHash('sha256').update(addr.trim().toLowerCase()).digest('hex').slice(0, 16);
}

/** Every bare, lowercased recipient across to/cc/bcc, de-duplicated and
 *  sorted ("Bob@x.com, alice@x.com" and "alice@x.com,bob@x.com" are equal). */
function recipientAddresses(...fields: Array<string | undefined>): string[] {
  const out = new Set<string>();
  for (const field of fields) {
    for (const part of (field ?? '').split(/[,;]/)) {
      const angle = part.match(/<([^>]+)>/);
      const addr = (angle ? angle[1] : part).trim().toLowerCase();
      if (addr) out.add(addr);
    }
  }
  return [...out].sort();
}

/** The audit identity of a send: one hash per recipient, comma-joined, so the
 *  resume guard can ask "does this send reach ANYONE the interrupted run
 *  already emailed?" without ever storing an address in the clear. */
function hashRecipients(to: string, cc?: string, bcc?: string): string {
  return recipientAddresses(to, cc, bcc).map(hashAddress).join(',');
}

// ── Browser path adapter ────────────────────────────────────────────────────

/** Attempt the browser-backed send using Artha's embedded browser. Returns null
 *  when the browser surface isn't available at all (e.g. under unit tests or a
 *  headless run), so the caller falls back to the API path. Never throws. */
async function trySendViaBrowser(draft: BrowserDraft): Promise<BrowserSendResult | null> {
  try {
    const { BrowserController } = await import('../browser/controller');
    const realWc = BrowserController.getInstance().getWebContents();
    if (!realWc || typeof realWc.loadURL !== 'function') { console.error('[email_send] browser: no webContents → API fallback'); return null; }

    // Attach + paint the pane BEFORE driving. Gmail's Send only dispatches in a
    // rendered view; a hidden BrowserView clicks the button but nothing happens.
    try {
      const { requestBrowserPaneOpen } = await import('./browser');
      requestBrowserPaneOpen();
      await new Promise<void>(r => setTimeout(r, 2500)); // let the renderer attach
    } catch { /* pane hook unavailable → proceed anyway */ }

    // Adapter: expose loadURL/executeJavaScript/getURL, and a trusted clickAt
    // implemented over the webContents debugger (Input.dispatchMouseEvent) —
    // the only click Gmail's Send button actually honours.
    const adapter: SendableWebContents = {
      loadURL: (u: string) => realWc.loadURL(u),
      executeJavaScript: (c: string, g?: boolean) => realWc.executeJavaScript(c, g),
      getURL: () => realWc.getURL(),
      clickAt: async (x: number, y: number) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const dbg = (realWc as any).debugger;
        let attached = false;
        try { dbg.attach('1.3'); attached = true; } catch { /* already attached — reuse */ }
        try {
          await dbg.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
          await dbg.sendCommand('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
          await dbg.sendCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
        } finally {
          if (attached) { try { dbg.detach(); } catch { /* ignore */ } }
        }
      },
    };

    const r = await sendViaBrowser(adapter, draft);
    console.error('[email_send] browser result:', JSON.stringify(r));
    return r;
  } catch (e) {
    console.error('[email_send] browser threw → API fallback:', e instanceof Error ? e.message : String(e));
    return null;   // browser unavailable → let the API fallback decide
  }
}

// ── The tool ───────────────────────────────────────────────────────────────

export async function invokeGmailSendTool(
  name: string,
  args: Record<string, unknown>,
  ctx?: { taskId?: string | null; runId?: string | null },
): Promise<string> {
  if (name !== 'email_send') throw new Error(`Unknown gmail tool: ${name}`);

  const to = typeof args.to === 'string' ? args.to.trim() : '';
  const subject = typeof args.subject === 'string' ? args.subject : '';
  const body = typeof args.body === 'string' ? args.body : '';
  const cc = typeof args.cc === 'string' ? args.cc.trim() || undefined : undefined;
  const bcc = typeof args.bcc === 'string' ? args.bcc.trim() || undefined : undefined;

  if (!to) return 'Error: "to" is required — no recipient was provided. Nothing was sent.';
  const invalid = to.split(',').map(s => s.trim()).filter(x => x && !looksLikeAddress(x));
  if (invalid.length) return `Error: these recipients don't look like email addresses: ${invalid.join(', ')}. Nothing was sent.`;
  if (!subject && !body) return 'Error: the email has no subject and no body — nothing to send.';

  const db = getDb();
  const draft = { to, subject, body, cc, bcc };
  const fp = fingerprint(draft);

  // ── Write-ahead double-send guard ──────────────────────────────────────
  // If we already have this exact email in flight or confirmed, do NOT send a
  // second copy — this is the crash-safety property.
  const prior = db.prepare(
    `SELECT state, external_ref FROM external_actions
      WHERE tool='email_send' AND fingerprint=? AND state IN ('dispatching','confirmed')
      ORDER BY created_at DESC LIMIT 1`
  ).get(fp) as { state: string; external_ref: string | null } | undefined;
  if (prior?.state === 'confirmed') {
    return JSON.stringify({
      sent: false, duplicate: true,
      message: 'This exact email was already sent earlier (matching Gmail message ' +
        `${prior.external_ref ?? 'on record'}). Artha did not send it again.`,
    });
  }
  if (prior?.state === 'dispatching') {
    return JSON.stringify({
      sent: false, outcome_unknown: true,
      message: 'A previous attempt to send this exact email did not confirm, so it may ' +
        'already have gone out. Artha did not send it again — please check your Gmail ' +
        'Sent folder before retrying.',
    });
  }

  // ── Resume guard ───────────────────────────────────────────────────────
  // A run resumed after an app restart must never repeat an email the
  // interrupted run already sent (or dispatched with unknown outcome) — even
  // if the model re-words the subject/body so the fingerprint above differs.
  // Any send that reaches ANY recipient of one of those actions (to, cc or
  // bcc; any order, any case, as part of a longer list) is refused.
  const resumeIds = getRunContext()?.resume?.confirmedActionIds ?? [];
  if (resumeIds.length) {
    const placeholders = resumeIds.map(() => '?').join(',');
    const priorSends = db.prepare(
      `SELECT action_id, state, target_identity FROM external_actions
        WHERE tool='email_send' AND state IN ('dispatching','confirmed')
          AND action_id IN (${placeholders})`
    ).all(...resumeIds) as Array<{ action_id: string; state: string; target_identity: string | null }>;
    const nowReaching = new Set(recipientAddresses(to, cc, bcc).map(hashAddress));
    const repeat = priorSends.find(p =>
      (p.target_identity ?? '').split(',').some(h => h && nowReaching.has(h)));
    if (repeat) {
      return JSON.stringify({
        sent: false, duplicate: true, resumed: true,
        message: 'Before the app restarted, this task already ' +
          (repeat.state === 'confirmed' ? 'sent an email' : 'attempted an email (outcome unknown)') +
          ` to ${to}. Artha did not send another one. If a second email is really wanted, ask for it in a new message.`,
      });
    }
  }

  // Reserve the intent BEFORE calling Google.
  const actionId = createHash('sha256').update(fp + ':' + Date.now()).digest('hex').slice(0, 16);
  db.prepare(
    `INSERT INTO external_actions
       (action_id, task_id, run_id, tool, category, target_system, target_identity,
        fingerprint, state, attempts, dispatched_at)
     VALUES (?, ?, ?, 'email_send', 'send', 'gmail', ?, ?, 'dispatching', 1, unixepoch())`
  ).run(actionId, ctx?.taskId ?? null, ctx?.runId ?? null, hashRecipients(to, cc, bcc), fp);

  const mark = (state: string, patch: Record<string, unknown> = {}) => {
    try {
      db.prepare(
        `UPDATE external_actions SET state=?, external_ref=?, outcome=?, retry_eligible=?,
           error_redacted=?, updated_at=unixepoch() WHERE action_id=?`
      ).run(state, patch.external_ref ?? null, patch.outcome ?? null,
            patch.retry_eligible ? 1 : 0, patch.error_redacted ?? null, actionId);
    } catch { /* audit best-effort */ }
  };

  // ── Preferred path: the embedded, already-logged-in Gmail (zero setup) ──
  // Rides the user's existing Gmail login in Artha's browser — no OAuth, no
  // Google Cloud project, nothing to set up. Falls through to the API only if
  // the browser path can't confirm a send.
  const browser = await trySendViaBrowser(draft);
  if (browser?.status === 'sent') {
    mark('confirmed', { external_ref: 'browser', outcome: 'sent' });
    return JSON.stringify({
      sent: true, via: 'browser', to, subject,
      message: `The email was sent to ${to} from your Gmail (confirmed by Gmail’s “Message sent”).`,
    });
  }
  if (browser?.status === 'unconfirmed') {
    mark('outcome_unknown', { outcome: 'browser_unconfirmed', retry_eligible: 0 });
    return JSON.stringify({
      sent: false, outcome_unknown: true,
      message: browser.detail ?? 'Clicked Send but couldn’t confirm; check your Gmail Sent folder before retrying.',
    });
  }
  // browser was 'login_required' or 'no_compose' (or unavailable) — try the API
  // fallback, then fall back to actionable guidance.

  const auth = await getGoogleAccessToken();
  if (auth.error || !auth.token) {
    mark('failed', { outcome: browser?.status === 'login_required' ? 'gmail_login_required' : 'auth_error', retry_eligible: 1 });
    if (browser?.status === 'login_required') {
      return 'Error: You’re not signed in to Gmail in Artha’s browser, and Google isn’t connected either. ' +
        'Open Artha’s browser, sign in to Gmail once, then try again — no other setup needed. Nothing was sent.';
    }
    return `Error: ${auth.error ?? 'no Google access token available'} Nothing was sent.`;
  }

  const raw = Buffer.from(buildMime(draft), 'utf8').toString('base64url');
  let res: Response;
  try {
    res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
      method: 'POST',
      headers: { Authorization: `Bearer ${auth.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ raw }),
    });
  } catch (e) {
    // The request may or may not have reached Gmail. Treat as unknown — never
    // auto-retry, because a retry could double-send.
    mark('outcome_unknown', { outcome: 'network_error', retry_eligible: 0 });
    return JSON.stringify({
      sent: false, outcome_unknown: true,
      message: `Artha couldn’t confirm whether the email was sent — ${e instanceof Error ? e.message : String(e)}. ` +
        'Check your Gmail Sent folder before trying again; do not assume it failed.',
    });
  }

  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try { const j = await res.json() as { error?: { message?: string } }; if (j.error?.message) detail = j.error.message; } catch { /* keep status */ }
    // A clean rejection (Google refused it) — it did NOT send. Retry is safe
    // only in the sense that nothing went out, but leave that to the user.
    mark('failed', { outcome: `http_${res.status}`, retry_eligible: res.status >= 500 ? 1 : 0, error_redacted: detail.slice(0, 200) });
    return `Error: Gmail rejected the send (${detail}). The email was NOT sent.`;
  }

  let messageId = '';
  try { const j = await res.json() as { id?: string }; messageId = j.id ?? ''; } catch { /* id optional */ }
  mark('confirmed', { external_ref: messageId || 'sent', outcome: 'sent' });

  return JSON.stringify({
    sent: true,
    to,
    subject,
    gmail_message_id: messageId || null,
    message: `The email was sent to ${to} via your Gmail account.`,
  });
}
