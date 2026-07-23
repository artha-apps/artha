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
  /** A trusted mouse click at page coordinates (x, y). Implemented over the
   *  webContents debugger's Input.dispatchMouseEvent — Gmail's Send button
   *  ignores synthetic clicks AND webContents.sendInputEvent, but honours a real
   *  CDP mouse event. */
  clickAt(x: number, y: number): Promise<void>;
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
/** Gmail signed-in app is ready when the Compose button exists. */
const GMAIL_READY = `!!document.querySelector('[gh="cm"], div[role=button][aria-label^="Compose" i]')`;
const SEND_BUTTON_PRESENT = `!!document.querySelector('div[role=button][aria-label^="Send"]')`;
/** Centre coordinates of the Send button — we click it with a trusted mouse
 *  event, because Gmail ignores synthetic element.click() (isTrusted:false). */
const SEND_BUTTON_RECT = `(() => {
  const b = document.querySelector('div[role=button][aria-label^="Send"]');
  if (!b) return null;
  const r = b.getBoundingClientRect();
  return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
})()`;
const SENT_CONFIRMED = `/Message sent/i.test(document.body ? document.body.innerText : '')`;
/** Authoritative check: does the Sent folder contain a row with this subject? */
function sentFolderHas(subject: string): string {
  const needle = subject.slice(0, 60).replace(/[\\'"]/g, ' ').trim();
  return `(() => {
    const rows = document.querySelectorAll('tr, div[role=row], span[data-thread-id]');
    const n = ${JSON.stringify(needle)};
    if (!n) return false;
    return [...rows].some(r => (r.innerText || '').includes(n));
  })()`;
}

/**
 * Send `draft` through the embedded, already-logged-in Gmail. Pure with respect
 * to `wc` — all side effects go through the injected webContents.
 *
 * Robustness (learned from a cold hidden BrowserView): warm up the mailbox
 * first (direct-to-compose on a cold load is flaky), use generous timeouts, and
 * confirm the send AUTHORITATIVELY by checking the Sent folder for the subject —
 * not just the transient "Message sent" toast, which a hidden view often misses.
 */
export async function sendViaBrowser(
  wc: SendableWebContents,
  draft: BrowserDraft,
  opts: { warmupTimeoutMs?: number; composeTimeoutMs?: number; confirmTimeoutMs?: number; pollMs?: number; settleMs?: number } = {},
): Promise<BrowserSendResult> {
  const warmupTimeout = opts.warmupTimeoutMs ?? 25_000;
  const composeTimeout = opts.composeTimeoutMs ?? 25_000;
  const confirmTimeout = opts.confirmTimeoutMs ?? 15_000;
  const poll = opts.pollMs ?? 500;
  const settleMs = opts.settleMs ?? 1_200;
  // Date.now() is fine here — this is runtime tool code, not a replayed workflow.

  // 1. Warm up: load the mailbox and wait until it's the signed-in app (or a
  //    login page). A cold view often needs several seconds to boot Gmail.
  await wc.loadURL('https://mail.google.com/mail/u/0/#inbox');
  const warmDeadline = Date.now() + warmupTimeout;
  for (;;) {
    if (looksLikeLogin(wc.getURL())) return { status: 'login_required' };
    if (await wc.executeJavaScript(GMAIL_READY).catch(() => false) === true) break;
    if (Date.now() > warmDeadline) {
      if (looksLikeLogin(wc.getURL())) return { status: 'login_required' };
      break; // proceed anyway — compose may still work
    }
    await sleep(poll);
  }

  // 2. Open the pre-filled compose and wait for its Send button.
  await wc.loadURL(buildGmailComposeUrl(draft));
  const composeDeadline = Date.now() + composeTimeout;
  for (;;) {
    if (looksLikeLogin(wc.getURL())) return { status: 'login_required' };
    if (await wc.executeJavaScript(SEND_BUTTON_PRESENT).catch(() => false) === true) break;
    if (Date.now() > composeDeadline) {
      return looksLikeLogin(wc.getURL())
        ? { status: 'login_required' }
        : { status: 'no_compose', detail: 'The Gmail compose window did not appear in time.' };
    }
    await sleep(poll);
  }

  // 3. Click Send with a TRUSTED mouse event at its real coordinates. Gmail
  //    ignores synthetic element.click(); only a real CDP mouse event dispatches
  //    the send. Let the compose settle briefly first so the handler is bound.
  await sleep(settleMs);
  const rect = await wc.executeJavaScript(SEND_BUTTON_RECT).catch(() => null) as { x: number; y: number } | null;
  if (!rect || typeof rect.x !== 'number') {
    return { status: 'no_compose', detail: 'Could not locate Gmail’s Send button.' };
  }
  try {
    await wc.clickAt(rect.x, rect.y);
  } catch {
    return { status: 'no_compose', detail: 'Could not click Gmail’s Send button.' };
  }

  // 4. Fast path: Gmail's own "Message sent" toast.
  const toastDeadline = Date.now() + confirmTimeout;
  for (;;) {
    if (await wc.executeJavaScript(SENT_CONFIRMED).catch(() => false) === true) return { status: 'sent' };
    if (Date.now() > toastDeadline) break;
    await sleep(poll);
  }

  // 5. Authoritative fallback: the message now sits in the Sent folder. This
  //    survives a missed toast in a cold/hidden view.
  try {
    await wc.loadURL('https://mail.google.com/mail/u/0/#sent');
    const sentDeadline = Date.now() + confirmTimeout;
    const check = sentFolderHas(draft.subject);
    for (;;) {
      if (await wc.executeJavaScript(check).catch(() => false) === true) return { status: 'sent' };
      if (Date.now() > sentDeadline) break;
      await sleep(poll);
    }
  } catch { /* fall through to unconfirmed */ }

  return { status: 'unconfirmed', detail: 'Clicked Send, but could not confirm delivery. Check your Gmail Sent folder.' };
}
