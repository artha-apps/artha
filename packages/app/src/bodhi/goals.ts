/**
 * Persistent goals — a durable statement of "what done means" for a chat
 * session, owned by the user and judged by the system.
 *
 * A goal outlives a single run: it is stored in the `goals` table (see
 * db/schema.ts), survives app restarts, and is re-checked at the stop gate of
 * every ReAct loop in its session until it is completed or stopped.
 *
 * Status rules (the reason this module exists):
 *   - `completed` may ONLY be written by the evaluator path
 *     (`markGoalCompletedByEvaluator`), and only with a `met` verdict. The
 *     model-facing `goal_update` tool can never reach it.
 *   - `terminated` is the user's Stop. The model cannot terminate a goal
 *     either — otherwise it could dodge evaluation by abandoning the goal.
 *   - the model may only mark its goal `blocked` or `paused`, with a reason.
 *
 * Pure with respect to an injected, better-sqlite3-shaped db so every rule is
 * unit-testable (node:sqlite satisfies the same surface in tests).
 */

/** Lifecycle of a goal. Mirrors the CHECK constraint on `goals.status`. */
export type GoalStatus = 'active' | 'paused' | 'blocked' | 'completed' | 'terminated';

/** Statuses the model (via `goal_update`) is allowed to request. */
export const MODEL_SETTABLE_STATUSES = ['blocked', 'paused'] as const;
export type ModelSettableStatus = (typeof MODEL_SETTABLE_STATUSES)[number];

/** Statuses the user may set from the UI (Pause / Resume / Stop). Note that
 *  `completed` is absent here too — not even the UI can declare a goal done. */
export const USER_SETTABLE_STATUSES = ['active', 'paused', 'terminated'] as const;
export type UserSettableStatus = (typeof USER_SETTABLE_STATUSES)[number];

/** A goal that is not finished: it still governs its session. */
export const OPEN_STATUSES: readonly GoalStatus[] = ['active', 'paused', 'blocked'];

/** One persisted goal row, as returned to callers and the renderer. */
export interface Goal {
  goalId: string;
  sessionId: string;
  objective: string;
  /** The checkable statement of done the evaluator judges against. */
  condition: string;
  status: GoalStatus;
  blockedReason: string | null;
  /** Epoch milliseconds. */
  createdAt: number;
  /** Epoch milliseconds of the last write. While `active`, it doubles as the
   *  start of the current, not-yet-accumulated active stretch. */
  updatedAt: number;
  /** Accumulated milliseconds spent `active`, up to `updatedAt`. */
  activeMs: number;
  /** Last evaluator verdict (JSON of GoalVerdict) — null until first checked. */
  lastVerdict: unknown | null;
}

/** Minimal DB surface (better-sqlite3 / node:sqlite compatible). */
export interface GoalsDb {
  prepare(sql: string): {
    run(...args: unknown[]): unknown;
    get(...args: unknown[]): unknown;
    all(...args: unknown[]): unknown[];
  };
}

/** Thrown for every rejected goal transition; the message is model/user facing. */
export class GoalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GoalError';
  }
}

interface GoalRow {
  goal_id: string;
  session_id: string;
  objective: string;
  condition: string;
  status: string;
  blocked_reason: string | null;
  created_at: number;
  updated_at: number;
  active_ms: number;
  last_verdict_json: string | null;
}

const MAX_TEXT = 1000;
const MAX_REASON = 500;

/** Map a raw row to the public shape; tolerant of a corrupt verdict blob. */
function toGoal(r: GoalRow): Goal {
  let lastVerdict: unknown | null = null;
  if (r.last_verdict_json) {
    try { lastVerdict = JSON.parse(r.last_verdict_json); } catch { lastVerdict = null; }
  }
  return {
    goalId: r.goal_id,
    sessionId: r.session_id,
    objective: r.objective,
    condition: r.condition,
    status: r.status as GoalStatus,
    blockedReason: r.blocked_reason,
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
    activeMs: Number(r.active_ms),
    lastVerdict,
  };
}

/** Elapsed active time including the in-progress stretch (for the UI chip). */
export function goalElapsedMs(g: Goal, now: number = Date.now()): number {
  return g.activeMs + (g.status === 'active' ? Math.max(0, now - g.updatedAt) : 0);
}

/** The session's current (open) goal: newest active/paused/blocked row. */
export function getOpenGoal(db: GoalsDb, sessionId: string): Goal | null {
  const r = db.prepare(
    `SELECT * FROM goals WHERE session_id=? AND status IN ('active','paused','blocked')
      ORDER BY created_at DESC, rowid DESC LIMIT 1`
  ).get(sessionId) as GoalRow | undefined;
  return r ? toGoal(r) : null;
}

/** Fetch one goal by id. */
export function getGoal(db: GoalsDb, goalId: string): Goal | null {
  const r = db.prepare(`SELECT * FROM goals WHERE goal_id=?`).get(goalId) as GoalRow | undefined;
  return r ? toGoal(r) : null;
}

