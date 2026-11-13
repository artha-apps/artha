/** Run Inspector event timeline reducer (lib/runTimeline.ts). */
import { describe, it, expect } from 'vitest';
import { reduceRunTimeline, type TimelineEventLike } from './runTimeline';

let seq = 0;
const ev = (kind: string, payload: unknown, extra: Partial<TimelineEventLike> = {}): TimelineEventLike =>
  ({ runId: 'r1', seq: ++seq, ts: seq * 1000, kind, payload, ...extra });

describe('reduceRunTimeline', () => {
  it('pairs a tool call with its result and drops heartbeats and steps', () => {
    const rows = reduceRunTimeline([
      ev('tool_call', { name: 'fs_read_file' }),
      ev('heartbeat', { idleMs: 10_000 }),
      ev('step', { idx: 0, kind: 'tool' }),
      ev('tool_result', { name: 'fs_read_file', status: 'ok' }),
      ev('tool_call', { name: 'web_fetch' }),
      ev('tool_result', { name: 'web_fetch', status: 'blocked' }),
    ]);
    expect(rows.map(r => [r.type, r.title, r.detail, r.tone])).toEqual([
      ['tool', 'fs_read_file', 'ok', 'ok'],
      ['tool', 'web_fetch', 'blocked', 'warn'],
    ]);
  });

  it('pairs interaction request/response by id, keeps unanswered ones waiting', () => {
    const rows = reduceRunTimeline([
      ev('interaction', { phase: 'request', interactionId: 'i1', interactionKind: 'plan' }, { runId: 'wf', linked: 'workflow' }),
      ev('interaction', { phase: 'response', interactionId: 'i1', interactionKind: 'plan', status: 'answered' }, { runId: 'wf', linked: 'workflow' }),
      ev('interaction', { phase: 'request', approvalId: 'a1', toolName: 'email_send' }),
      ev('interaction', { phase: 'response', approvalId: 'a1', approved: false }),
      ev('interaction', { phase: 'request', interactionId: 'i2', interactionKind: 'ask' }),
    ]);
    expect(rows.map(r => [r.title, r.detail, r.tone, !!r.linked])).toEqual([
      ['Plan review', 'answered', 'ok', true],
      ['Approval for email_send', 'denied', 'warn', false],
      ['Question for you', 'waiting for you', 'info', false],
    ]);
  });

  it('an approval prompt that expired reads "expired (no answer)", never "denied"', () => {
    const rows = reduceRunTimeline([
      ev('interaction', { phase: 'request', approvalId: 'a9', toolName: 'fs_copy_file' }),
      ev('interaction', { phase: 'response', approvalId: 'a9', approved: false, expired: true }),
    ]);
    expect(rows.map(r => [r.title, r.detail, r.tone])).toEqual([['Approval for fs_copy_file', 'expired (no answer)', 'warn']]);
  });

  it('renders goal gate, kill switch, stalls, errors and the loop outcome honestly', () => {
    const rows = reduceRunTimeline([
      ev('status', { source: 'goal_gate', action: 'continue', gaps: ['no file written'], round: 1 }),
      ev('stalled', { idleMs: 61_000, note: 'no run activity; run status unchanged' }),
      ev('status', { source: 'kill_switch', reason: 'stopped_by_user' }),
      ev('error', { message: 'boom' }),
      ev('done', { outcome: 'cancelled' }),
    ]);
    expect(rows.map(r => [r.type, r.title, r.tone])).toEqual([
      ['goal_gate', 'Goal check: continue', 'warn'],
      ['stalled', 'No activity for 61s', 'warn'],
      ['kill_switch', 'Stopped with the stop shortcut', 'danger'],
      ['error', 'Error', 'danger'],
      ['done', 'Run ended (cancelled)', 'warn'],
    ]);
    expect(rows[0].detail).toBe('Gaps: no file written');
    expect(rows[1].detail).toBe('run status unchanged');
    // The loop's own "completed" is never presented as verified success.
    const [done] = reduceRunTimeline([ev('done', { outcome: 'completed' })]);
    expect(done.title).toBe('Run ended (completed)');
    expect(done.tone).toBe('muted');
  });

  it('shows plain status text and plans, and tolerates malformed payloads', () => {
    const rows = reduceRunTimeline([
      ev('status', { text: 'Reading files…' }),
      ev('plan', { goal: 'Tidy', steps: [{}, {}] }),
      ev('status', null),
      ev('tool_result', { name: 'orphan', status: 'error' }),
      ev('mystery', {}),
    ]);
    expect(rows.map(r => [r.type, r.title])).toEqual([
      ['status', 'Reading files…'],
      ['plan', 'Plan: 2 steps'],
      ['tool', 'orphan'],
    ]);
    expect(new Set(rows.map(r => r.key)).size).toBe(rows.length);
  });
});
