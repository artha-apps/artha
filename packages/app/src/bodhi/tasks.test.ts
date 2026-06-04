/**
 * Unit test for the pure Task projection. The DB-backed query helpers are thin
 * wrappers over SQLite and are covered by integration use; the row→Task mapping
 * is the piece worth pinning down here.
 */
import { describe, it, expect } from 'vitest';
import { rowToTask } from './tasks';

describe('rowToTask', () => {
  it('projects an agent_runs row into a Task', () => {
    const task = rowToTask({
      run_id: 'run-1',
      session_id: 'sess-1',
      workflow_id: 'wf-1',
      parent_run_id: null,
      goal: 'Research competitors',
      model: 'qwen2.5:7b',
      status: 'completed',
      created_at: 1717000000,
    });
    expect(task).toEqual({
      id: 'run-1',
      sessionId: 'sess-1',
      workflowId: 'wf-1',
      parentTaskId: null,
      goal: 'Research competitors',
      model: 'qwen2.5:7b',
      status: 'completed',
      createdAt: 1717000000,
    });
  });

  it('preserves the parent lineage when forked', () => {
    const task = rowToTask({
      run_id: 'run-2',
      session_id: 'sess-1',
      workflow_id: 'wf-2',
      parent_run_id: 'run-1',
      goal: 'retry',
      model: 'm',
      status: 'running',
      created_at: 1,
    });
    expect(task.parentTaskId).toBe('run-1');
    expect(task.status).toBe('running');
  });
});
