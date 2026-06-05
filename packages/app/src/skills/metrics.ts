/**
 * Skill metrics — record one row per skill invocation and aggregate it into the
 * per-skill stats + insights shown on the Skills dashboard.
 *
 * The `skill_runs` table (see db/schema.ts) is the source of truth: a single row
 * is written when a skill finishes executing, carrying its outcome, how it was
 * reached, and the tool work it did. It links to agent_runs (the model used) and
 * tool_receipts (per-tool calls), which the insight queries below join back to.
 *
 * Four insight dimensions are derived here, each from a different facet of the
 * same ledger:
 *   - getSkillMetrics()      : headline stats + a HEALTH verdict (time dimension)
 *   - getSkillModelStats()   : success/latency broken down by model (model dim.)
 *   - getSkillToolUsage()    : granted-vs-actually-called tools (tool/security)
 *   - getSkillFailures()     : recent failed runs for forensics (lineage dim.)
 *
 * "Estimated time saved" is an explicit heuristic, not a measurement; it is
 * labelled as an estimate in the UI.
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

/** Health verdict for a skill, comparing its recent window to its prior runs. */
export interface SkillHealth {
  status: 'healthy' | 'degraded' | 'slow' | 'unknown';
  reason: string;
  recentSuccessRate: number;
  priorSuccessRate: number;
  recentAvgDurationMs: number;
  priorAvgDurationMs: number;
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
  /** Regression/health verdict (time dimension). */
  health: SkillHealth;
}

/** One model's track record for a skill (model dimension). */
export interface SkillModelStat {
  model: string;
  runs: number;
  successes: number;
  successRate: number;
  avgDurationMs: number;
}

/** Per-skill model breakdown + a data-backed recommendation + the current pin. */
export interface SkillModelStats {
  models: SkillModelStat[];
  /** Model with the best track record (enough runs), or null if undecidable. */
  recommended: string | null;
  /** The model the skill is currently pinned to, or null = auto-route. */
  currentPin: string | null;
}

/** One tool's usage under a skill (tool dimension). */
export interface SkillToolStat {
  tool: string;
  calls: number;
  errors: number;
  blocked: number;
  /** Whether the skill's allowlist currently permits this tool. */
  allowed: boolean;
}

/** Per-skill tool usage + least-privilege tuning suggestions. */
export interface SkillToolUsage {
  tools: SkillToolStat[];
  /** Allowlist entries that were granted but never used — candidates to remove. */
  grantedButUnused: string[];
  /** Tools the skill tried (and errored on) that its allowlist doesn't permit —
   *  candidates to add. Empty when the allowlist is empty (all tools allowed). */
  expandHints: string[];
  /** True when the allowlist is empty (every tool permitted). */
  allowlistEmpty: boolean;
}

/** A failed/cancelled run for the forensics drill-down (lineage dimension). */
export interface SkillFailure {
  runId: string | null;
  sessionId: string | null;
  goal: string;
  status: SkillRunStatus;
  matchedVia: SkillMatchedVia;
  toolErrors: number;
  durationMs: number;
  createdAt: number;
}

// ── Time-saved heuristic ──────────────────────────────────────────────────────
const MANUAL_BASELINE_MS = 90_000;   // 1.5 min of setup/thinking per task
const MANUAL_PER_TOOL_MS = 20_000;   // ~20s per manual step the agent automated

// ── Health thresholds ─────────────────────────────────────────────────────────
const HEALTH_MIN_RUNS = 5;   // below this, no verdict (status 'unknown')
const RECENT_WINDOW = 5;     // the last N runs count as "recent"
const MIN_SEGMENT = 3;       // need ≥N in each of recent/prior to compare
const SUCCESS_DROP = 0.25;   // recent rate ≥25pts below prior ⇒ degraded
const SLOWDOWN = 1.75;       // recent ≥1.75× prior duration ⇒ slow

// ── Recommendation threshold ──────────────────────────────────────────────────
const MODEL_MIN_RUNS = 3;    // a model needs ≥N runs to be recommendable

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

/** Raw aggregate row shape returned by the headline GROUP BY query. */
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

/** Raw row from the windowed recent-vs-prior health query. */
interface HealthRow {
  skill_id: string;
  total: number;
  recent_n: number;
  recent_ok: number;
  recent_cancelled: number;
  recent_dur: number | null;
  prior_n: number;
  prior_ok: number;
  prior_cancelled: number;
  prior_dur: number | null;
}

const UNKNOWN_HEALTH: SkillHealth = {
  status: 'unknown', reason: 'Not enough runs yet',
  recentSuccessRate: 0, priorSuccessRate: 0, recentAvgDurationMs: 0, priorAvgDurationMs: 0,
};

/** Classify one skill's health from its recent-vs-prior segments. Tolerant of
 *  partial/garbage rows (returns 'unknown') so it never throws into a render. */
