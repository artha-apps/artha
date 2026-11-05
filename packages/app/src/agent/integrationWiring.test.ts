/**
 * Cross-slice wiring on the integration branch:
 *   - ask_user / plan interactions are mirrored into the run event log as
 *     `interaction` events (confirm/handoff are not — no double entries);
 *   - the hub exposes live pending interactions with their session, so the
 *     outbox can refuse to drain past one;
 *   - the kill switch pause reason ('stop') round-trips and a kill-stopped
 *     turn pauses the queue with it instead of draining;
 *   - scheduled runs resolve to the `unattended` permission mode, where
 *     confirm-tier and floor tools fail closed and ask_user still runs (and
 *     returns "unanswered" without opening a card).
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('../db/schema', () => ({ getDb: () => { throw new Error('use explicit test db'); } }));

import { InteractionHub } from './interactions';
import { installInteractionRunEvents, interactionRunEventPayload } from './interactionRunEvents';
import * as ob from './outbox';
import { OutboxDriver } from './outboxDriver';
import { makeOutboxTestDb } from './outboxTestDb';
import { decideToolCall, resolveEffectiveMode, type ToolCallGateInput } from './modes';
import { runAskUser } from './askUser';
import { confirmTierMustFailClosed } from './runContext';
import { InMemoryGrantStore } from '../bodhi/grants';

/** Hub whose persistence always fails — it then runs purely in memory. */
const memHub = () => new InteractionHub(() => { throw new Error('no db in this test'); });

describe('interaction → run event mirroring', () => {
  it('records request + response for ask and plan, nothing for confirm/handoff', async () => {
    const hub = memHub();
    const recorded: Array<{ runId: string; kind: string; payload: unknown }> = [];
    installInteractionRunEvents(hub, (runId, kind, payload) => { recorded.push({ runId, kind, payload }); });

    const ask = hub.open({ runId: 'run-1', workflowId: 'wf-1', kind: 'ask', payload: { sessionId: 's1' } });
    hub.settle(ask.interaction.id, 'answered', { a: 1 });
    const plan = hub.open({ runId: 'wf-2', workflowId: 'wf-2', kind: 'plan', payload: { sessionId: 's1' } });
    hub.settle(plan.interaction.id, 'declined');
    const conf = hub.open({ runId: 'run-1', workflowId: 'wf-1', kind: 'confirm', payload: {} });
    hub.settle(conf.interaction.id, 'answered');
    const ho = hub.open({ runId: 'wf-1', workflowId: 'wf-1', kind: 'handoff', payload: {} });
    hub.settle(ho.interaction.id, 'answered');
    await ask.outcome;

    expect(recorded.map(r => [r.runId, r.kind, (r.payload as { phase: string }).phase])).toEqual([
      ['run-1', 'interaction', 'request'],
      ['run-1', 'interaction', 'response'],
      ['wf-2', 'interaction', 'request'],
      ['wf-2', 'interaction', 'response'],
    ]);
    expect((recorded[1].payload as { status: string }).status).toBe('answered');
    expect((recorded[3].payload as { status: string }).status).toBe('declined');
  });

  it('install is idempotent and a throwing recorder never breaks the interaction', async () => {
    const hub = memHub();
    let calls = 0;
    installInteractionRunEvents(hub, () => { calls++; throw new Error('log down'); });
    installInteractionRunEvents(hub, () => { calls++; });
    const { interaction, outcome } = hub.open({ runId: 'r', kind: 'ask', payload: {} });
    expect(hub.settle(interaction.id, 'answered', 'x')).toBe(true);
    expect((await outcome).status).toBe('answered');
    expect(calls).toBe(2); // one observer (request + response), not two
  });

  it('pure payload helper ignores unmirrored kinds', () => {
    expect(interactionRunEventPayload({ phase: 'request', id: 'i', runId: 'r', kind: 'confirm' })).toBeNull();
    expect(interactionRunEventPayload({ phase: 'request', id: 'i', runId: 'r', kind: 'ask' }))
      .toEqual({ phase: 'request', interactionId: 'i', interactionKind: 'ask' });
  });
});

