/**
 * Tests for the pure automation rules: frequency floor, jitter bounds, missed
 * slot detection, failure streaks, notify policy, scope confinement and
 * fail-closed webhook authorisation.
 */
import { describe, it, expect } from 'vitest';
import {
  validateSchedule, minCronIntervalSeconds, applyJitter, findMissedSlot, nextFailureState,
  shouldNotify, summaryHash, isFolderWithinScopes, authorizeWebhook, generateWebhookToken,
  promptNeedsGoogle, JITTER_SECONDS, type CatchUpFields,
} from './automationPolicy';

describe('validateSchedule (15-minute floor)', () => {
  it('rejects schedules tighter than every 15 minutes with a reason', () => {
    for (const cron of ['* * * * *', '*/5 * * * *', '0,10 9 * * *', '*/30 * * * * *']) {
      const r = validateSchedule(cron);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toMatch(/at most every 15 minutes/);
    }
  });

  it('accepts every-15-minutes and slower schedules, and no cron at all', () => {
    expect(validateSchedule('*/15 * * * *')).toEqual({ ok: true });
    expect(validateSchedule('0 8 * * 1-5')).toEqual({ ok: true });
    expect(validateSchedule('0 * * * *')).toEqual({ ok: true });
    expect(validateSchedule(null)).toEqual({ ok: true });
  });

  it('rejects an invalid expression with a reason', () => {
    const r = validateSchedule('not a cron');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/not a valid cron/);
  });

  it('measures the minimum gap between fires', () => {
    expect(minCronIntervalSeconds('0 * * * *')).toBe(3600);
    expect(minCronIntervalSeconds('0,5 9 * * *')).toBe(300);
  });
});

describe('applyJitter', () => {
  const slot = new Date('2026-01-01T09:00:00Z');
  const now = new Date('2026-01-01T08:00:00Z');
  it('stays within ±90 s of the slot', () => {
    expect(applyJitter(slot, now, () => 0).getTime()).toBe(slot.getTime() - JITTER_SECONDS * 1000);
    expect(applyJitter(slot, now, () => 1).getTime()).toBe(slot.getTime() + JITTER_SECONDS * 1000);
    expect(applyJitter(slot, now, () => 0.5).getTime()).toBe(slot.getTime());
  });
  it('never lands in the past', () => {
    const late = new Date(slot.getTime() - 10_000);
    expect(applyJitter(slot, late, () => 0).getTime()).toBeGreaterThan(late.getTime());
  });
});

describe('findMissedSlot', () => {
  const base: CatchUpFields = {
    cron: '0 8 * * *', fire_at: null, is_enabled: 1, pause_reason: null,
    last_run_at: 1_000, next_due_at: 10_000, last_catchup_slot: null,
  };
  it('returns the armed slot when it passed without a run', () => {
    expect(findMissedSlot(base, 20_000)).toBe(10_000);
  });
  it('returns null once that slot was caught up (never twice)', () => {
    expect(findMissedSlot({ ...base, last_catchup_slot: 10_000 }, 20_000)).toBeNull();
  });
  it('returns null when a run covered the slot, the slot is future, or the task is paused', () => {
    expect(findMissedSlot({ ...base, last_run_at: 10_000 - 30 }, 20_000)).toBeNull();
    expect(findMissedSlot(base, 5_000)).toBeNull();
    expect(findMissedSlot({ ...base, pause_reason: 'x' }, 20_000)).toBeNull();
    expect(findMissedSlot({ ...base, is_enabled: 0 }, 20_000)).toBeNull();
  });
  it('catches up a never-run one-shot whose time passed', () => {
    const one = { ...base, cron: null, fire_at: 10_000, next_due_at: null, last_run_at: null };
    expect(findMissedSlot(one, 20_000)).toBe(10_000);
    expect(findMissedSlot({ ...one, last_run_at: 15_000 }, 20_000)).toBeNull();
  });
});

