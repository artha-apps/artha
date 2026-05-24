/**
 * Scheduler Service — cron-based and one-shot task runner.
 *
 * Each scheduled_task row stores either a `cron` expression (repeating) or a
 * `fire_at` unix timestamp (one-shot). On each fire the scheduler opens a new
 * chat session and calls the agent orchestrator with the task's prompt, exactly
 * as if the user had typed it. All processing stays local.
 *
 * Lifecycle:
 *   init()           — called once on app launch; loads all enabled tasks and
 *                      schedules them with node-schedule.
 *   scheduleTask()   — idempotent upsert; safe to call after create/update.
 *   cancelTask()     — cancels the in-memory job without deleting the DB row.
 *   shutdown()       — cancels all jobs (called on app quit).
 */
import * as schedule from 'node-schedule';
import { getDb } from '../db/schema';
import { sendNotification } from '../notify';

/** Shape of a row from the scheduled_tasks table. */
export interface ScheduledTask {
  task_id: string;
  name: string;
  prompt: string;
  cron: string | null;
  fire_at: number | null;
  is_enabled: number;
  last_run_at: number | null;
  last_status: string | null;
  run_count: number;
  created_at: number;
}

/** Input for creating / updating a scheduled task. */
export interface TaskInput {
  name: string;
  prompt: string;
  /** Standard cron expression — 5 or 6 fields, e.g. "0 8 * * 1-5" (9 AM weekdays). */
  cron?: string;
  /** Unix timestamp (seconds) for a one-shot task. Mutually exclusive with cron. */
  fire_at?: number;
}

// ── Singleton ────────────────────────────────────────────────────────────────

export class SchedulerService {
  private static instance: SchedulerService;
  /** In-memory map of task_id → node-schedule Job. */
  private jobs = new Map<string, schedule.Job>();
  /** Injected by init() — avoids circular import with the orchestrator. */
  private runTask: ((prompt: string) => Promise<void>) | null = null;

  static getInstance(): SchedulerService {
    if (!SchedulerService.instance) SchedulerService.instance = new SchedulerService();
    return SchedulerService.instance;
  }

  /**
   * Load all enabled tasks from SQLite and schedule them. Must be called after
   * the DB is initialised and the orchestrator is ready.
   *
   * @param runner  A function that accepts a prompt string and runs the agent
   *                (typically `orchestrator.handleMessage(sessionId, prompt)`
   *                wrapped to create a fresh session).
   */
  async init(runner: (prompt: string) => Promise<void>): Promise<void> {
    this.runTask = runner;
    const db = getDb();
    const tasks = db
      .prepare(`SELECT * FROM scheduled_tasks WHERE is_enabled=1`)
      .all() as ScheduledTask[];

    for (const task of tasks) {
      this.scheduleTask(task);
    }
    console.log(`[Artha] Scheduler initialised — ${tasks.length} task(s) loaded.`);
  }

  /** (Re-)schedule a single task from its DB row. Safe to call after upsert. */
  scheduleTask(task: ScheduledTask): void {
    // Cancel any existing job for this id before rescheduling.
    this.cancelTask(task.task_id);

    if (!task.is_enabled || !this.runTask) return;

    const run = this.makeRunner(task.task_id, task.prompt);

    if (task.cron) {
      const job = schedule.scheduleJob(task.task_id, task.cron, run);
      if (job) {
        this.jobs.set(task.task_id, job);
        console.log(`[Artha] Scheduled cron task "${task.name}" (${task.cron})`);
      } else {
        console.warn(`[Artha] Invalid cron expression for task "${task.name}": ${task.cron}`);
      }
    } else if (task.fire_at) {
      const fireDate = new Date(task.fire_at * 1000);
      if (fireDate <= new Date()) {
        console.warn(`[Artha] One-shot task "${task.name}" fire_at is in the past; skipping.`);
        return;
      }
      const job = schedule.scheduleJob(task.task_id, fireDate, run);
      if (job) {
        this.jobs.set(task.task_id, job);
        console.log(`[Artha] Scheduled one-shot task "${task.name}" at ${fireDate.toISOString()}`);
      }
    }
  }

  /** Cancel the in-memory job for a task (does not delete the DB row). */
  cancelTask(taskId: string): void {
    const existing = this.jobs.get(taskId);
    if (existing) {
      existing.cancel();
      this.jobs.delete(taskId);
    }
  }

