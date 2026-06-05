/**
 * Skill metrics tests. The aggregation itself is SQL (exercised against a real
 * DB at runtime); here we mock getDb the same way the rag scope tests do and
 * assert the parts that live in TypeScript:
 *   - getSkillMetrics() derives successRate + estTimeSavedMs correctly, and
 *     reports zeros (never null) for a skill that has never run.
 *   - recordSkillRun() inserts with clamped, rounded numeric fields and a
 *     truncated goal, and never throws on a DB error.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// Fake DB: prepare() returns an object exposing both all() (for the aggregate
// query) and run() (for inserts). We stash the canned rows + capture run args.
const { dbState } = vi.hoisted(() => ({
  dbState: { rows: [] as unknown[], runArgs: [] as unknown[], throwOnRun: false },
}));
vi.mock('../db/schema', () => ({
  getDb: () => ({
    prepare: (_sql: string) => ({
      all: () => dbState.rows,
      run: (...args: unknown[]) => {
        if (dbState.throwOnRun) throw new Error('db locked');
        dbState.runArgs = args;
      },
    }),
  }),
}));

import { getSkillMetrics, recordSkillRun } from './metrics';

beforeEach(() => {
  dbState.rows = [];
  dbState.runArgs = [];
  dbState.throwOnRun = false;
});

describe('getSkillMetrics', () => {
  it('derives success rate and a time-saved estimate from aggregate rows', () => {
    dbState.rows = [{
      skill_id: 's1', slug: 'research', name: 'Web Research', icon: '🔎',
      is_enabled: 1, is_builtin: 1,
      runs: 4, successes: 3, errors: 1, cancelled: 0,
      avg_tool_calls: 5, avg_duration_ms: 12000, last_run_at: 1000,
      via_explicit: 2, via_auto: 1, via_invoke: 1,
    }];
    const [m] = getSkillMetrics();
    expect(m.successRate).toBeCloseTo(0.75);
    // 3 successes × (90_000 baseline + 20_000 × 5 tools) = 3 × 190_000.
    expect(m.estTimeSavedMs).toBe(570_000);
    expect(m.isBuiltin).toBe(true);
    expect(m.isEnabled).toBe(true);
    expect(m.lastRunAt).toBe(1000);
  });

  it('reports zeros (not null) for a skill that has never run', () => {
    dbState.rows = [{
      skill_id: 's2', slug: 'organize', name: 'File Organizer', icon: '🗂️',
      is_enabled: 1, is_builtin: 0,
      runs: 0, successes: 0, errors: 0, cancelled: 0,
      avg_tool_calls: 0, avg_duration_ms: 0, last_run_at: null,
      via_explicit: 0, via_auto: 0, via_invoke: 0,
    }];
    const [m] = getSkillMetrics();
    expect(m.runs).toBe(0);
    expect(m.successRate).toBe(0);
    expect(m.estTimeSavedMs).toBe(0);
    expect(m.lastRunAt).toBeNull();
  });
});

describe('recordSkillRun', () => {
  it('clamps + rounds numeric fields and truncates the goal', () => {
    recordSkillRun({
      skillId: 's1', slug: 'research', runId: 'r1', sessionId: 'sess1',
      goal: 'x'.repeat(900),
      status: 'ok', matchedVia: 'explicit',
      toolCalls: 3.7, toolErrors: -2, durationMs: 1234.9,
    });
    // Positional INSERT order: skill_id, slug, run_id, session_id, goal,
    // status, matched_via, tool_calls, tool_errors, duration_ms.
    const a = dbState.runArgs;
    expect(a[4]).toHaveLength(500);          // goal truncated
    expect(a[7]).toBe(4);                     // 3.7 → 4
    expect(a[8]).toBe(0);                     // -2 clamped to 0
    expect(a[9]).toBe(1235);                  // 1234.9 → 1235
  });

  it('swallows DB errors (a metrics write must never break a run)', () => {
    dbState.throwOnRun = true;
    expect(() => recordSkillRun({
      skillId: 's1', slug: 'research', goal: 'g',
      status: 'error', matchedVia: 'auto',
      toolCalls: 0, toolErrors: 0, durationMs: 0,
    })).not.toThrow();
  });
});
