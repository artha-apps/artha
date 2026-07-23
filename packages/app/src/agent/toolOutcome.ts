/**
 * Classify what a tool call ACTUALLY did.
 *
 * Before this, the app's only definition of a failed tool was
 * `result.startsWith('Error:')` — a prose convention. That meant:
 *   - a tool that failed without the prefix counted as a success;
 *   - `fs_move_batch` moving 1 of 50 files returned `success: true`, so
 *     `mutations[].success` was true and `mutationsFailed` was 0;
 *   - partial outcomes had no representation at all.
 * Every evidence surface — receipts, tallies, run facts, the verified
 * summary, skill success rates — sits downstream of this one decision, so
 * it is worth making from inspection rather than from a string prefix.
 *
 * Pure and dependency-free: no DB, no Electron, fully unit-testable.
 */

export type ToolOutcomeStatus = 'succeeded' | 'failed' | 'partial';

export interface ToolOutcome {
  status: ToolOutcomeStatus;
  /** Short, sanitized explanation — safe to persist as evidence. */
  detail?: string;
  /** Present when the tool reported per-item counts (batch operations). */
  counts?: { ok: number; failed: number };
}

/** Longest result we will scan/echo — keeps evidence bounded. */
const MAX_DETAIL = 200;

/**
 * `thrown` short-circuits everything: if the dispatcher caught an exception,
 * the call failed regardless of what the (partial) result string says.
 */
export function classifyToolResult(
  toolName: string,
  result: string,
  opts: { thrown?: boolean; blocked?: boolean } = {},
): ToolOutcome {
  if (opts.blocked) {
    return { status: 'failed', detail: `${toolName} was blocked by policy` };
  }
  if (opts.thrown) {
    return { status: 'failed', detail: truncate(result) || `${toolName} threw` };
  }
  if (typeof result !== 'string' || result.trim() === '') {
    // An empty result is not evidence of success.
    return { status: 'failed', detail: `${toolName} returned no result` };
  }

  // The legacy prose convention still holds where tools use it.
  if (/^\s*Error:/i.test(result)) {
    return { status: 'failed', detail: truncate(result) };
  }

  // Structured results: inspect rather than pattern-match on prose.
  const parsed = tryParse(result);
  if (parsed && typeof parsed === 'object') {
    const o = parsed as Record<string, unknown>;

    // Explicit error carriers used across the tool surface.
    if (typeof o.error === 'string' && o.error.trim()) {
      return { status: 'failed', detail: truncate(o.error) };
    }
    if (o.isError === true) {
      return { status: 'failed', detail: truncate(result) };
    }

    // Batch operations report per-item counts. `success: moved > 0` made a
    // 1-of-50 batch look clean; a partial batch is now partial.
    const ok = numeric(o.moved) ?? numeric(o.succeeded) ?? numeric(o.ok);
    const failed = numeric(o.failed);
    if (failed != null && failed > 0) {
      const okCount = ok ?? 0;
      return {
        status: okCount > 0 ? 'partial' : 'failed',
        detail: `${toolName}: ${okCount} succeeded, ${failed} failed`,
        counts: { ok: okCount, failed },
      };
    }

    if (o.success === false) {
      return { status: 'failed', detail: truncate(result) };
    }
  }

  return { status: 'succeeded' };
}

/** True when this outcome should count against the run's failure tally. */
export function isFailure(o: ToolOutcome): boolean {
  return o.status === 'failed';
}

/** A mutation only counts as having happened when it fully succeeded —
 *  a partial batch must never be reported as a completed operation. */
export function countsAsCompletedMutation(o: ToolOutcome): boolean {
  return o.status === 'succeeded';
}

function tryParse(s: string): unknown {
  const t = s.trim();
  if (!t.startsWith('{') && !t.startsWith('[')) return null;
  try { return JSON.parse(t); } catch { return null; }
}

function numeric(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function truncate(s: string): string {
  const t = (s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > MAX_DETAIL ? `${t.slice(0, MAX_DETAIL)}…` : t;
}
