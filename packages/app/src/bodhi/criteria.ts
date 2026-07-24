/**
 * Acceptance criteria — turning "the run finished" into "the objective is
 * verifiably done".
 *
 * Phase A.5 rule: only the closed predicate vocabulary (taskModel.
 * VERIFIABLE_PREDICATES) may yield `verified`; prose caps at user review. This
 * module derives criteria WITHOUT asking a model (founder principle: no
 * dependency on which model is loaded) by reading the run's own concrete
 * claims — the paths a tool said it wrote/moved — and then checks those claims
 * against reality on disk.
 *
 * That asymmetry is the point: the agent asserts "I generated report.pdf"; the
 * validator asks the filesystem. A run can no longer earn "Completed —
 * verified" for a file it never actually produced.
 *
 * When a run makes no checkable claim (research, summarising, advice), NO
 * criteria are recorded and the projection correctly falls back to
 * "Ready for your review" — honest, not falsely green.
 */
import type { VerifiablePredicate, CriterionOutcome } from './taskModel';

/** The tracked-mutation shape the orchestrator records per state-changing call. */
export interface MutationLike {
  tool: string;
  args: Record<string, unknown>;
  result: string;
  success: boolean;
}

export interface CriterionDraft {
  predicate: VerifiablePredicate;
  /** Short, path-free (basename only) description shown in the UI. */
  description: string;
  required: boolean;
  /** Absolute path the predicate checks. Stored in inputs_json, not displayed. */
  target: string;
}

/** A very large batch shouldn't create thousands of rows; we verify a bounded
 *  sample. The count is reported by the caller so the cap is never silent. */
export const MAX_BATCH_CRITERIA = 25;

function basename(p: string): string {
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? p;
}

/**
 * Pull the output path out of a `docs_generate` result. That tool returns
 * HUMAN-READABLE TEXT, not JSON:
 *   "Created report.pdf (PDF) at /Users/x/Documents/report.pdf. 3 provenance…"
 * so we parse the `at <path>.` form. JSON is tried first purely so a future
 * structured result keeps working. Returns null when nothing concrete is
 * claimed — which correctly yields no criterion rather than a bogus one.
 */
export function extractDocsPath(result: string): string | null {
  try {
    const j = JSON.parse(result) as { outPath?: string; path?: string };
    const p = j.outPath ?? j.path;
    if (typeof p === 'string' && p.trim()) return p.trim();
  } catch { /* not JSON — fall through to the text form */ }
  // Non-greedy up to the sentence-ending "." so paths containing dots survive.
  const m = result.match(/\bat\s+(\/.+?)\.(?:\s|$)/);
  return m ? m[1] : null;
}

/**
 * Pure: derive machine-checkable criteria from what the run actually CLAIMED.
 * Only successful mutations produce claims — a failed tool asserted nothing.
 */
export function deriveCriteriaFromMutations(mutations: MutationLike[]): CriterionDraft[] {
  const drafts: CriterionDraft[] = [];
  const seen = new Set<string>();

  const add = (target: unknown, verb: string, predicate: VerifiablePredicate = 'file_exists') => {
    if (typeof target !== 'string') return;
    const t = target.trim();
    if (!t || seen.has(t)) return;
    seen.add(t);
    drafts.push({ predicate, description: `${basename(t)} ${verb}`, required: true, target: t });
  };

  for (const m of mutations) {
    if (!m.success) continue; // a failed tool made no claim to verify
    switch (m.tool) {
      case 'docs_generate':
        add(extractDocsPath(m.result), 'was generated', 'artifact_exists');
        break;
      case 'fs_move_file':
      case 'fs_copy_file':
        add(m.args.destination, 'exists at its destination');
        break;
      case 'fs_create_directory':
        add(m.args.path, 'was created');
        break;
      case 'fs_move_batch': {
        const moves = Array.isArray(m.args.moves) ? m.args.moves : [];
        for (const mv of moves.slice(0, MAX_BATCH_CRITERIA)) {
          if (mv && typeof mv === 'object') {
            add((mv as Record<string, unknown>).destination, 'exists at its destination');
          }
        }
        break;
      }
      default:
        break; // no verifiable filesystem claim
    }
  }
  return drafts;
}

