import { describe, it, expect } from 'vitest';
import { detectsWebAction, shouldNudgeToAct, type ActGuardState } from './actGuard';

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