/** Most recent goal of the session in ANY status (so the UI can still show a
 *  just-completed or just-stopped goal after the run ends). */
export function getLatestGoal(db: GoalsDb, sessionId: string): Goal | null {
  const r = db.prepare(
    `SELECT * FROM goals WHERE session_id=? ORDER BY created_at DESC, rowid DESC LIMIT 1`
  ).get(sessionId) as GoalRow | undefined;
  return r ? toGoal(r) : null;
}

/**
 * Create a new active goal for a session. Rejects when the session already has
 * an open goal: replacing it silently would let a run swap a hard goal for an
 * easy one and skip evaluation. The user must stop the old goal first.
 */
export function createGoal(
  db: GoalsDb,
  input: { sessionId: string; objective: string; condition: string; now?: number; newId?: () => string },
): Goal {
  const objective = (input.objective ?? '').trim().slice(0, MAX_TEXT);
  const condition = (input.condition ?? '').trim().slice(0, MAX_TEXT);
  if (!objective) throw new GoalError('goal_set needs a non-empty "objective".');
  if (!condition) throw new GoalError('goal_set needs a non-empty "condition" describing how completion will be checked.');
  const existing = getOpenGoal(db, input.sessionId);
  if (existing) {
    throw new GoalError(
      `This chat already has a goal ("${existing.objective.slice(0, 120)}", status ${existing.status}). ` +
      `Keep working toward it; only the user can stop it and set a new one.`,
    );
  }
  const now = input.now ?? Date.now();
  const goalId = (input.newId ?? (() => Math.random().toString(16).slice(2) + now.toString(16)))();
  db.prepare(
    `INSERT INTO goals (goal_id, session_id, objective, condition, status, blocked_reason,
                        created_at, updated_at, active_ms, last_verdict_json)
     VALUES (?, ?, ?, ?, 'active', NULL, ?, ?, 0, NULL)`
  ).run(goalId, input.sessionId, objective, condition, now, now);
  return getGoal(db, goalId)!;
}

/**
 * Low-level transition writer shared by every public setter. Accumulates
 * active time when the goal is leaving (or re-writing) the `active` state,
 * and refuses to touch a finished goal.
 */
function writeTransition(
  db: GoalsDb,
  goalId: string,
  next: GoalStatus,
  opts: { reason?: string | null; verdictJson?: string | null; now?: number },
): Goal {
  const g = getGoal(db, goalId);
  if (!g) throw new GoalError('No such goal.');
  if (g.status === 'completed' || g.status === 'terminated') {
    throw new GoalError(`This goal is already ${g.status} and can no longer change.`);
  }
  const now = opts.now ?? Date.now();
  const activeMs = g.activeMs + (g.status === 'active' ? Math.max(0, now - g.updatedAt) : 0);
  const reason = next === 'blocked' || next === 'paused'
    ? (opts.reason ?? '').trim().slice(0, MAX_REASON) || null
    : null;
  db.prepare(
    `UPDATE goals SET status=?, blocked_reason=?, updated_at=?, active_ms=?,
            last_verdict_json=COALESCE(?, last_verdict_json)
      WHERE goal_id=?`
  ).run(next, reason, now, activeMs, opts.verdictJson ?? null, goalId);
  return getGoal(db, goalId)!;
}

/**
 * The model-facing transition (`goal_update` tool). Only `blocked` / `paused`,
 * always with a reason. Any attempt at `completed` or `terminated` is rejected
 * with an error that tells the model how completion actually happens.
 */
export function modelUpdateGoal(
  db: GoalsDb,
  sessionId: string,
  input: { status: unknown; reason: unknown },
  now?: number,
): Goal {
  const status = typeof input.status === 'string' ? input.status.trim() : '';
  if (status === 'completed') {
    throw new GoalError(
      'You cannot mark a goal completed. Completion is decided by an independent check of the ' +
      'evidence when you finish — keep working until the condition is actually met.',
    );
  }
  if (status === 'terminated') {
    throw new GoalError('You cannot terminate a goal; only the user can stop it. Use "blocked" with a reason if you cannot proceed.');
  }
  if (!(MODEL_SETTABLE_STATUSES as readonly string[]).includes(status)) {
    throw new GoalError('goal_update "status" must be "blocked" or "paused".');
  }
  const reason = typeof input.reason === 'string' ? input.reason.trim() : '';
  if (!reason) throw new GoalError('goal_update needs a "reason" explaining what is in the way.');
  const g = getOpenGoal(db, sessionId);
  if (!g) throw new GoalError('There is no open goal in this chat to update.');
  return writeTransition(db, g.goalId, status as ModelSettableStatus, { reason, now });
}

