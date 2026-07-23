import { describe, it, expect } from 'vitest';
import {
  detectsWebAction,
  shouldNudgeToAct,
  detectsSendIntent,
  shouldNudgeToSend,
  compactStaleDomDumps,
  type ActGuardState,
  type CompactableMessage,
} from './actGuard';

/** Base state: a web-action goal where the model returned prose and never
 *  touched the browser — the exact "gives reasoning instead of sending" bug. */
function narratedEmail(overrides: Partial<ActGuardState> = {}): ActGuardState {
  return {
    goal: 'Send an email to alex@example.com saying I will be late',
    browserToolCalls: 0,
    mutationCount: 0,
    nudges: 0,
    maxNudges: 2,
    content: 'Sure! To send that email, open Gmail, click Compose, then type the recipient and message.',
    ...overrides,
  };
}

describe('detectsWebAction', () => {
  it('recognises email-send requests', () => {
    expect(detectsWebAction('send an email to alex@example.com')).toBe(true);
    expect(detectsWebAction('compose a message to the team in gmail')).toBe(true);
    expect(detectsWebAction('reply to that email for me')).toBe(true);
    expect(detectsWebAction('forward the mail to my accountant')).toBe(true);
  });

  it('recognises other web actions', () => {
    expect(detectsWebAction('fill out the contact form on their site')).toBe(true);
    expect(detectsWebAction('post this update')).toBe(true);
    expect(detectsWebAction('book a table for two')).toBe(true);
    expect(detectsWebAction('sign in to my account')).toBe(true);
    expect(detectsWebAction('do this in the browser')).toBe(true);
    expect(detectsWebAction('order it on the website')).toBe(true);
  });

  it('ignores non-web tasks (no false positives that would hijack normal chat)', () => {
    expect(detectsWebAction('summarise this PDF')).toBe(false);
    expect(detectsWebAction('move my screenshots into a folder')).toBe(false);
    expect(detectsWebAction('what is the capital of France?')).toBe(false);
    expect(detectsWebAction('explain how email works')).toBe(false);
  });
});

describe('shouldNudgeToAct — the narrate-instead-of-act backstop', () => {
  it('REPRODUCES the bug: prose reply on an email goal with no browser action ⇒ nudge', () => {
    expect(shouldNudgeToAct(narratedEmail())).toBe(true);
  });

  it('does NOT nudge once the model has actually driven the browser', () => {
    // It navigated/typed/clicked, then returned text — trust that as a real result.
    expect(shouldNudgeToAct(narratedEmail({ browserToolCalls: 3 }))).toBe(false);
  });

  it('does NOT nudge when the reply is a genuine clarifying question', () => {
    expect(
      shouldNudgeToAct(narratedEmail({ content: "What's the recipient's email address?" })),
    ).toBe(false);
  });

  it('does NOT nudge non-web tasks', () => {
    expect(
      shouldNudgeToAct(narratedEmail({ goal: 'summarise the report and save it' })),
    ).toBe(false);
  });

  it('does NOT nudge when real work already happened (mutations present)', () => {
    expect(shouldNudgeToAct(narratedEmail({ mutationCount: 2 }))).toBe(false);
  });

  it('is bounded — stops nudging once the cap is reached so the loop can never hang', () => {
    expect(shouldNudgeToAct(narratedEmail({ nudges: 2, maxNudges: 2 }))).toBe(false);
    expect(shouldNudgeToAct(narratedEmail({ nudges: 1, maxNudges: 2 }))).toBe(true);
  });
});

