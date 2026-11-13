/**
 * Run event timeline reducer for the Run Inspector.
 *
 * Purpose: turns a run's persisted `run_events` (agent/runEvents.ts, fetched
 * with `run.timeline(runId)`) into readable rows: tool calls with their
 * result, where the run paused for the user and how that ended, goal-gate
 * decisions, kill-switch stops, stalls, errors and the end of the loop.
 *
 * Honesty rules:
 *   - "Run ended" shows the outcome the LOOP recorded. It is never labelled as
 *     the task being done; completion is verified elsewhere (bodhi/).
 *   - A stall is informational: the watchdog never changes run status.
 *   - An interaction with no response yet is shown as waiting, not answered.
 *
 * Pure (no DOM, no IPC) so it is unit-testable.
 */

/** Subset of a run event this module reads. */
export interface TimelineEventLike {
  runId: string;
  seq: number;
  ts: number;
  kind: string;
  payload: unknown;
  /** Recorded under the run's workflow id (plan review before the run). */
  linked?: 'workflow';
}

export type TimelineTone = 'info' | 'ok' | 'warn' | 'danger' | 'muted';

/** One rendered row. `key` is stable across re-renders. */
export interface TimelineRow {
  key: string;
  ts: number;
  /** What kind of row this is (drives the icon). */
  type: 'tool' | 'interaction' | 'goal_gate' | 'kill_switch' | 'status' | 'plan' | 'stalled' | 'error' | 'done';
  title: string;
  detail?: string;
  tone: TimelineTone;
  linked?: boolean;
}

type P = Record<string, unknown>;
const obj = (v: unknown): P => (v && typeof v === 'object' ? (v as P) : {});
const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);
const keyOf = (ev: TimelineEventLike) => `${ev.runId}:${ev.seq}`;

/** Human label for an interaction's kind. */
function interactionLabel(p: P): string {
  if (str(p.toolName)) return `Approval for ${p.toolName}`;
  switch (p.interactionKind) {
    case 'plan': return 'Plan review';
    case 'ask': return 'Question for you';
    default: return 'Waited for you';
  }
}

/** Response outcome → label + tone. Confirm events carry `approved`; ask/plan
 *  events carry the unified interaction `status`. */
function interactionOutcome(p: P): { text: string; tone: TimelineTone } {
  if (typeof p.approved === 'boolean') return p.approved ? { text: 'approved', tone: 'ok' } : { text: 'denied', tone: 'warn' };
  switch (p.status) {
    case 'answered': return { text: 'answered', tone: 'ok' };
    case 'declined': return { text: 'declined', tone: 'warn' };
    case 'expired': return { text: 'expired (no answer)', tone: 'warn' };
    default: return { text: str(p.status) ?? 'resolved', tone: 'info' };
  }
}

/** Outcome the loop recorded on its `done` event. */
function doneRow(p: P): { title: string; tone: TimelineTone } {
  const o = str(p.outcome) ?? 'ended';
  const tone: TimelineTone = o === 'failed' ? 'danger' : o === 'cancelled' || o === 'timed_out' ? 'warn' : 'muted';
  return { title: `Run ended (${o.replace(/_/g, ' ')})`, tone };
}

/**
 * Fold events (in timeline order) into rows.
 *  - tool_call + the next tool_result of the same tool → one row;
 *  - interaction request + response (by interactionId / approvalId) → one row;
 *  - heartbeat and step events are dropped (the step trace is shown separately).
 */
export function reduceRunTimeline(events: readonly TimelineEventLike[]): TimelineRow[] {
  const rows: TimelineRow[] = [];
  /** Open tool rows per tool name (FIFO), waiting for their result. */
  const openTools = new Map<string, TimelineRow[]>();
  /** Open interaction rows by interaction / approval id. */
  const openAsks = new Map<string, TimelineRow>();

  for (const ev of events) {
    const p = obj(ev.payload);
    const linked = ev.linked === 'workflow' || undefined;
    const base = { key: keyOf(ev), ts: ev.ts, linked };
    switch (ev.kind) {
      case 'tool_call': {
        const name = str(p.name) ?? 'tool';
        const row: TimelineRow = { ...base, type: 'tool', title: name, detail: 'running…', tone: 'info' };
        rows.push(row);
        const q = openTools.get(name) ?? [];
        q.push(row); openTools.set(name, q);
        break;
      }
      case 'tool_result': {
        const name = str(p.name) ?? 'tool';
        const row = openTools.get(name)?.shift();
        const status = str(p.status) ?? 'done';
        const tone: TimelineTone = status === 'error' ? 'danger' : status === 'blocked' ? 'warn' : 'ok';
        if (row) { row.detail = status; row.tone = tone; }
        else rows.push({ ...base, type: 'tool', title: name, detail: status, tone });
        break;
      }
      case 'interaction': {
        const id = str(p.interactionId) ?? str(p.approvalId);
        if (p.phase === 'request') {
          const row: TimelineRow = { ...base, type: 'interaction', title: interactionLabel(p), detail: 'waiting for you', tone: 'info' };
          rows.push(row);
          if (id) openAsks.set(id, row);
        } else {
          const out = interactionOutcome(p);
          const row = id ? openAsks.get(id) : undefined;
          if (row) { row.detail = out.text; row.tone = out.tone; if (id) openAsks.delete(id); }
          else rows.push({ ...base, type: 'interaction', title: interactionLabel(p), detail: out.text, tone: out.tone });
        }
        break;
      }
      case 'status': {
        if (p.source === 'kill_switch') {
          rows.push({ ...base, type: 'kill_switch', title: 'Stopped with the stop shortcut', detail: 'stopped by user', tone: 'danger' });
        } else if (p.source === 'goal_gate') {
          const gaps = Array.isArray(p.gaps) ? p.gaps.filter((g): g is string => typeof g === 'string') : [];
          const action = str(p.action) ?? 'checked';
          rows.push({
            ...base, type: 'goal_gate',
            title: `Goal check: ${action.replace(/_/g, ' ')}`,
            detail: gaps.length ? `Gaps: ${gaps.join('; ')}` : undefined,
            tone: action === 'continue' ? 'warn' : 'info',
          });
        } else if (p.modelRouted !== undefined) {
          const m = obj(p.modelRouted);
          rows.push({ ...base, type: 'status', title: `Model: ${str(m.model) ?? str(p.modelRouted) ?? 'routed'}`, tone: 'muted' });
        } else {
          const text = str(p.text) ?? str(obj(p.text).text);
          if (text) rows.push({ ...base, type: 'status', title: text, tone: 'muted' });
        }
        break;
      }
      case 'plan': {
        const n = Array.isArray(p.steps) ? p.steps.length : 0;
        rows.push({ ...base, type: 'plan', title: `Plan: ${n} step${n === 1 ? '' : 's'}`, detail: str(p.goal), tone: 'info' });
        break;
      }
      case 'stalled': {
        const secs = Math.round(Number(p.idleMs) / 1000);
        rows.push({ ...base, type: 'stalled', title: `No activity for ${Number.isFinite(secs) ? secs : '?'}s`, detail: 'run status unchanged', tone: 'warn' });
        break;
      }
      case 'error':
        rows.push({ ...base, type: 'error', title: 'Error', detail: str(p.message), tone: 'danger' });
        break;
      case 'done':
        rows.push({ ...base, type: 'done', ...doneRow(p) });
        break;
      default:
        // heartbeat, step and unknown kinds are not shown.
        break;
    }
  }
  return rows;
}
