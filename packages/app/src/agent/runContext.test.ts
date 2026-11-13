/**
 * The unattended guarantee: every scheduler trigger runs inside
 * runWithContext({ unattended: true }) (main.ts), and inside that context a
 * confirm-tier tool — including the email_send always-confirm floor — must
 * fail closed instead of waiting on an approval modal nobody will answer.
 */
import { describe, it, expect, vi } from 'vitest';

// evaluatePolicy reads tool_policies; an empty table (or a DB error) must
// still leave email_send at 'confirm'.
vi.mock('../db/schema', () => ({
  getDb: () => ({ prepare: () => ({ all: () => [] }) }),
}));

import { runWithContext, getRunContext, confirmTierMustFailClosed } from './runContext';
import { evaluatePolicy } from '../bodhi/policy';

describe('unattended runs block confirm-tier tools', () => {
  it('a scheduler run fails closed on email_send, across awaits', async () => {
    await runWithContext({ actor: 'scheduler', lan: false, unattended: true }, async () => {
      await new Promise(r => setTimeout(r, 1));
      expect(evaluatePolicy('email_send', { to: 'a@b.c' }).tier).toBe('confirm');
      expect(confirmTierMustFailClosed(getRunContext())).toBe(true);
    });
  });

  it('LAN runs also fail closed', () => {
    runWithContext({ actor: 'lan:x', lan: true }, () => {
      expect(confirmTierMustFailClosed()).toBe(true);
    });
  });

  it('the interactive desktop path (no context / attended) can ask a human', () => {
    expect(confirmTierMustFailClosed(undefined)).toBe(false);
    runWithContext({ actor: 'local', lan: false }, () => {
      expect(confirmTierMustFailClosed()).toBe(false);
    });
  });
});