describe('outbox holds while an interaction is pending', () => {
  it('livePending reports the session until the interaction settles', () => {
    const hub = memHub();
    const { interaction } = hub.open({ runId: 'r', workflowId: 'wf', kind: 'ask', payload: { sessionId: 's1' } });
    expect(hub.livePending()).toEqual([{ id: interaction.id, kind: 'ask', workflowId: 'wf', sessionId: 's1' }]);
    hub.settle(interaction.id, 'declined');
    expect(hub.livePending()).toEqual([]);
  });

  it('a driver whose hasPendingApproval reads the hub does not drain past a pending ask', async () => {
    const db = makeOutboxTestDb(['s1']);
    const hub = memHub();
    const started: string[] = [];
    const driver = new OutboxDriver({
      db,
      persistUserMessage: () => {},
      startTurn: async (_sid, content) => { started.push(content); },
      hasPendingApproval: (sid) => hub.livePending().some(i => i.sessionId === sid),
      emit: () => {},
    });
    const { interaction } = hub.open({ runId: 'r', workflowId: 'wf', kind: 'ask', payload: { sessionId: 's1' } });
    ob.enqueue('s1', 'queued', null, db);
    expect(await driver.tryDrain('s1')).toBeNull();
    expect(started).toEqual([]);
    hub.settle(interaction.id, 'answered', {});
    expect((await driver.tryDrain('s1'))?.content).toBe('queued');
  });
});

describe('kill switch pauses the queue ("Queue paused after stop")', () => {
  it('pause reason stop round-trips', () => {
    const db = makeOutboxTestDb(['s1']);
    ob.pause('s1', 'stop', db);
    expect(ob.getPauseState('s1', db)).toEqual({ paused: true, reason: 'stop' });
    ob.resume('s1', db);
    expect(ob.getPauseState('s1', db)).toEqual({ paused: false, reason: null });
  });

  it('a kill-stopped turn pauses with reason stop and does not drain', async () => {
    const db = makeOutboxTestDb(['s1']);
    const started: string[] = [];
    const driver = new OutboxDriver({
      db, persistUserMessage: () => {}, startTurn: async (_s, c) => { started.push(c); },
      hasPendingApproval: () => false, emit: () => {},
    });
    driver.runStarted('s1');
    ob.enqueue('s1', 'next', null, db);
    driver.runEnded('s1', { cancelled: true, reason: 'stop' });
    await new Promise(r => setTimeout(r, 0));
    expect(started).toEqual([]);
    expect(ob.getPauseState('s1', db)).toEqual({ paused: true, reason: 'stop' });
  });
});

describe('scheduled runs use the unattended permission mode', () => {
  const schedulerCtx = { actor: 'scheduler' as const, lan: false, unattended: true };
  const base = (over: Partial<ToolCallGateInput>): ToolCallGateInput => ({
    toolName: 'fs_read_file', args: {}, mode: resolveEffectiveMode('auto', true, schedulerCtx),
    policy: { tier: 'auto' } as ToolCallGateInput['policy'], isFloor: false,
    attended: !confirmTierMustFailClosed(schedulerCtx), roots: [], planApproved: false,
    subjects: [], grants: new InMemoryGrantStore(), ...over,
  });

  it('resolves to unattended whatever the chat mode', () => {
    for (const m of ['ask', 'auto', 'plan', 'accept_edits'] as const) {
      expect(resolveEffectiveMode(m, true, schedulerCtx)).toBe('unattended');
    }
    expect(confirmTierMustFailClosed(schedulerCtx)).toBe(true);
  });

  it('confirm-tier tools and the email_send floor fail closed', async () => {
    const confirm = await decideToolCall(base({ toolName: 'web_fetch', policy: { tier: 'confirm' } as ToolCallGateInput['policy'] }));
    expect(confirm.action).toBe('block');
    const floor = await decideToolCall(base({ toolName: 'email_send', isFloor: true, policy: { tier: 'confirm' } as ToolCallGateInput['policy'] }));
    expect(floor.action).toBe('block');
  });

  it('ask_user is allowed by the gate (even in plan mode) and returns unanswered without a card', async () => {
    expect((await decideToolCall(base({ toolName: 'ask_user' }))).action).toBe('run');
    expect((await decideToolCall(base({ toolName: 'ask_user', mode: 'plan', attended: true }))).action).toBe('run');
    const hub = memHub();
    const res = await runAskUser(
      { questions: [{ question: 'Which folder?', options: [{ label: 'A' }, { label: 'B' }] }] },
      { unattended: confirmTierMustFailClosed(schedulerCtx), runId: 'r', workflowId: 'wf', sessionId: 's', hub },
    );
    expect(res).toMatch(/unanswered/);
    expect(hub.livePending()).toEqual([]);
  });
});
