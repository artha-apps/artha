/**
 * Bodhi — Tasks.
 *
 * A **Task** is the core durable unit of work in Artha, and it is NOT a new
 * table: it is the existing `agent_runs` row, given a first-class name and a
 * clean read/write API. Every delegated goal, chat turn that runs the loop, and
 * scheduled job becomes a Task. Because Tasks already persist (run + steps), the
 * platform is async/resumable by construction — a Task survives a tab switch,
 * a window reload, or an app restart, and its progress can be observed by
 * reading its steps. This is the local-first execution backbone the higher
 * layers (Delegate especially) project onto the UI.
 *
 * The row→Task mapping is pure (and unit-tested); the query/mutation helpers are
 * thin wrappers over the shared SQLite connection.
 */
import { getDb } from '../db/schema';

/** Lifecycle of a Task, mirroring `agent_runs.status`. */
export type TaskStatus = 'running' | 'completed' | 'failed' | 'cancelled';

/** A durable unit of work — one `agent_runs` row, normalised. */
export interface Task {
  /** The run id — the Task's stable identifier. */
  id: string;
  sessionId: string;
  workflowId: string;
  /** Set when this Task was forked from another (time-travel) — the lineage
   *  that future multi-agent sub-tasks will also use. */
  parentTaskId: string | null;
  goal: string;
  model: string;
  status: TaskStatus;
  createdAt: number;
}

/** Raw `agent_runs` row shape (the columns we read). */
interface AgentRunRow {
  run_id: string;
  session_id: string;
  workflow_id: string;
  parent_run_id: string | null;
  goal: string;
  model: string;
  status: TaskStatus;
  created_at: number;
}

/** Pure projection: an `agent_runs` row → a Task. */
export function rowToTask(row: AgentRunRow): Task {
  return {
    id: row.run_id,
    sessionId: row.session_id,
    workflowId: row.workflow_id,
    parentTaskId: row.parent_run_id ?? null,
    goal: row.goal,
    model: row.model,
    status: row.status,
    createdAt: row.created_at,
  };
}

const SELECT = `SELECT run_id, session_id, workflow_id, parent_run_id, goal, model, status, created_at FROM agent_runs`;

/** Fetch one Task by id (run id). */
export function getTask(taskId: string): Task | null {
  const row = getDb().prepare(`${SELECT} WHERE run_id = ?`).get(taskId) as AgentRunRow | undefined;
  return row ? rowToTask(row) : null;
}

/** Recent Tasks, newest first. */
export function listTasks(limit = 50): Task[] {
  const rows = getDb().prepare(`${SELECT} ORDER BY created_at DESC LIMIT ?`).all(limit) as AgentRunRow[];
  return rows.map(rowToTask);
}

/** Tasks for a given session (e.g. the runs behind one Delegate goal). */
export function listTasksForSession(sessionId: string): Task[] {
  const rows = getDb().prepare(`${SELECT} WHERE session_id = ? ORDER BY created_at DESC`).all(sessionId) as AgentRunRow[];
  return rows.map(rowToTask);
}

/** The step trace for a Task — the basis for the progress timeline and for
 *  verifying that what the Task claimed actually happened. */
export function getTaskSteps(taskId: string): { idx: number; kind: string; payload: string; ts: number }[] {
  return getDb()
    .prepare(`SELECT idx, kind, payload, ts FROM agent_steps WHERE run_id = ? ORDER BY idx ASC`)
    .all(taskId) as { idx: number; kind: string; payload: string; ts: number }[];
}

/** Update a Task's status (running → completed/failed/cancelled). */
export function setTaskStatus(taskId: string, status: TaskStatus): void {
  getDb().prepare(`UPDATE agent_runs SET status = ? WHERE run_id = ?`).run(status, taskId);
}