/** The user-facing transition (Pause / Resume / Stop from the Delegate header). */
export function userSetGoalStatus(db: GoalsDb, goalId: string, status: unknown, now?: number): Goal {
  if (typeof status !== 'string' || !(USER_SETTABLE_STATUSES as readonly string[]).includes(status)) {
    throw new GoalError('Goal status must be one of: active, paused, terminated.');
  }
  return writeTransition(db, goalId, status as UserSettableStatus, {
    reason: status === 'paused' ? 'Paused by you' : null, now,
  });
}

/** Persist an evaluator verdict without changing status (e.g. `unmet` while
 *  the stop gate still has feedback rounds left, or `unknown`). */
export function recordGoalVerdict(db: GoalsDb, goalId: string, verdict: unknown, now?: number): Goal | null {
  const g = getGoal(db, goalId);
  if (!g || g.status === 'completed' || g.status === 'terminated') return g;
  return writeTransition(db, goalId, g.status, {
    reason: g.blockedReason, verdictJson: JSON.stringify(verdict), now,
  });
}

/**
 * The ONLY path to `completed`. Takes the evaluator's verdict object and
 * refuses anything but `met` — a caller cannot complete a goal without one.
 */
export function markGoalCompletedByEvaluator(
  db: GoalsDb,
  goalId: string,
  verdict: { verdict: string },
  now?: number,
): Goal {
  if (!verdict || verdict.verdict !== 'met') {
    throw new GoalError('A goal can only be completed by a "met" evaluator verdict.');
  }
  return writeTransition(db, goalId, 'completed', { verdictJson: JSON.stringify(verdict), now });
}

/** The evaluator's "needs you" outcome after its feedback rounds ran out. */
export function markGoalBlockedByEvaluator(
  db: GoalsDb,
  goalId: string,
  verdict: unknown,
  reason: string,
  now?: number,
): Goal {
  return writeTransition(db, goalId, 'blocked', { reason, verdictJson: JSON.stringify(verdict), now });
}

// ── goal_set approval rule ─────────────────────────────────────────────────

const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'with', 'is', 'are', 'be', 'it',
  'that', 'this', 'all', 'my', 'me', 'i', 'at', 'by', 'from', 'as', 'has', 'have', 'been', 'was',
  'will', 'should', 'must', 'there', 'their', 'its', 'into', 'every', 'each', 'so', 'when',
]);

/** Lower-cased content words (≥3 chars, not stopwords). */
function contentWords(s: string): string[] {
  return (s.toLowerCase().match(/[a-z0-9][a-z0-9._-]*/g) ?? [])
    .filter(w => w.length >= 3 && !STOPWORDS.has(w));
}

/**
 * Did the user's own message already state this outcome? If so, `goal_set`
 * may proceed without a separate approval prompt; otherwise the model is
 * inventing the definition of done and the user must approve it.
 *
 * Deterministic and deliberately strict: at least 70% of the condition's
 * content words (and of the objective's) must appear in the user's message.
 */
export function userStatedOutcome(userMessage: string, objective: string, condition: string): boolean {
  const said = new Set(contentWords(userMessage));
  const covered = (text: string): boolean => {
    const words = contentWords(text);
    if (!words.length) return false;
    const hit = words.filter(w => said.has(w)).length;
    return hit / words.length >= 0.7;
  };
  return covered(condition) && covered(objective);
}

// ── Agent tool schemas ─────────────────────────────────────────────────────

/** Names of the goal tools, for dispatch in the ReAct loop. */
export const GOAL_TOOL_NAMES = ['goal_set', 'goal_update'] as const;

/** True for a goal tool name. */
export function isGoalTool(name: string): boolean {
  return (GOAL_TOOL_NAMES as readonly string[]).includes(name);
}

/** OpenAI-style tool schemas offered to top-level loops. */
export const GOAL_TOOL_SCHEMAS = [
  {
    type: 'function' as const,
    function: {
      name: 'goal_set',
      description:
        'Record a persistent goal for this chat: the objective and a concrete, checkable condition that ' +
        'means it is done (e.g. "report.pdf exists in ~/Documents and lists all 12 invoices"). The goal ' +
        'is checked independently when you finish. Needs user approval unless the user stated it.',
      parameters: {
        type: 'object',
        properties: {
          objective: { type: 'string', description: 'What the user wants achieved, in one sentence.' },
          condition: { type: 'string', description: 'A concrete, verifiable statement of done.' },
        },
        required: ['objective', 'condition'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'goal_update',
      description:
        'Mark the current goal "blocked" (you cannot proceed without the user) or "paused", with a reason. ' +
        'You cannot mark a goal completed — completion is checked independently.',
      parameters: {
        type: 'object',
        properties: {
          status: { type: 'string', enum: ['blocked', 'paused'] },
          reason: { type: 'string', description: 'What is in the way, in one sentence.' },
        },
        required: ['status', 'reason'],
      },
    },
  },
];