describe('compactStaleDomDumps', () => {
  const bigDom = (url: string) =>
    JSON.stringify({ url, title: 'Inbox', text: 'x'.repeat(12_000), truncated: true });

  /** A realistic transcript: two read_dom calls interleaved with other tool
   *  results, plus a non-read_dom browser call that must be left alone. */
  function transcript(): CompactableMessage[] {
    return [
      { role: 'system', content: 'prompt' },
      { role: 'user', content: 'send an email' },
      { role: 'tool', tool_call_id: 'nav-1', content: '{"navigated":true}' },
      { role: 'tool', tool_call_id: 'dom-1', content: bigDom('https://mail/inbox') },
      { role: 'tool', tool_call_id: 'type-1', content: '{"typed_into":"#to"}' },
      { role: 'tool', tool_call_id: 'dom-2', content: bigDom('https://mail/compose') },
    ];
  }

  it('stubs every read_dom result except the most recent', () => {
    const msgs = transcript();
    const compacted = compactStaleDomDumps(msgs, new Set(['dom-1', 'dom-2']));

    expect(compacted).toBe(1);
    // dom-1 is now a tiny stub that still carries url/title for orientation…
    const stub = JSON.parse(msgs[3].content as string);
    expect(stub.url).toBe('https://mail/inbox');
    expect(stub.title).toBe('Inbox');
    expect(stub.note).toMatch(/omitted/i);
    expect((msgs[3].content as string).length).toBeLessThan(400);
    // …while the latest DOM (dom-2) is left fully intact.
    expect((msgs[5].content as string).length).toBeGreaterThan(12_000);
  });

  it('leaves non-read_dom tool results untouched', () => {
    const msgs = transcript();
    compactStaleDomDumps(msgs, new Set(['dom-1', 'dom-2']));
    expect(msgs[2].content).toBe('{"navigated":true}');
    expect(msgs[4].content).toBe('{"typed_into":"#to"}');
  });

  it('is idempotent — a second pass compacts nothing new', () => {
    const msgs = transcript();
    compactStaleDomDumps(msgs, new Set(['dom-1', 'dom-2']));
    expect(compactStaleDomDumps(msgs, new Set(['dom-1', 'dom-2']))).toBe(0);
  });

  it('does nothing with a single read_dom (nothing is stale yet)', () => {
    const msgs: CompactableMessage[] = [
      { role: 'tool', tool_call_id: 'dom-1', content: bigDom('https://mail/inbox') },
    ];
    expect(compactStaleDomDumps(msgs, new Set(['dom-1']))).toBe(0);
    expect((msgs[0].content as string).length).toBeGreaterThan(12_000);
  });
});

describe('detectsSendIntent', () => {
  it('fires on real send-email goals', () => {
    for (const g of [
      'Send an email to jkscanada@gmail.com saying hello',
      'email jane@x.com about the Q3 numbers',
      'compose and send the email to the team',
      'forward that message to my boss',
      'send it to alex@example.com',
    ]) expect(detectsSendIntent(g), g).toBe(true);
  });

  it('does NOT fire on read/summarize goals', () => {
    for (const g of [
      'read my latest email and summarize it',
      'check if I have any new messages',
      'draft a note for later', // draft ≠ send
      'find the invoice in my inbox',
    ]) expect(detectsSendIntent(g), g).toBe(false);
  });
});

describe('shouldNudgeToSend', () => {
  const base = {
    goal: 'Send an email to jkscanada@gmail.com saying hi',
    sendConfirmed: false, nudges: 0, maxNudges: 2, content: 'I have prepared the email draft for you.',
  };
  it('nudges when a send goal ended without a confirmed send', () => {
    expect(shouldNudgeToSend(base)).toBe(true);
  });
  it('does NOT nudge once a send is confirmed', () => {
    expect(shouldNudgeToSend({ ...base, sendConfirmed: true })).toBe(false);
  });
  it('stops nudging at the cap', () => {
    expect(shouldNudgeToSend({ ...base, nudges: 2 })).toBe(false);
  });
  it('does NOT nudge on a genuine clarifying question', () => {
    expect(shouldNudgeToSend({ ...base, content: 'Who should I send it to?' })).toBe(false);
  });
  it('does NOT nudge on a non-send goal', () => {
    expect(shouldNudgeToSend({ ...base, goal: 'summarize my inbox' })).toBe(false);
  });
});
