/**
 * Skill metrics — record one row per skill invocation and aggregate it into the
 * per-skill stats shown on the Skills dashboard.
 *
 * The `skill_runs` table (see db/schema.ts) is the source of truth: a single row
 * is written when a skill finishes executing, carrying its outcome, how it was
 * reached, and the tool work it did. Aggregation happens in SQL so the dashboard
 * stays cheap even with thousands of runs.
 *
 * "Estimated time saved" is an explicit heuristic, not a measurement: a
 * successful run is assumed to replace a manual task whose length scales with how
 * many tools the agent had to drive. It is labelled as an estimate in the UI.
 */
import { getDb } from '../db/schema';

/** Outcome of a skill invocation, mapped from the agent_runs terminal status. */
export type SkillRunStatus = 'ok' | 'error' | 'cancelled';

/** How the skill was reached for this run. */
export type SkillMatchedVia = 'explicit' | 'auto' | 'invoke';

/** Everything we persist for a single skill invocation. */
export interface SkillRunInput {
  skillId: string;
  slug: string;
  runId?: string | null;
  sessionId?: string | null;
  goal: string;
  status: SkillRunStatus;
  matchedVia: SkillMatchedVia;
  toolCalls: number;
  toolErrors: number;
  durationMs: number;
}

/** Per-skill aggregate row returned to the renderer for the dashboard. */
export interface SkillMetric {
  skillId: string;
  slug: string;
  name: string;
  icon: string;
  isEnabled: boolean;
  isBuiltin: boolean;
  runs: number;
  successes: number;
  errors: number;
  cancelled: number;
  /** successes / runs (0 when never run). */
  successRate: number;
  avgToolCalls: number;
  avgDurationMs: number;
  /** Unix epoch (seconds) of the most recent run, or null if never run. */
  lastRunAt: number | null;
  /** Breakdown of how runs were triggered. */
  viaExplicit: number;
  viaAuto: number;
  viaInvoke: number;
  /** Heuristic estimate (ms) of manual effort saved across successful runs. */
  estTimeSavedMs: number;
}

// ── Time-saved heuristic ──────────────────────────────────────────────────────
// A successful automated task is credited with replacing a manual one. We assume
// a fixed baseline plus a per-tool-step cost (each tool call is roughly one
// manual action: find a file, open a page, copy a value…). Deliberately modest
// and transparent; surfaced in the UI as an estimate, never as a hard number.
const MANUAL_BASELINE_MS = 90_000;   // 1.5 min of setup/thinking per task
const MANUAL_PER_TOOL_MS = 20_000;   // ~20s per manual step the agent automated

/** Persist one skill invocation. Best-effort: a metrics write must never break a
 *  run, so all failures are swallowed (the dashboard simply misses that row). */
export function recordSkillRun(input: SkillRunInput): void {
  try {
    getDb().prepare(`
      INSERT INTO skill_runs
        (skill_id, slug, run_id, session_id, goal, status, matched_via, tool_calls, tool_errors, duration_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.skillId,
      input.slug,
      input.runId ?? null,
      input.sessionId ?? null,
      input.goal.slice(0, 500),
      input.status,
      input.matchedVia,
      Math.max(0, Math.round(input.toolCalls)),
      Math.max(0, Math.round(input.toolErrors)),
      Math.max(0, Math.round(input.durationMs)),
    );
  } catch (err) {
    console.warn('[Artha] recordSkillRun failed (non-critical):', err);
  }
}

/** Raw aggregate row shape returned by the GROUP BY query. */
interface MetricRow {
  skill_id: string;
  slug: string;
  name: string;
  icon: string;
  is_enabled: number;
  is_builtin: number;
  runs: number;
  successes: number;
  errors: number;
  cancelled: number;
  avg_tool_calls: number;
  avg_duration_ms: number;
  last_run_at: number | null;
  via_explicit: number;
  via_auto: number;
  via_invoke: number;
}

/** Per-skill metrics for every skill (including ones never run, with zeros),
 *  ordered most-used first then alphabetically. The renderer can re-sort. */
export function getSkillMetrics(): SkillMetric[] {
  // LEFT JOIN so skills with no runs still appear. SQLite evaluates a boolean
  // expression to 1/0, so SUM(status='ok') counts matching rows.
  const rows = getDb().prepare(`
    SELECT
      s.skill_id                                  AS skill_id,
      s.slug                                      AS slug,
      s.name                                      AS name,
      s.icon                                      AS icon,
      s.is_enabled                                AS is_enabled,
      s.is_builtin                                AS is_builtin,
      COUNT(r.skill_run_id)                       AS runs,
      COALESCE(SUM(r.status = 'ok'), 0)           AS successes,
      COALESCE(SUM(r.status = 'error'), 0)        AS errors,
      COALESCE(SUM(r.status = 'cancelled'), 0)    AS cancelled,
      COALESCE(AVG(r.tool_calls), 0)              AS avg_tool_calls,
      COALESCE(AVG(r.duration_ms), 0)             AS avg_duration_ms,
      MAX(r.created_at)                           AS last_run_at,
      COALESCE(SUM(r.matched_via = 'explicit'), 0) AS via_explicit,
      COALESCE(SUM(r.matched_via = 'auto'), 0)     AS via_auto,
      COALESCE(SUM(r.matched_via = 'invoke'), 0)   AS via_invoke
    FROM skills s
    LEFT JOIN skill_runs r ON r.skill_id = s.skill_id
    GROUP BY s.skill_id
    ORDER BY runs DESC, s.name ASC
  `).all() as MetricRow[];

  return rows.map((r) => {
    const successRate = r.runs > 0 ? r.successes / r.runs : 0;
    const avgToolCalls = r.avg_tool_calls;
    const estTimeSavedMs = Math.round(
      r.successes * (MANUAL_BASELINE_MS + MANUAL_PER_TOOL_MS * avgToolCalls)
    );
    return {
      skillId: r.skill_id,
      slug: r.slug,
      name: r.name,
      icon: r.icon,
      isEnabled: !!r.is_enabled,
      isBuiltin: !!r.is_builtin,
      runs: r.runs,
      successes: r.successes,
      errors: r.errors,
      cancelled: r.cancelled,
      successRate,
      avgToolCalls,
      avgDurationMs: Math.round(r.avg_duration_ms),
      lastRunAt: r.last_run_at,
      viaExplicit: r.via_explicit,
      viaAuto: r.via_auto,
      viaInvoke: r.via_invoke,
      estTimeSavedMs,
    };
  });
}
