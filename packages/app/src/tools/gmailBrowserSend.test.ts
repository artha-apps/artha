/**
 * Browser-backed Gmail send tests.
 *
 * The flow is proven live against real Gmail; these pin the state machine so a
 * regression can't turn "couldn't confirm" into a false "sent". A fake
 * webContents records loadURL and answers executeJavaScript by inspecting the
 * injected snippet — no Electron required.
 */
import { describe, it, expect } from 'vitest';
import { sendViaBrowser, buildGmailComposeUrl, type SendableWebContents } from './gmailBrowserSend';

const DRAFT = { to: 'jk@example.com', subject: 'Hey this is Artha', body: 'Hello! yes or No?' };
const FAST = { composeTimeoutMs: 300, confirmTimeoutMs: 300, pollMs: 10 };

/** Build a fake webContents whose page behaviour is scripted by flags. */
function fakeWc(opts: {
  url?: string;
  sendButton?: boolean;          // is the Send button present?
  clickReturns?: string;         // what CLICK_SEND returns
  confirmedAfter?: number;       // number of SENT_CONFIRMED polls before it turns true
}): SendableWebContents & { loaded: string[] } {
  let confirmPolls = 0;
  return {
    loaded: [] as string[],
    async loadURL(u: string) { this.loaded.push(u); },
    getURL() { return opts.url ?? 'https://mail.google.com/mail/u/0/'; },
    async executeJavaScript(code: string) {
      if (code.includes('aria-label^="Send"') && code.includes('querySelector') && !code.includes('click')) {
        return !!opts.sendButton; // SEND_BUTTON_PRESENT
      }
      if (code.includes('b.click()')) return opts.clickReturns ?? 'CLICKED'; // CLICK_SEND
      if (code.includes('Message sent')) {                                   // SENT_CONFIRMED
        confirmPolls++;
        return opts.confirmedAfter === undefined ? true : confirmPolls >= opts.confirmedAfter;
      }
      return null;
    },
  };
}

describe('buildGmailComposeUrl', () => {
  it('produces a view=cm pre-filled compose URL with encoded fields', () => {
    const url = buildGmailComposeUrl({ to: 'a@b.com', subject: 'Q3 & Q4', body: 'yes or No?' });
    expect(url).toContain('https://mail.google.com/mail/?view=cm&fs=1');
    const q = new URL(url).searchParams;
    expect(q.get('to')).toBe('a@b.com');
    expect(q.get('su')).toBe('Q3 & Q4');
    expect(q.get('body')).toBe('yes or No?');
  });
});

describe('sendViaBrowser', () => {
  it('reports sent when Gmail shows "Message sent"', async () => {
    const wc = fakeWc({ sendButton: true, confirmedAfter: 1 });
    const r = await sendViaBrowser(wc, DRAFT, FAST);
    expect(r.status).toBe('sent');
    expect(wc.loaded[0]).toContain('view=cm');   // it navigated to the pre-filled compose
  });

  it('reports login_required when the page is a Google sign-in', async () => {
    const wc = fakeWc({ url: 'https://accounts.google.com/signin/v2/identifier', sendButton: false });
    const r = await sendViaBrowser(wc, DRAFT, FAST);
    expect(r.status).toBe('login_required');
  });

  it('reports no_compose when the Send button never appears', async () => {
    const wc = fakeWc({ sendButton: false });
    const r = await sendViaBrowser(wc, DRAFT, FAST);
    expect(r.status).toBe('no_compose');
  });

  it('reports unconfirmed (NOT sent) when the click lands but no confirmation shows', async () => {
    const wc = fakeWc({ sendButton: true, clickReturns: 'CLICKED', confirmedAfter: 9999 });
    const r = await sendViaBrowser(wc, DRAFT, FAST);
    expect(r.status).toBe('unconfirmed');
    expect(r.detail).toMatch(/Sent folder/i);
  });

  it('reports no_compose when the Send button vanishes before the click', async () => {
    const wc = fakeWc({ sendButton: true, clickReturns: 'NO_SEND_BUTTON' });
    const r = await sendViaBrowser(wc, DRAFT, FAST);
    expect(r.status).toBe('no_compose');
  });
});
