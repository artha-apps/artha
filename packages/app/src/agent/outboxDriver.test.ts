/**
 * OutboxDriver policy tests. A fake orchestrator stands in for handleMessage:
 * each started turn is a controllable "run" that calls runStarted() before its
 * first await and runEnded() when the test finishes it. Real outbox SQL runs
 * against in-memory SQLite, so ordering/claim behaviour is the production SQL.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../db/schema', () => ({ getDb: () => { throw new Error('use explicit test db'); } }));

import * as ob from './outbox';
import { OutboxDriver, injectSteerAtBoundary } from './outboxDriver';
import { makeOutboxTestDb } from './outboxTestDb';
import type { OutboxDb } from './outbox';

/** A fake run started by the driver (or by a direct user send). */
interface FakeRun { content: string; finish: (o?: { cancelled?: boolean }) => void }

let db: OutboxDb;
let driver: OutboxDriver;
let runs: FakeRun[];
let persisted: string[];
let events: Array<{ channel: string; payload: unknown }>;
let approvalPending: boolean;

/** Flush microtasks so `void tryDrain()` chains settle. */
const tick = () => new Promise(r => setTimeout(r, 0));

beforeEach(() => {
  db = makeOutboxTestDb(['s1']);
  runs = [];
  persisted = [];
  events = [];
  approvalPending = false;
  driver = new OutboxDriver({
    db,
    persistUserMessage: (_sid, content) => { persisted.push(content); },
    startTurn: (sid, content) => {
      driver.runStarted(sid); // like handleMessage: synchronous, before any await
      return new Promise<void>(resolve => {
        runs.push({ content, finish: (o) => { driver.runEnded(sid, o); resolve(); } });
      });
    },
    hasPendingApproval: () => approvalPending,
    emit: (channel, payload) => { events.push({ channel, payload }); },
  });
});

/** Begin a user-initiated run (not from the outbox). */
function startUserRun(): FakeRun {
  driver.runStarted('s1');
  const run: FakeRun = { content: '(user)', finish: (o) => driver.runEnded('s1', o) };
  runs.push(run);
  return run;
}