export function classifyHealth(r: Partial<HealthRow>): SkillHealth {
  // Cancellations are user decisions, not skill failures — exclude them from the
  // success signal (and from latency, which would be partial). "Effective" counts
  // are the non-cancelled runs in each window, and drive both the enough-data
  // gate and the comparison, so a burst of recent cancels can't fake a regression.
  const recentEff = (Number(r.recent_n) || 0) - (Number(r.recent_cancelled) || 0);
  const priorEff = (Number(r.prior_n) || 0) - (Number(r.prior_cancelled) || 0);
  if (recentEff + priorEff < HEALTH_MIN_RUNS) return UNKNOWN_HEALTH;

  const recentRate = recentEff > 0 ? (Number(r.recent_ok) || 0) / recentEff : 0;
  const priorRate = priorEff > 0 ? (Number(r.prior_ok) || 0) / priorEff : 0;
  const recentDur = Number(r.recent_dur) || 0;
  const priorDur = Number(r.prior_dur) || 0;
  const comparable = recentEff >= MIN_SEGMENT && priorEff >= MIN_SEGMENT;
  const pct = (x: number) => `${Math.round(x * 100)}%`;
  const secs = (ms: number) => `${(ms / 1000).toFixed(1)}s`;

  let status: SkillHealth['status'] = 'healthy';
  let reason = 'Stable';
  if (comparable && recentRate <= priorRate - SUCCESS_DROP) {
    status = 'degraded';
    reason = `Success fell from ${pct(priorRate)} to ${pct(recentRate)} over the last ${recentEff} runs`;
  } else if (comparable && priorDur > 0 && recentDur >= priorDur * SLOWDOWN) {
    status = 'slow';
    reason = `~${(recentDur / priorDur).toFixed(1)}× slower recently (${secs(priorDur)} → ${secs(recentDur)})`;
  }

  return {
    status, reason,
    recentSuccessRate: recentRate,
    priorSuccessRate: priorRate,
    recentAvgDurationMs: Math.round(recentDur),
    priorAvgDurationMs: Math.round(priorDur),
  };
}

/** Build a skillId → health map from the windowed query. */
function healthMap(): Map<string, SkillHealth> {
  const m = new Map<string, SkillHealth>();
  try {
    const rows = getDb().prepare(`
      WITH ranked AS (
        SELECT skill_id, status, duration_ms,
               -- rowid is the monotonic insertion counter; skill_run_id is a
               -- RANDOM hex PK, so it must NOT be the recency tiebreak. created_at
               -- only has 1s resolution, so rowid breaks same-second ties as true
               -- arrival order.
               ROW_NUMBER() OVER (PARTITION BY skill_id ORDER BY created_at DESC, rowid DESC) AS rn
        FROM skill_runs
      )
      SELECT skill_id,
        COUNT(*)                                          AS total,
        SUM(CASE WHEN rn <= @k THEN 1 ELSE 0 END)         AS recent_n,
        SUM(CASE WHEN rn <= @k THEN (status='ok') ELSE 0 END) AS recent_ok,
        SUM(CASE WHEN rn <= @k THEN (status='cancelled') ELSE 0 END) AS recent_cancelled,
        AVG(CASE WHEN rn <= @k AND status != 'cancelled' THEN duration_ms END) AS recent_dur,
        SUM(CASE WHEN rn >  @k THEN 1 ELSE 0 END)         AS prior_n,
        SUM(CASE WHEN rn >  @k THEN (status='ok') ELSE 0 END) AS prior_ok,
        SUM(CASE WHEN rn >  @k THEN (status='cancelled') ELSE 0 END) AS prior_cancelled,
        AVG(CASE WHEN rn >  @k AND status != 'cancelled' THEN duration_ms END) AS prior_dur
      FROM ranked GROUP BY skill_id
    `).all({ k: RECENT_WINDOW }) as HealthRow[];
    for (const r of rows) m.set(r.skill_id, classifyHealth(r));
  } catch (err) {
    console.warn('[Artha] skill health query failed (non-critical):', err);
  }
  return m;
}

/** Per-skill metrics for every skill (including ones never run, with zeros),
 *  ordered most-used first then alphabetically. The renderer can re-sort. */
export function getSkillMetrics(): SkillMetric[] {
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

  const health = healthMap();

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
      health: health.get(r.skill_id) ?? UNKNOWN_HEALTH,
    };
  });
}

/** Pick the best model from a breakdown: highest success rate among models with
 *  enough runs, tie-broken by lower latency. Null if none qualify. */
export function recommendModel(models: SkillModelStat[]): string | null {
  const eligible = models.filter(m => m.runs >= MODEL_MIN_RUNS);
  if (!eligible.length) return null;
  const best = [...eligible].sort(
    (a, b) => b.successRate - a.successRate || a.avgDurationMs - b.avgDurationMs
  )[0];
  return best?.model ?? null;
}

/** Per-skill success/latency broken down by the model that ran each invocation,
 *  plus a recommendation and the current pin (model dimension). */
