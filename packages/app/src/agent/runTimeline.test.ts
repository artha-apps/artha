/**
 * Run timeline query (agent/runTimeline.ts): a run's own events plus the
 * plan-review events recorded under its workflow id before the run existed.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('../db/schema', () => ({ getDb: () => { throw new Error('no db in this test'); } }));

import { buildRunTimeline, type RunTimelineSource } from './runTimeline';
import type { RunEvent, RunEventKind } from './runEvents';

const ev = (runId: string, seq: number, ts: number, kind: RunEventKind, payload: unknown = {}): RunEvent => ({ runId, seq, ts, kind, payload });

function source(opts: {
  events: RunEvent[];
  runs: Array<{ runId: string; workflowId: string; createdAtMs: number }>;
}): RunTimelineSource {
  return {
    workflowOf: id => opts.runs.find(r => r.runId === id)?.workflowId ?? null,
    runsOfWorkflow: wf => opts.runs.filter(r => r.workflowId === wf).map(({ runId, createdAtMs }) => ({ runId, createdAtMs })),
    events: (id, limit) => opts.events.filter(e => e.runId === id).sort((a, b) => a.seq - b.seq).slice(0, limit),
  };
}

describe('buildRunTimeline', () => {
  it('returns only the run\'s own events when the workflow has none', () => {
    const src = source({
      runs: [{ runId: 'r1', workflowId: 'wf', createdAtMs: 10_000 }],
      events: [ev('r1', 1, 10_100, 'status'), ev('r1', 2, 10_200, 'done', { outcome: 'completed' })],
    });
    expect(buildRunTimeline('r1', src).map(e => e.seq)).toEqual([1, 2]);
  });

  it('links plan-review events recorded under the workflow id, before the run, marked linked', () => {
    const src = source({
      runs: [{ runId: 'r1', workflowId: 'wf', createdAtMs: 10_000 }],
      events: [
        ev('wf', 1, 9_000, 'interaction', { phase: 'request', interactionKind: 'plan' }),
        ev('wf', 2, 10_500, 'interaction', { phase: 'response', interactionKind: 'plan', status: 'answered' }), // same second as created_at
        ev('r1', 1, 10_600, 'plan'),
        ev('r1', 2, 11_000, 'done'),
      ],
    });
    const t = buildRunTimeline('r1', src);
    expect(t.map(e => `${e.runId}:${e.seq}`)).toEqual(['wf:1', 'wf:2', 'r1:1', 'r1:2']);
    expect(t[0].linked).toBe('workflow');
    expect(t[2].linked).toBeUndefined();
  });

  it('assigns each workflow event to exactly one run of the workflow', () => {
    const src = source({
      runs: [
        { runId: 'r1', workflowId: 'wf', createdAtMs: 10_000 },
        { runId: 'r2', workflowId: 'wf', createdAtMs: 20_000 },
      ],
      events: [
        ev('wf', 1, 9_000, 'interaction', { phase: 'request' }),   // → r1
        ev('wf', 2, 15_000, 'interaction', { phase: 'request' }),  // → r2
        ev('wf', 3, 30_000, 'interaction', { phase: 'request' }),  // after every run → latest (r2)
        ev('r1', 1, 10_100, 'status'),
        ev('r2', 1, 20_100, 'status'),
      ],
    });
    expect(buildRunTimeline('r1', src).map(e => `${e.runId}:${e.seq}`)).toEqual(['wf:1', 'r1:1']);
    expect(buildRunTimeline('r2', src).map(e => `${e.runId}:${e.seq}`)).toEqual(['wf:2', 'r2:1', 'wf:3']);
  });

  it('does not double-read when the run id equals the workflow id, and handles unknown runs', () => {
    const events = [ev('same', 1, 1, 'status')];
    const src = source({ runs: [{ runId: 'same', workflowId: 'same', createdAtMs: 0 }], events });
    expect(buildRunTimeline('same', src)).toHaveLength(1);
    expect(buildRunTimeline('nope', source({ runs: [], events }))).toEqual([]);
  });

  it('respects the limit after merging', () => {
    const src = source({
      runs: [{ runId: 'r1', workflowId: 'wf', createdAtMs: 10_000 }],
      events: [ev('wf', 1, 5, 'interaction'), ev('r1', 1, 10_100, 'status'), ev('r1', 2, 10_200, 'status')],
    });
    expect(buildRunTimeline('r1', src, 2).map(e => `${e.runId}:${e.seq}`)).toEqual(['wf:1', 'r1:1']);
  });
});
