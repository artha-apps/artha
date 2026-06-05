/**
 * Skill metrics tests. The aggregation itself is SQL (exercised against a real
 * DB at runtime and validated separately); here we mock getDb the same way the
 * rag scope tests do and assert the parts that live in TypeScript:
 *   - getSkillMetrics() derives successRate + estTimeSavedMs, zeros for unrun.
 *   - recordSkillRun() clamps/rounds/truncates and never throws on a DB error.
 *   - classifyHealth() flags degraded / slow / healthy / unknown correctly.
 *   - recommendModel() picks the best model by success then latency.
 *   - getSkillToolUsage() computes tighten (unused) + expand (forbidden) hints.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// Fake DB: prepare() returns an object exposing all() (queries), get() (single
// row), and run() (inserts). Tests set dbState.rows / dbState.getRow per case.
const { dbState } = vi.hoisted(() => ({
  dbState: { rows: [] as unknown[], getRow: undefined as unknown, runArgs: [] as unknown[], throwOnRun: false },
}));
vi.mock('../db/schema', () => ({
  getDb: () => ({
    prepare: (_sql: string) => ({
      all: () => dbState.rows,
      get: () => dbState.getRow,
      run: (...args: unknown[]) => {
        if (dbState.throwOnRun) throw new Error('db locked');
        dbState.runArgs = args;
      },
    }),
  }),
}));

import {
  getSkillMetrics, recordSkillRun, classifyHealth, recommendModel, getSkillToolUsage,
} from './metrics';

beforeEach(() => {
  dbState.rows = [];
  dbState.getRow = undefined;
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
    expect(m.estTimeSavedMs).toBe(570_000); // 3 × (90k + 20k×5)
    expect(m.isBuiltin).toBe(true);
    expect(m.lastRunAt).toBe(1000);
    expect(m.health).toBeDefined(); // attached even if 'unknown'
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
      goal: 'x'.repeat(900), status: 'ok', matchedVia: 'explicit',
      toolCalls: 3.7, toolErrors: -2, durationMs: 1234.9,
    });
    const a = dbState.runArgs;
    expect(a[4]).toHaveLength(500); // goal truncated
    expect(a[7]).toBe(4);           // 3.7 → 4
    expect(a[8]).toBe(0);           // -2 clamped to 0
    expect(a[9]).toBe(1235);        // 1234.9 → 1235
  });

  it('swallows DB errors (a metrics write must never break a run)', () => {
    dbState.throwOnRun = true;
    expect(() => recordSkillRun({
      skillId: 's1', slug: 'research', goal: 'g',
      status: 'error', matchedVia: 'auto', toolCalls: 0, toolErrors: 0, durationMs: 0,
    })).not.toThrow();
  });
});

describe('classifyHealth', () => {
  it('flags a success-rate regression as degraded', () => {
    const h = classifyHealth({
      total: 8, recent_n: 5, recent_ok: 1, recent_dur: 9000,
      prior_n: 3, prior_ok: 3, prior_dur: 5000,
    });
    expect(h.status).toBe('degraded');
    expect(h.recentSuccessRate).toBeCloseTo(0.2);
    expect(h.priorSuccessRate).toBeCloseTo(1);
  });

  it('flags a slowdown when success held but latency jumped', () => {
    const h = classifyHealth({
      total: 10, recent_n: 5, recent_ok: 5, recent_dur: 10000,
      prior_n: 5, prior_ok: 5, prior_dur: 4000,
    });
    expect(h.status).toBe('slow');
  });

  it('is healthy when stable', () => {
    const h = classifyHealth({
      total: 10, recent_n: 5, recent_ok: 5, recent_dur: 4200,
      prior_n: 5, prior_ok: 5, prior_dur: 4000,
    });
    expect(h.status).toBe('healthy');
  });

  it('is unknown below the minimum run count, or on a garbage row', () => {
    expect(classifyHealth({ total: 3, recent_n: 3, recent_ok: 3 }).status).toBe('unknown');
    expect(classifyHealth({}).status).toBe('unknown');
  });

  it('does not treat user cancellations as a regression', () => {
    // Raw recent looks like 3/5 = 60% vs prior 100% (would be "degraded"), but 2
    // of the recent runs were cancelled by the user. Excluding them, recent is
    // 3/3 = 100% — healthy.
    const h = classifyHealth({
      total: 10, recent_n: 5, recent_ok: 3, recent_cancelled: 2, recent_dur: 5000,
      prior_n: 5, prior_ok: 5, prior_cancelled: 0, prior_dur: 5000,
    });
    expect(h.status).toBe('healthy');
    expect(h.recentSuccessRate).toBeCloseTo(1);
  });
});

describe('recommendModel', () => {
  it('picks the highest success rate among models with enough runs', () => {
    const best = recommendModel([
      { model: 'phi3', runs: 5, successes: 1, successRate: 0.2, avgDurationMs: 9000 },
      { model: 'llama3:70b', runs: 3, successes: 3, successRate: 1, avgDurationMs: 5000 },
    ]);
    expect(best).toBe('llama3:70b');
  });

  it('tie-breaks equal success rates by lower latency', () => {
    const best = recommendModel([
      { model: 'slow', runs: 4, successes: 4, successRate: 1, avgDurationMs: 8000 },
      { model: 'fast', runs: 4, successes: 4, successRate: 1, avgDurationMs: 3000 },
    ]);
    expect(best).toBe('fast');
  });

  it('returns null when no model has enough runs', () => {
    expect(recommendModel([{ model: 'x', runs: 2, successes: 2, successRate: 1, avgDurationMs: 100 }])).toBeNull();
  });
});

describe('getSkillToolUsage', () => {
  it('flags granted-but-unused tools (tighten) and forbidden-but-tried tools (expand)', () => {
    // tool_receipts rows for this skill's runs. browser_click is a regular
    // (non-ambient) registry tool, so an allowlist that omits it genuinely
    // forbids it — unlike desktop_/memory_ which are always appended.
    dbState.rows = [
      { tool: 'web_search', calls: 2, errors: 0, blocked: 0 },
      { tool: 'browser_click', calls: 1, errors: 1, blocked: 0 }, // tried + errored, not allowed
    ];
    // The skill's allowlist: a web_ prefix (used) + fs_read_file (never used).
    dbState.getRow = { allowed_tools_json: JSON.stringify(['web_', 'fs_read_file']) };

    const u = getSkillToolUsage('s1');
    expect(u.allowlistEmpty).toBe(false);
    expect(u.grantedButUnused).toEqual(['fs_read_file']);   // web_ matched web_search
    expect(u.expandHints).toEqual(['browser_click']);        // errored, outside allowlist
    expect(u.tools.find(t => t.tool === 'web_search')?.allowed).toBe(true);
    expect(u.tools.find(t => t.tool === 'browser_click')?.allowed).toBe(false);
  });

  it('treats an empty allowlist as all-allowed (no expand hints)', () => {
    dbState.rows = [{ tool: 'web_search', calls: 1, errors: 1, blocked: 0 }];
    dbState.getRow = { allowed_tools_json: '[]' };
    const u = getSkillToolUsage('s1');
    expect(u.allowlistEmpty).toBe(true);
    expect(u.expandHints).toEqual([]);
    expect(u.tools[0].allowed).toBe(true);
  });

  it('never flags always-on ambient tools (memory_/desktop_/invoke_capability)', () => {
    // memory_store is appended regardless of the allowlist; even though it
    // errored and isn't in the ['fs_'] allowlist, it must read as allowed and
    // must NOT be suggested as something to add.
    dbState.rows = [{ tool: 'memory_store', calls: 2, errors: 1, blocked: 0 }];
    dbState.getRow = { allowed_tools_json: JSON.stringify(['fs_']) };
    const u = getSkillToolUsage('s1');
    expect(u.tools[0].allowed).toBe(true);
    expect(u.expandHints).toEqual([]);
  });
});
