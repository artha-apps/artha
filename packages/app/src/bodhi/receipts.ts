/**
 * Bodhi — Verified Tool Receipts (provenance for function calls).
 *
 * Artha already tracks filesystem mutations internally to stop the model
 * hallucinating a summary it can't back up. Receipts turn that private
 * ground-truth into a USER-FACING, verifiable record: every tool call the agent
 * makes emits a receipt carrying the tool, its arguments, a plain-English
 * description of the real effect, a content hash of the result, the policy tier
 * that governed it, and its status (ok / error / blocked / skipped).
 *
 * "Blocked" and "skipped" receipts are first-class: when a policy stops or
 * dry-runs a call, that decision is recorded too, so the log is the complete
 * story of what the agent did — and what it was prevented from doing.
 *
 * Local-first: receipts live in SQLite (`tool_receipts`) and are never sent
 * anywhere. They are the audit trail behind "agents that prove what they did".
 */
import { createHash } from 'crypto';
import { getDb } from '../db/schema';
import type { PolicyTier } from './policy';

/** Terminal state of a single tool call as recorded in a receipt. */
export type ReceiptStatus = 'ok' | 'error' | 'blocked' | 'skipped';

/** One persisted receipt row (as returned to the UI). */
export interface ToolReceipt {
  receipt_id: string;
  run_id: string | null;
  session_id: string | null;
  workflow_id: string | null;
  idx: number;
  tool_name: string;
  args_json: string;
  effect: string;
  result_hash: string;
  status: ReceiptStatus;
  tier: PolicyTier;
  is_mutation: number;
  duration_ms: number;
  ts: number;
}

/** The fields the orchestrator supplies when recording a call. */
export interface ReceiptInput {
  runId: string;
  sessionId: string;
  workflowId: string;
  idx: number;
  toolName: string;
  args: Record<string, unknown>;
  result: string;
  status: ReceiptStatus;
  tier: PolicyTier;
  isMutation: boolean;
  durationMs: number;
}

/** Filesystem tools whose effect is worth describing in concrete before→after
 *  language. Anything else falls back to a generic one-liner. */
const MUTATION_EFFECTS: Record<string, (a: Record<string, unknown>) => string> = {
  fs_move_file:      a => `Moved ${a.source ?? a.path ?? '?'} → ${a.destination ?? a.dest ?? '?'}`,
  fs_rename_file:    a => `Renamed ${a.source ?? a.path ?? '?'} → ${a.destination ?? a.dest ?? a.new_name ?? '?'}`,
  fs_copy_file:      a => `Copied ${a.source ?? a.path ?? '?'} → ${a.destination ?? a.dest ?? '?'}`,
  fs_delete_file:    a => `Deleted ${a.path ?? a.file ?? '?'}`,
  fs_create_directory: a => `Created folder ${a.path ?? '?'}`,
  fs_write_file:     a => `Wrote ${a.path ?? a.filename ?? '?'}`,
};

/** A short content hash so a receipt can be checked against the real result.
 *  Truncated SHA-256 — enough to detect tampering, short enough to display. */
export function hashResult(result: string): string {
  return createHash('sha256').update(result ?? '').digest('hex').slice(0, 16);
}

/** Produce a plain-English description of what a call actually did, anchored to
 *  the real result where possible (e.g. fs_move_batch's moved/failed counts). */
export function describeEffect(
  toolName: string,
  args: Record<string, unknown>,
  result: string,
  status: ReceiptStatus,
): string {
  if (status === 'blocked') return 'Blocked by policy — not executed.';
  if (status === 'skipped') return 'Dry run — described only, not executed.';
  if (status === 'error') return `Failed: ${result.slice(0, 160)}`;

  if (toolName === 'fs_move_batch') {
    try {
      const r = JSON.parse(result) as { moved?: number; failed?: number };
      return `Moved ${r.moved ?? 0} file(s) in one batch${r.failed ? `, ${r.failed} failed` : ''}`;
    } catch { /* fall through */ }
  }
  const fn = MUTATION_EFFECTS[toolName];
  if (fn) return fn(args);

  if (toolName.startsWith('web_') || toolName.startsWith('browser_')) {
    const u = args.url ?? args.query ?? '';
    return `${toolName}${u ? ` · ${String(u).slice(0, 80)}` : ''}`;
  }
  if (toolName === 'invoke_capability') {
    return `Delegated to capability "${args.capability_id ?? '?'}"`;
  }
  return toolName;
}

/** Tools that change durable state — flagged in the receipt so the UI can show
 *  a "changed your files" badge and the audit view can filter to real effects. */
export const RECEIPT_MUTATION_TOOLS = new Set([
  // Kept in sync with MUTATION_TOOLS in agent/orchestrator.ts. Dead entries
  // (fs_write_file, fs_rename_file) removed; the state-changing capabilities
  // users actually run added, so receipts stop under-reporting real effects.
  'fs_move_file', 'fs_move_batch', 'fs_copy_file', 'fs_delete_file',
  'fs_create_directory',
  'docs_generate',
  'browser_click', 'browser_type', 'browser_navigate',
  'desktop_click', 'desktop_type', 'desktop_key', 'desktop_move_mouse',
]);

/** Persist one receipt. Best-effort: a logging failure must never break a run. */
export function recordReceipt(input: ReceiptInput): void {
  try {
    const effect = describeEffect(input.toolName, input.args, input.result, input.status);
    const hash = input.status === 'ok' || input.status === 'error' ? hashResult(input.result) : '';
    getDb().prepare(`
      INSERT INTO tool_receipts
        (run_id, session_id, workflow_id, idx, tool_name, args_json, effect, result_hash, status, tier, is_mutation, duration_ms)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      input.runId, input.sessionId, input.workflowId, input.idx,
      input.toolName, JSON.stringify(input.args).slice(0, 4000),
      effect, hash, input.status, input.tier,
      input.isMutation ? 1 : 0, input.durationMs,
    );
  } catch (err) {
    console.warn('[Artha] receipt record failed:', err);
  }
}

/** Every receipt for one run, in execution order. */
export function listReceiptsByRun(runId: string): ToolReceipt[] {
  return getDb()
    .prepare(`SELECT * FROM tool_receipts WHERE run_id = ? ORDER BY idx ASC`)
    .all(runId) as ToolReceipt[];
}

/** Recent runs that produced receipts, newest first — drives the audit panel's
 *  left list. One entry per run with a count + the run's goal. */
export function listReceiptRuns(limit = 50): { run_id: string; goal: string; session_id: string; calls: number; mutations: number; ts: number }[] {
  return getDb().prepare(`
    SELECT r.run_id        AS run_id,
           MAX(r.ts)       AS ts,
           COUNT(*)        AS calls,
           -- Count only mutations that actually SUCCEEDED. is_mutation marks
           -- "this tool changes state", independent of outcome, so summing it
           -- reported "1 changed file" for a change that was successfully
           -- BLOCKED by policy — claiming damage in exactly the case where it
           -- was prevented (shipped-surface audit H9).
           SUM(CASE WHEN r.is_mutation = 1 AND r.status = 'ok' THEN 1 ELSE 0 END) AS mutations,
           IFNULL(ar.goal, '') AS goal,
           IFNULL(ar.session_id, '') AS session_id
    FROM tool_receipts r
    LEFT JOIN agent_runs ar ON ar.run_id = r.run_id
    GROUP BY r.run_id
    ORDER BY ts DESC
    LIMIT ?
  `).all(limit) as { run_id: string; goal: string; session_id: string; calls: number; mutations: number; ts: number }[];
}
