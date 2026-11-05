/**
 * Run timeline query: the `run_events` a Run Inspector shows for one run.
 *
 * Purpose: a run's own events are keyed by its run id, but a plan review
 * happens BEFORE `executePlan` creates the run, so the plan-interaction
 * events (agent/interactionRunEvents.ts) are recorded under the WORKFLOW id.
 * This query links workflow → run: it looks up the run's workflow and pulls
 * that workflow's events in too, so the inspector shows the plan review that
 * led to the run.
 *
 * A workflow can back several runs (re-execution). Each workflow-keyed event
 * is assigned to exactly ONE run: the earliest run of the workflow created at
 * or after the event (an event newer than every run goes to the latest one).
 * So a plan review shows up on the run it led to, not on every run.
 *
 * Read-only. It never changes run state, and a timeline row is not a
 * completion claim (completion is verified from evidence in bodhi/).
 */
import { getDb } from '../db/schema';
import { listRunEvents, type RunEvent } from './runEvents';

/** One timeline event. `linked: 'workflow'` marks events recorded under the
 *  run's workflow id (plan review) rather than the run id. */
export type TimelineEvent = RunEvent & { linked?: 'workflow' };

/** Storage seam (SQLite in production, in-memory in tests). */
export interface RunTimelineSource {
  /** The run's workflow id, or null for an unknown run. */
  workflowOf(runId: string): string | null;
  /** Every run of a workflow with its creation time in epoch ms. */
  runsOfWorkflow(workflowId: string): Array<{ runId: string; createdAtMs: number }>;
  /** Events stored under `id` (a run id or a workflow id), ascending by seq. */
  events(id: string, limit: number): RunEvent[];
}

/** agent_runs.created_at has 1-second resolution; an event recorded in the
 *  same second the run was created still counts as "before" it. */
const CREATED_AT_SLACK_MS = 999;

/** Merge a run's own events with the workflow-keyed events assigned to it.
 *  Sorted by time; on a tie, workflow events (which precede the run) first. */
export function buildRunTimeline(runId: string, src: RunTimelineSource, limit = 1000): TimelineEvent[] {
  const own: TimelineEvent[] = src.events(runId, limit);
  const workflowId = src.workflowOf(runId);
  if (!workflowId || workflowId === runId) return own;

  const wfEvents = src.events(workflowId, limit);
  if (wfEvents.length === 0) return own;

  const runs = [...src.runsOfWorkflow(workflowId)].sort((a, b) => a.createdAtMs - b.createdAtMs);
  const ownerOf = (ts: number): string | undefined =>
    runs.find(r => r.createdAtMs + CREATED_AT_SLACK_MS >= ts)?.runId ?? runs[runs.length - 1]?.runId;

  const linked: TimelineEvent[] = wfEvents
    .filter(ev => ownerOf(ev.ts) === runId)
    .map(ev => ({ ...ev, linked: 'workflow' as const }));
  if (linked.length === 0) return own;

  return [...linked, ...own]
    .map((ev, i) => ({ ev, i }))
    .sort((a, b) => a.ev.ts - b.ev.ts || a.i - b.i)
    .map(x => x.ev)
    .slice(0, limit);
}

/** SQLite-backed source (statements prepared lazily, like runEvents.ts). */
export function createSqliteRunTimelineSource(): RunTimelineSource {
  return {
    workflowOf(runId) {
      const row = getDb().prepare(`SELECT workflow_id FROM agent_runs WHERE run_id=?`).get(runId) as { workflow_id: string } | undefined;
      return row?.workflow_id ?? null;
    },
    runsOfWorkflow(workflowId) {
      const rows = getDb()
        .prepare(`SELECT run_id, created_at FROM agent_runs WHERE workflow_id=? ORDER BY created_at ASC`)
        .all(workflowId) as Array<{ run_id: string; created_at: number }>;
      return rows.map(r => ({ runId: r.run_id, createdAtMs: r.created_at * 1000 }));
    },
    events(id, limit) {
      return listRunEvents(id, 0, limit);
    },
  };
}

/** The timeline for one run (IPC `run:timeline`). */
export function getRunTimeline(runId: string, limit = 1000): TimelineEvent[] {
  return buildRunTimeline(runId, createSqliteRunTimelineSource(), limit);
}