  /** Cancel all scheduled jobs — called on app quit. */
  shutdown(): void {
    for (const [id, job] of this.jobs) {
      job.cancel();
      this.jobs.delete(id);
    }
    console.log('[Artha] Scheduler shut down.');
  }

  // ── CRUD helpers (used by IPC handlers) ──────────────────────────────────

  list(): ScheduledTask[] {
    return getDb().prepare(`SELECT * FROM scheduled_tasks ORDER BY created_at DESC`).all() as ScheduledTask[];
  }

  create(input: TaskInput): ScheduledTask {
    const db = getDb();
    const id = crypto.randomUUID();
    db.prepare(`
      INSERT INTO scheduled_tasks (task_id, name, prompt, cron, fire_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(id, input.name, input.prompt, input.cron ?? null, input.fire_at ?? null);
    const task = db.prepare(`SELECT * FROM scheduled_tasks WHERE task_id=?`).get(id) as ScheduledTask;
    this.scheduleTask(task);
    return task;
  }

  update(taskId: string, patch: Partial<TaskInput> & { is_enabled?: number }): ScheduledTask {
    const db = getDb();
    const existing = db.prepare(`SELECT * FROM scheduled_tasks WHERE task_id=?`).get(taskId) as ScheduledTask | undefined;
    if (!existing) throw new Error(`Task ${taskId} not found`);

    const merged = {
      name: patch.name ?? existing.name,
      prompt: patch.prompt ?? existing.prompt,
      cron: patch.cron !== undefined ? patch.cron : existing.cron,
      fire_at: patch.fire_at !== undefined ? patch.fire_at : existing.fire_at,
      is_enabled: patch.is_enabled !== undefined ? patch.is_enabled : existing.is_enabled,
    };
    db.prepare(`
      UPDATE scheduled_tasks SET name=?, prompt=?, cron=?, fire_at=?, is_enabled=? WHERE task_id=?
    `).run(merged.name, merged.prompt, merged.cron, merged.fire_at, merged.is_enabled, taskId);

    const updated = db.prepare(`SELECT * FROM scheduled_tasks WHERE task_id=?`).get(taskId) as ScheduledTask;
    this.cancelTask(taskId);
    if (updated.is_enabled) this.scheduleTask(updated);
    return updated;
  }

  remove(taskId: string): void {
    this.cancelTask(taskId);
    getDb().prepare(`DELETE FROM scheduled_tasks WHERE task_id=?`).run(taskId);
  }

  toggle(taskId: string, enabled: boolean): ScheduledTask {
    return this.update(taskId, { is_enabled: enabled ? 1 : 0 });
  }

  // ── Private ──────────────────────────────────────────────────────────────

  /** Wrap the runner with DB bookkeeping (last_run_at, last_status, run_count). */
  private makeRunner(taskId: string, prompt: string): () => void {
    return async () => {
      const db = getDb();
      const now = Math.floor(Date.now() / 1000);
      db.prepare(`UPDATE scheduled_tasks SET last_run_at=?, last_status='running', run_count=run_count+1 WHERE task_id=?`)
        .run(now, taskId);

      try {
        const taskRow = db.prepare(`SELECT name FROM scheduled_tasks WHERE task_id=?`).get(taskId) as { name: string } | undefined;
        await this.runTask!(prompt);
        db.prepare(`UPDATE scheduled_tasks SET last_status='ok' WHERE task_id=?`).run(taskId);
        sendNotification('Artha — scheduled task complete', taskRow?.name ?? prompt.slice(0, 60));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[Artha] Scheduled task ${taskId} failed:`, msg);
        db.prepare(`UPDATE scheduled_tasks SET last_status='error' WHERE task_id=?`).run(taskId);
      }

      // One-shot tasks: disable after firing so they don't re-trigger.
      const row = db.prepare(`SELECT cron FROM scheduled_tasks WHERE task_id=?`).get(taskId) as { cron: string | null } | undefined;
      if (!row?.cron) {
        db.prepare(`UPDATE scheduled_tasks SET is_enabled=0 WHERE task_id=?`).run(taskId);
        this.cancelTask(taskId);
      }
    };
  }
}
