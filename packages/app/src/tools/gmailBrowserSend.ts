/**
 * Browser-backed Gmail send — the zero-setup "Cowork" path.
 *
 * Instead of the Gmail API (which needs OAuth + a Google-verified app), this
 * rides the user's EXISTING Gmail login inside Artha's embedded browser: it
 * opens a pre-filled compose, clicks Send, and confirms Gmail's own
 * "Message sent" acknowledgement. No Google Cloud project, no OAuth, no
 * per-user setup — the same way a person would do it.
 *
 * Proven live against real Gmail before this was written: navigate to the
 * `view=cm` pre-filled compose URL → click `div[role=button][aria-label^="Send"]`
 * → poll for the "Message sent" toast.
 *
 * The webContents is injected (see `SendableWebContents`) so the flow is unit
 * testable without standing up Electron. Honesty contract mirrors the API path:
 * it reports `sent` ONLY when Gmail's confirmation is observed; a missing login
 * yields `login_required` (the caller hands off so the user can log in), and an
 * unconfirmed click yields `unconfirmed` (never a false success).
 */

export interface SendableWebContents {
  loadURL(url: string): Promise<void>;
  executeJavaScript(code: string, userGesture?: boolean): Promise<unknown>;
  getURL(): string;
}

export interface BrowserDraft { to: string; subject: string; body: string; cc?: string; bcc?: string }

export type BrowserSendStatus = 'sent' | 'login_required' | 'no_compose' | 'unconfirmed';
export interface BrowserSendResult { status: BrowserSendStatus; detail?: string }

/** Full-screen Gmail compose, pre-filled. `view=cm&fs=1` opens the compose
 *  directly; unknown/blank fields are simply omitted. */
export function buildGmailComposeUrl(a: BrowserDraft): string {
  const enc = encodeURIComponent;
  const p = [`view=cm`, `fs=1`, `to=${enc(a.to)}`, `su=${enc(a.subject)}`, `body=${enc(a.body)}`];
  if (a.cc?.trim()) p.push(`cc=${enc(a.cc.trim())}`);
  if (a.bcc?.trim()) p.push(`bcc=${enc(a.bcc.trim())}`);
  return `https://mail.google.com/mail/?${p.join('&')}`;
}

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

/** True when the current page is a Google sign-in page rather than the mailbox. */
function looksLikeLogin(url: string): boolean {
  return /accounts\.google\.com|\/ServiceLogin|\/signin/i.test(url);
}

// Injected page scripts kept as strings (they run in the page, not here).
const SEND_BUTTON_PRESENT = `!!document.querySelector('div[role=button][aria-label^="Send"]')`;
const CLICK_SEND = `(() => {
  const b = document.querySelector('div[role=button][aria-label^="Send"]');
  if (!b) return 'NO_SEND_BUTTON';
  b.click();
  return 'CLICKED';
})()`;
const SENT_CONFIRMED = `/Message sent/i.test(document.body ? document.body.innerText : '')`;

/**
 * Send `draft` through the embedded, already-logged-in Gmail. Pure with respect
 * to `wc` — all side effects go through the injected webContents.
 */
export async function sendViaBrowser(
  wc: SendableWebContents,
  draft: BrowserDraft,
  opts: { composeTimeoutMs?: number; confirmTimeoutMs?: number; pollMs?: number } = {},
): Promise<BrowserSendResult> {
  const composeTimeout = opts.composeTimeoutMs ?? 12_000;
  const confirmTimeout = opts.confirmTimeoutMs ?? 8_000;
  const poll = opts.pollMs ?? 400;

  await wc.loadURL(buildGmailComposeUrl(draft));

  // Wait for either the compose (Send button) or a login page.
  const composeDeadline = Date.now() + composeTimeout;
  // Date.now() is fine here — this is runtime tool code, not a replayed workflow.
  for (;;) {
    if (looksLikeLogin(wc.getURL())) return { status: 'login_required' };
    const present = await wc.executeJavaScript(SEND_BUTTON_PRESENT).catch(() => false);
    if (present === true) break;
    if (Date.now() > composeDeadline) {
      // One last login check before giving up.
      return looksLikeLogin(wc.getURL())
        ? { status: 'login_required' }
        : { status: 'no_compose', detail: 'The Gmail compose window did not appear in time.' };
    }
    await sleep(poll);
  }

  const clicked = await wc.executeJavaScript(CLICK_SEND, true).catch(() => 'ERROR');
  if (clicked !== 'CLICKED') {
    return { status: 'no_compose', detail: 'Could not find Gmail’s Send button to click.' };
  }

  // Confirm Gmail actually sent it (its own "Message sent" toast).
  const confirmDeadline = Date.now() + confirmTimeout;
  for (;;) {
    const confirmed = await wc.executeJavaScript(SENT_CONFIRMED).catch(() => false);
    if (confirmed === true) return { status: 'sent' };
    if (Date.now() > confirmDeadline) {
      return { status: 'unconfirmed', detail: 'Clicked Send, but Gmail’s “Message sent” confirmation was not observed. Check your Sent folder.' };
    }
    await sleep(poll);
  }
}
