/**
 * Outbox drain for Delegate sessions (orchestrator.startDelegateFollowUp):
 * the turn marks the session busy BEFORE its first await (skill resolution),
 * returns once the background capability run is started, and that run — not
 * the startTurn promise — ends the outbox turn. These tests pin the contract
 * that makes the drain behave like chat: one follow-up at a time, holds
 * respected, and a failed start releases the session.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../db/schema', () => ({ getDb: () => { throw new Error('use explicit test db'); } }));

import * as ob from './outbox';
import { OutboxDriver } from './outboxDriver';
import { makeOutboxTestDb } from './outboxTestDb';
import type { OutboxDb } from './outbox';

const tick = () => new Promise(r => setTimeout(r, 0));

let db: OutboxDb;
let driver: OutboxDriver;
/** Background capability runs started by the fake Delegate follow-up. */
let bgRuns: Array<{ content: string; end: (o?: { cancelled?: boolean }) => void }>;
let failSkill: boolean;
let approvalPending: boolean;

beforeEach(() => {
  db = makeOutboxTestDb(['d1']);
  bgRuns = [];
  failSkill = false;
  approvalPending = false;
  driver = new OutboxDriver({
    db,
    persistUserMessage: () => {},
    // Mirrors startDelegateFollowUp: hold, await skill, hand over to a
    // background run that ends the outbox turn itself.
    startTurn: async (sid, content) => {
      driver.runStarted(sid);
      let handedOver = false;
      try {
        await tick();
        if (failSkill) throw new Error('skill resolution failed');
        bgRuns.push({ content, end: (o) => driver.runEnded(sid, o) });
        handedOver = true;
      } finally {
        if (!handedOver) driver.runEnded(sid);
      }
    },
    hasPendingApproval: () => approvalPending,
    emit: () => {},
  });
});

describe('Delegate follow-ups through the outbox', () => {
  it('drains one follow-up at a time: the next waits for the background run', async () => {
    driver.runStarted('d1'); // the Delegate run the user is watching
    ob.enqueue('d1', 'first follow-up', [], db);
    ob.enqueue('d1', 'second follow-up', [], db);
    driver.runEnded('d1');
    await tick(); await tick();
    expect(bgRuns.map(r => r.content)).toEqual(['first follow-up']);
    // startTurn already resolved, but the session is still busy.
    expect(driver.isActive('d1')).toBe(true);
    bgRuns[0].end();
    await tick(); await tick();
    expect(bgRuns.map(r => r.content)).toEqual(['first follow-up', 'second follow-up']);
  });

  it('never drains past a pending approval, and Stop pauses the queue', async () => {
    driver.runStarted('d1');
    ob.enqueue('d1', 'queued', [], db);
    approvalPending = true;
    driver.runEnded('d1');
    await tick(); await tick();
    expect(bgRuns).toHaveLength(0);
    approvalPending = false;
    driver.runStarted('d1');
    driver.runEnded('d1', { cancelled: true, reason: 'cancel' });
    await tick();
    expect(bgRuns).toHaveLength(0);
    expect(ob.getPauseState('d1', db)).toMatchObject({ paused: true });
  });

  it('a failed start releases the session instead of leaving it stuck busy', async () => {
    failSkill = true;
    ob.enqueue('d1', 'will fail', [], db);
    await driver.tryDrain('d1');
    await tick(); await tick();
    expect(bgRuns).toHaveLength(0);
    expect(driver.isActive('d1')).toBe(false);
  });
});