describe('nextFailureState', () => {
  it('auto-pauses on the third consecutive failure', () => {
    let s = nextFailureState(0, 'error');
    expect(s).toEqual({ consecutive: 1, pauseReason: null });
    s = nextFailureState(s.consecutive, 'error');
    expect(s.pauseReason).toBeNull();
    s = nextFailureState(s.consecutive, 'error');
    expect(s.consecutive).toBe(3);
    expect(s.pauseReason).toMatch(/3 consecutive failed runs/);
  });
  it('resets on success; holds do not count', () => {
    expect(nextFailureState(2, 'ok').consecutive).toBe(0);
    expect(nextFailureState(2, 'held')).toEqual({ consecutive: 2, pauseReason: null });
  });
});

describe('shouldNotify', () => {
  const h = summaryHash('ok', 'No new invoices.');
  it('on_change suppresses an identical summary (whitespace/case-insensitive)', () => {
    expect(shouldNotify('on_change', 'ok', summaryHash('ok', '  no new   invoices. '), h)).toBe(false);
    expect(shouldNotify('on_change', 'ok', summaryHash('ok', '2 new invoices.'), h)).toBe(true);
    expect(shouldNotify('on_change', 'ok', h, null)).toBe(true);
  });
  it('a status change counts as a change', () => {
    expect(shouldNotify('on_change', 'error', summaryHash('error', 'No new invoices.'), h)).toBe(true);
  });
  it('on_failure only notifies for non-verified outcomes; always always does', () => {
    expect(shouldNotify('on_failure', 'ok', h, null)).toBe(false);
    expect(shouldNotify('on_failure', 'unverified', h, null)).toBe(true);
    expect(shouldNotify('on_failure', 'error', h, null)).toBe(true);
    expect(shouldNotify('always', 'ok', h, h)).toBe(true);
  });
});

describe('isFolderWithinScopes', () => {
  it('allows the scope itself and its subfolders only', () => {
    const scopes = ['/home/u/Inbox'];
    expect(isFolderWithinScopes('/home/u/Inbox', scopes)).toBe(true);
    expect(isFolderWithinScopes('/home/u/Inbox/scans', scopes)).toBe(true);
    expect(isFolderWithinScopes('/home/u/InboxOther', scopes)).toBe(false);
    expect(isFolderWithinScopes('/home/u/Inbox/../Secrets', scopes)).toBe(false);
    expect(isFolderWithinScopes('relative/path', scopes)).toBe(false);
    expect(isFolderWithinScopes('/home/u/Inbox', [])).toBe(false);
  });
});

describe('authorizeWebhook (fails closed)', () => {
  const token = generateWebhookToken();
  const task = { is_enabled: 1, webhook_enabled: 1, webhook_token: token };
  it('rejects a request without a token', () => {
    expect(authorizeWebhook(task, undefined)).toMatchObject({ ok: false, status: 401 });
    expect(authorizeWebhook(task, '')).toMatchObject({ ok: false, status: 401 });
  });
  it('rejects when the task has no token or the webhook is off (default)', () => {
    expect(authorizeWebhook({ ...task, webhook_token: null }, token)).toMatchObject({ ok: false, status: 403 });
    expect(authorizeWebhook({ ...task, webhook_enabled: 0 }, token)).toMatchObject({ ok: false, status: 403 });
    expect(authorizeWebhook(undefined, token)).toMatchObject({ ok: false, status: 404 });
  });
  it('rejects a wrong token and a paused task; accepts the right one', () => {
    expect(authorizeWebhook(task, token.replace(/.$/, c => (c === 'a' ? 'b' : 'a')))).toMatchObject({ ok: false, status: 401 });
    expect(authorizeWebhook(task, 'short')).toMatchObject({ ok: false, status: 401 });
    expect(authorizeWebhook({ ...task, is_enabled: 0 }, token)).toMatchObject({ ok: false, status: 409 });
    expect(authorizeWebhook(task, token)).toEqual({ ok: true });
  });
  it('mints 256-bit hex tokens', () => {
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(generateWebhookToken()).not.toBe(token);
  });
});

describe('promptNeedsGoogle', () => {
  it('flags mail/calendar prompts only', () => {
    expect(promptNeedsGoogle('Summarise my Gmail inbox')).toBe(true);
    expect(promptNeedsGoogle('Check my calendar for tomorrow')).toBe(true);
    expect(promptNeedsGoogle('Tidy the Downloads folder')).toBe(false);
  });
});