/** Check one draft against reality. `exists` is injected so this is testable. */
export function evaluateCriterion(d: CriterionDraft, exists: (p: string) => boolean): CriterionOutcome {
  try {
    return exists(d.target) ? 'passed' : 'failed';
  } catch {
    return 'indeterminate'; // couldn't check (permissions/IO) — never assume pass
  }
}

// ── Persistence ─────────────────────────────────────────────────────────────

export interface CriteriaDb {
  prepare(sql: string): {
    run(...args: unknown[]): unknown;
    get(...args: unknown[]): unknown;
  };
}

export interface RecordCriteriaResult {
  taskId: string | null;
  recorded: number;
  passed: number;
  failed: number;
  /** Destinations beyond MAX_BATCH_CRITERIA that were not turned into criteria. */
  truncated: number;
}

/**
 * Anchor the run to an `agent_tasks` row, derive + evaluate criteria, and
 * persist them. Best-effort and NEVER throws — bookkeeping must not be able to
 * break a run (same contract as persistRunFacts).
 */
export function recordAcceptanceCriteria(
  db: CriteriaDb,
  opts: {
    runId: string;
    sessionId: string;
    goal: string;
    mutations: MutationLike[];
    exists: (p: string) => boolean;
    /** Authoritative artifact paths recorded by the run (artifacts.file_path).
     *  Cross-checks the text-parsed docs path; deduped against it. */
    artifactPaths?: string[];
    /** Injected for determinism in tests. */
    newId?: () => string;
  },
): RecordCriteriaResult {
  const empty: RecordCriteriaResult = { taskId: null, recorded: 0, passed: 0, failed: 0, truncated: 0 };
  try {
    const drafts = deriveCriteriaFromMutations(opts.mutations);
    // Fold in artifacts the run actually registered (authoritative paths).
    const known = new Set(drafts.map(d => d.target));
    for (const p of opts.artifactPaths ?? []) {
      const t = (p ?? '').trim();
      if (t && !known.has(t)) {
        known.add(t);
        drafts.push({
          predicate: 'artifact_exists', required: true, target: t,
          description: `${basename(t)} was generated`,
        });
      }
    }
    // Count batch destinations we deliberately did not verify, so the cap is
    // reported rather than silently swallowed.
    let truncated = 0;
    for (const m of opts.mutations) {
      if (m.success && m.tool === 'fs_move_batch' && Array.isArray(m.args.moves)) {
        truncated += Math.max(0, m.args.moves.length - MAX_BATCH_CRITERIA);
      }
    }
    if (!drafts.length) return { ...empty, truncated };

    // 1. Ensure the run is anchored to a task row.
    const runRow = db.prepare(`SELECT task_id FROM agent_runs WHERE run_id=?`).get(opts.runId) as
      { task_id: string | null } | undefined;
    let taskId = runRow?.task_id ?? null;
    if (!taskId) {
      taskId = (opts.newId ?? (() => Math.random().toString(16).slice(2) + Date.now().toString(16)))();
      db.prepare(
        `INSERT INTO agent_tasks (task_id, source_type, source_id, conversation_id, objective, acceptance_mode, last_run_id)
         VALUES (?, 'delegate', ?, ?, ?, 'system_verified', ?)`
      ).run(taskId, opts.runId, opts.sessionId, opts.goal.slice(0, 500), opts.runId);
      db.prepare(`UPDATE agent_runs SET task_id=? WHERE run_id=?`).run(taskId, opts.runId);
    }

    // 2. Evaluate against reality and persist.
    let passed = 0, failed = 0;
    const insert = db.prepare(
      `INSERT INTO task_acceptance_criteria
         (task_id, kind, predicate, inputs_json, description, required, outcome, expected, actual, evaluated_at)
       VALUES (?, 'predicate', ?, ?, ?, 1, ?, 'exists', ?, unixepoch())`
    );
    for (const d of drafts) {
      const outcome = evaluateCriterion(d, opts.exists);
      if (outcome === 'passed') passed++; else if (outcome === 'failed') failed++;
      insert.run(
        taskId, d.predicate, JSON.stringify({ path: d.target }), d.description,
        outcome, outcome === 'passed' ? 'exists' : 'missing',
      );
    }
    return { taskId, recorded: drafts.length, passed, failed, truncated };
  } catch {
    return empty; // bookkeeping must never break a run
  }
}
