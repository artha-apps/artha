/**
 * email_compose tests.
 *
 * Context: a founder-reported failure — "send an email" errored, because
 * Artha had no email capability at all (43 built-in tools, none for mail;
 * the Google scope is gmail.readonly). This tool closes the gap by preparing
 * a draft in the user's own mail client. The tests below exist mainly to pin
 * the honesty contract: it must never report that mail was sent.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { opened } = vi.hoisted(() => ({ opened: { urls: [] as string[], fail: false } }));
vi.mock('electron', () => ({
  shell: {
    openExternal: vi.fn(async (url: string) => {
      if (opened.fail) throw new Error('no handler for mailto');
      opened.urls.push(url);
    }),
  },
}));

import { invokeEmailTool, isEmailTool, EMAIL_TOOL_SCHEMAS } from './email';

beforeEach(() => { opened.urls = []; opened.fail = false; });

const call = (args: Record<string, unknown>) => invokeEmailTool('email_compose', args);

describe('honesty contract', () => {
  it('reports drafted, never sent', async () => {
    const out = JSON.parse(await call({ to: 'a@b.com', subject: 'Hi', body: 'Hello' }));
    expect(out.drafted).toBe(true);
    expect(out.sent).toBe(false);
    expect(out.user_action_required).toMatch(/press send/i);
    expect(out.user_action_required).toMatch(/cannot send it for you/i);
  });

  it('the tool description forbids claiming the mail was sent', () => {
    const d = EMAIL_TOOL_SCHEMAS[0].function.description ?? '';
    expect(d).toMatch(/does NOT send/i);
    expect(d).toMatch(/Never tell the user their email has been sent/i);
  });
});

describe('mailto construction', () => {
  it('encodes subject and body so ampersands do not truncate the message', async () => {
    await call({ to: 'a@b.com', subject: 'Q3 & Q4', body: 'Revenue & margin up. 50% > target' });
    const url = opened.urls[0];
    expect(url.startsWith('mailto:a%40b.com?')).toBe(true);
    // A raw '&' inside the body would end the parameter and silently drop text.
    const body = new URL(url).searchParams.get('body');
    expect(body).toBe('Revenue & margin up. 50% > target');
    expect(new URL(url).searchParams.get('subject')).toBe('Q3 & Q4');
  });

  it('spaces survive as spaces, not plus signs', async () => {
    await call({ to: 'a@b.com', subject: 'Weekly update', body: 'See attached notes' });
    expect(opened.urls[0]).toContain('%20');
    expect(opened.urls[0]).not.toMatch(/subject=Weekly\+update/);
  });

  it('includes cc and bcc only when provided', async () => {
    await call({ to: 'a@b.com', subject: 's', body: 'b', cc: 'c@d.com' });
    const p = new URL(opened.urls[0]).searchParams;
    expect(p.get('cc')).toBe('c@d.com');
    expect(p.has('bcc')).toBe(false);
  });
});

describe('input validation happens before the OS is involved', () => {
  it('rejects a missing recipient', async () => {
    expect(await call({ to: '', subject: 's', body: 'b' })).toMatch(/^Error: "to" is required/);
    expect(opened.urls).toEqual([]);
  });

  it('rejects malformed addresses and names them', async () => {
    const out = await call({ to: 'not-an-address, ok@x.com', subject: 's', body: 'b' });
    expect(out).toMatch(/^Error:/);
    expect(out).toMatch(/not-an-address/);
    expect(opened.urls).toEqual([]);
  });

  it('rejects an entirely empty message', async () => {
    expect(await call({ to: 'a@b.com', subject: '', body: '' })).toMatch(/nothing to compose/i);
  });
});

describe('failure reporting', () => {
  it('says the draft was NOT opened when the mail client cannot be launched', async () => {
    opened.fail = true;
    const out = await call({ to: 'a@b.com', subject: 's', body: 'b' });
    expect(out).toMatch(/^Error:/);
    expect(out).toMatch(/draft was not opened/i);
  });

  it('warns instead of silently truncating a very long message', async () => {
    const out = JSON.parse(await call({ to: 'a@b.com', subject: 's', body: 'x'.repeat(3000) }));
    expect(out.warning).toMatch(/truncate/i);
    expect(out.sent).toBe(false);
  });

  it('routes only its own tool name', () => {
    expect(isEmailTool('email_compose')).toBe(true);
    expect(isEmailTool('fs_read_file')).toBe(false);
  });
});