export function getSkillModelStats(skillId: string): SkillModelStats {
  const db = getDb();
  const rows = db.prepare(`
    SELECT ar.model                         AS model,
           COUNT(*)                         AS runs,
           COALESCE(SUM(sr.status='ok'), 0) AS successes,
           COALESCE(AVG(sr.duration_ms), 0) AS avg_duration_ms
    FROM skill_runs sr
    JOIN agent_runs ar ON ar.run_id = sr.run_id
    WHERE sr.skill_id = @id AND ar.model IS NOT NULL AND ar.model != '' AND ar.model != 'unknown'
    GROUP BY ar.model
    ORDER BY runs DESC
  `).all({ id: skillId }) as { model: string; runs: number; successes: number; avg_duration_ms: number }[];

  const models: SkillModelStat[] = rows.map(r => ({
    model: r.model,
    runs: r.runs,
    successes: r.successes,
    successRate: r.runs > 0 ? r.successes / r.runs : 0,
    avgDurationMs: Math.round(r.avg_duration_ms),
  }));

  const pin = db.prepare(`SELECT pinned_model FROM skills WHERE skill_id=?`)
    .get(skillId) as { pinned_model: string | null } | undefined;

  return { models, recommended: recommendModel(models), currentPin: pin?.pinned_model ?? null };
}

/** Does an allowlist permit a tool name? Mirrors filterToolsByAllowlist:
 *  empty list = all; an entry ending in "_" is a prefix; else exact match. */
function allowlistPermits(tool: string, allowlist: string[]): boolean {
  if (allowlist.length === 0) return true;
  return allowlist.some(a => (a.endsWith('_') ? tool.startsWith(a) : tool === a));
}

/** Always-on tools the ReAct loop appends REGARDLESS of a skill's allowlist
 *  (memory, opt-in desktop control, and the sub-capability delegation tool —
 *  see orchestrator.runReactLoop). They must not be flagged as "outside the
 *  allowlist" nor suggested for it, since the user can't meaningfully add them. */
function isAmbientTool(tool: string): boolean {
  return tool.startsWith('memory_') || tool.startsWith('desktop_') || tool === 'invoke_capability';
}

/** Per-skill tool usage joined from tool_receipts, with least-privilege tuning
 *  suggestions against the skill's allowlist (tool/security dimension). */
export function getSkillToolUsage(skillId: string): SkillToolUsage {
  const db = getDb();
  const rows = db.prepare(`
    SELECT tr.tool_name                       AS tool,
           COUNT(*)                           AS calls,
           COALESCE(SUM(tr.status='error'), 0)   AS errors,
           COALESCE(SUM(tr.status='blocked'), 0) AS blocked
    FROM tool_receipts tr
    WHERE tr.run_id IN (SELECT run_id FROM skill_runs WHERE skill_id=@id AND run_id IS NOT NULL)
    GROUP BY tr.tool_name
    ORDER BY calls DESC
  `).all({ id: skillId }) as { tool: string; calls: number; errors: number; blocked: number }[];

  let allowlist: string[] = [];
  try {
    const row = db.prepare(`SELECT allowed_tools_json FROM skills WHERE skill_id=?`)
      .get(skillId) as { allowed_tools_json: string } | undefined;
    const parsed = JSON.parse(row?.allowed_tools_json ?? '[]');
    if (Array.isArray(parsed)) allowlist = parsed.filter((x): x is string => typeof x === 'string');
  } catch { /* empty allowlist */ }

  const called = new Set(rows.map(r => r.tool));
  const tools: SkillToolStat[] = rows.map(r => ({
    tool: r.tool, calls: r.calls, errors: r.errors, blocked: r.blocked,
    // Ambient tools are always available, so they count as allowed regardless.
    allowed: isAmbientTool(r.tool) || allowlistPermits(r.tool, allowlist),
  }));

  // Tighten: an allowlist entry no observed call matched. For a prefix entry,
  // "unused" means no called tool started with it.
  const grantedButUnused = allowlist.filter(entry => {
    if (entry.endsWith('_')) return ![...called].some(t => t.startsWith(entry));
    return !called.has(entry);
  });

  // Expand: tools the skill actually tried but its allowlist forbids, and which
  // errored (a strong signal it wanted a tool it didn't have). Meaningless when
  // the allowlist is empty (everything is already permitted).
  const expandHints = allowlist.length === 0 ? [] : [...new Set(
    rows.filter(r => r.errors > 0 && !isAmbientTool(r.tool) && !allowlistPermits(r.tool, allowlist)).map(r => r.tool)
  )];

  return { tools, grantedButUnused, expandHints, allowlistEmpty: allowlist.length === 0 };
}

/** Recent failed/cancelled runs for a skill, newest first (lineage dimension). */
export function getSkillFailures(skillId: string, limit = 10): SkillFailure[] {
  const rows = getDb().prepare(`
    SELECT run_id AS runId, session_id AS sessionId, goal AS goal, status AS status,
           matched_via AS matchedVia, tool_errors AS toolErrors,
           duration_ms AS durationMs, created_at AS createdAt
    FROM skill_runs
    WHERE skill_id = @id AND status != 'ok'
    ORDER BY created_at DESC
    LIMIT @limit
  `).all({ id: skillId, limit: Math.max(1, Math.min(50, limit)) }) as SkillFailure[];
  return rows;
}