describe('OutboxDriver', () => {
  it('three queued items run in order with no loss or duplication', async () => {
    const userRun = startUserRun();
    ob.enqueue('s1', 'one', null, db);
    ob.enqueue('s1', 'two', null, db);
    ob.enqueue('s1', 'three', null, db);
    // Active run: nothing drains even if asked.
    expect(await driver.tryDrain('s1')).toBeNull();

    userRun.finish();
    await tick();
    expect(runs.map(r => r.content)).toEqual(['(user)', 'one']);
    // Only one turn at a time: a spurious drain during run "one" does nothing.
    expect(await driver.tryDrain('s1')).toBeNull();
    runs[1].finish(); await tick();
    runs[2].finish(); await tick();
    runs[3].finish(); await tick();

    expect(runs.map(r => r.content)).toEqual(['(user)', 'one', 'two', 'three']);
    expect(persisted).toEqual(['one', 'two', 'three']);
    expect(ob.list('s1', db)).toEqual([]);
    const sent = events.filter(e => e.channel === 'outbox:sent');
    expect(sent).toHaveLength(3);
  });

  it('a failed run still drains the next item', async () => {
    ob.enqueue('s1', 'one', null, db);
    ob.enqueue('s1', 'two', null, db);
    const failing = new OutboxDriver({
      db,
      persistUserMessage: (_s, c) => { persisted.push(c); },
      startTurn: async (sid, content) => {
        failing.runStarted(sid);
        try { if (content === 'one') throw new Error('model down'); }
        finally { failing.runEnded(sid); }
      },
      hasPendingApproval: () => false,
      emit: (channel, payload) => { events.push({ channel, payload }); },
    });
    await failing.tryDrain('s1');
    await tick();
    expect(persisted).toEqual(['one', 'two']);
    expect(events.some(e => e.channel === 'outbox:turnFailed')).toBe(true);
  });

  it('pause holds the queue across run end; resume drains', async () => {
    const run = startUserRun();
    ob.enqueue('s1', 'held', null, db);
    ob.pause('s1', 'user', db);
    run.finish(); await tick();
    expect(runs).toHaveLength(1);
    expect(persisted).toEqual([]);
    ob.resume('s1', db);
    await driver.tryDrain('s1');
    expect(runs.map(r => r.content)).toEqual(['(user)', 'held']);
  });

  it('reorder is respected by the drain', async () => {
    const run = startUserRun();
    const a = ob.enqueue('s1', 'a', null, db);
    const b = ob.enqueue('s1', 'b', null, db);
    const c = ob.enqueue('s1', 'c', null, db);
    ob.reorder('s1', [c.id, b.id, a.id], db);
    run.finish(); await tick();
    runs[1].finish(); await tick();
    runs[2].finish(); await tick();
    expect(runs.slice(1).map(r => r.content)).toEqual(['c', 'b', 'a']);
  });

  it('steer-now injects at the next boundary and marks the item sent', async () => {
    startUserRun();
    ob.enqueue('s1', 'later', null, db);
    const s = ob.enqueue('s1', 'change course', null, db);
    expect(await driver.requestSteer(s.id)).toBe(true);
    expect(driver.pendingSteers('s1')).toEqual([s.id]);

    const injected = driver.takeSteerAtBoundary('s1');
    expect(injected.map(i => i.content)).toEqual(['change course']);
    expect(ob.getItem(s.id, db)?.status).toBe('sent');
    expect(persisted).toEqual(['change course']);
    // Consumed: a second boundary injects nothing (no duplication).
    expect(driver.takeSteerAtBoundary('s1')).toEqual([]);
    expect(ob.list('s1', db).map(i => i.content)).toEqual(['later']);
    expect(events.some(e => e.channel === 'outbox:sent' && (e.payload as { mode: string }).mode === 'steer')).toBe(true);
  });

  it('steer with no boundary before run end falls back to the normal drain, first', async () => {
    const run = startUserRun();
    ob.enqueue('s1', 'queued-first', null, db);
    const s = ob.enqueue('s1', 'steer me', null, db);
    await driver.requestSteer(s.id);
    run.finish(); await tick();
    expect(runs.map(r => r.content)).toEqual(['(user)', 'steer me']);
    expect(driver.pendingSteers('s1')).toEqual([]);
  });

  it('steer waits while an approval is pending at the boundary', async () => {
    startUserRun();
    const s = ob.enqueue('s1', 'steer', null, db);
    await driver.requestSteer(s.id);
    approvalPending = true;
    expect(driver.takeSteerAtBoundary('s1')).toEqual([]);
    approvalPending = false;
    expect(driver.takeSteerAtBoundary('s1').map(i => i.id)).toEqual([s.id]);
  });

  it('never auto-sends while a confirm/plan approval is pending', async () => {
    ob.enqueue('s1', 'wait', null, db);
    approvalPending = true;
    expect(await driver.tryDrain('s1')).toBeNull();
    expect(persisted).toEqual([]);
    approvalPending = false;
    expect((await driver.tryDrain('s1'))?.content).toBe('wait');
  });

  it('a cancelled run does not drain and pauses the queue with reason=cancel', async () => {
    const run = startUserRun();
    ob.enqueue('s1', 'after', null, db);
    run.finish({ cancelled: true }); await tick();
    expect(runs).toHaveLength(1);
    expect(persisted).toEqual([]);
    expect(ob.getPauseState('s1', db)).toEqual({ paused: true, reason: 'cancel' });
    const upd = events.filter(e => e.channel === 'outbox:updated').pop()?.payload as { pausedReason: string };
    expect(upd.pausedReason).toBe('cancel');
    // Still held on a later drain attempt until the user resumes.
    expect(await driver.tryDrain('s1')).toBeNull();
    ob.resume('s1', db);
    expect((await driver.tryDrain('s1'))?.content).toBe('after');
  });

  it('double-drain race: concurrent drains hand off each item exactly once', async () => {
    ob.enqueue('s1', 'only', null, db);
    // Two drivers over the same DB (e.g. a duplicated end-of-run signal) with
    // independent in-memory state — only the DB claim can arbitrate.
    const other = new OutboxDriver({
      db,
      persistUserMessage: (_s, c) => { persisted.push(c); },
      startTurn: () => new Promise<void>(() => { /* never ends */ }),
      hasPendingApproval: () => false,
      emit: () => {},
    });
    const [x, y] = await Promise.all([driver.tryDrain('s1'), other.tryDrain('s1')]);
    expect(persisted).toEqual(['only']);
    expect([x, y].filter(v => v === null)).toHaveLength(1);
  });

  it('a persist failure returns the item to ready instead of losing it', async () => {
    const flaky = new OutboxDriver({
      db,
      persistUserMessage: () => { throw new Error('disk full'); },
      startTurn: async () => {},
      hasPendingApproval: () => false,
      emit: () => {},
    });
    const a = ob.enqueue('s1', 'keep me', null, db);
    expect(await flaky.tryDrain('s1')).toBeNull();
    expect(ob.getItem(a.id, db)?.status).toBe('ready');
  });

  it('injectSteerAtBoundary appends the steer as a user turn in the live conversation', async () => {
    startUserRun();
    const s = ob.enqueue('s1', 'use the 2025 file instead', null, db);
    await driver.requestSteer(s.id);
    const messages: Array<{ role: string; content?: unknown }> = [
      { role: 'system', content: 'sys' }, { role: 'user', content: 'goal' },
      { role: 'assistant', content: '' }, { role: 'tool', content: 'result' },
    ];
    const injected = injectSteerAtBoundary(driver, 's1', messages);
    expect(injected).toHaveLength(1);
    expect(messages).toHaveLength(5);
    expect(messages[4].role).toBe('user');
    expect(String(messages[4].content)).toContain('use the 2025 file instead');
    // Nothing requested → no-op.
    expect(injectSteerAtBoundary(driver, 's1', messages)).toEqual([]);
    expect(messages).toHaveLength(5);
  });

  it('a run ending with an empty queue still notifies active=false', async () => {
    const run = startUserRun();
    run.finish(); await tick();
    const last = events.filter(e => e.channel === 'outbox:updated').pop()?.payload as { active: boolean } | undefined;
    expect(last?.active).toBe(false);
  });
});
