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
import { app } from 'electron';
import { getDb } from '../db/schema';
import { userFacingOutcome, legacyStatusToOutcome, type RunOutcome } from '../bodhi/taskModel';
import { sendNotification } from '../notify';
import { startCheckIn, finishCheckIn, addBreadcrumb, captureException } from '../sentry';

/** Sentry cron-monitor slug for the daily health check. */
const HEALTH_MONITOR_SLUG = 'artha-daily-health';

/** Shape of a row from the scheduled_tasks table. */
export interface ScheduledTask {
  task_id: string;
  name: string;
  /** The verbatim prompt sent to the agent when this task fires. */
  prompt: string;
  /** Standard cron expression (null for one-shot tasks). */
  cron: string | null;
  /** Unix timestamp (seconds) — set only for one-shot tasks. */
  fire_at: number | null;
  /** SQLite boolean: 1 = active, 0 = disabled / already fired (one-shot). */
  is_enabled: number;
  last_run_at: number | null;
  /** 'running' | 'ok' | 'error' — persisted for display in the UI. */
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
  /** The daily 03:00 health-check job (distinct from user tasks). */
  private healthJob: schedule.Job | null = null;
  /** Injected by init() — avoids circular import with the orchestrator. */
  private runTask: ((prompt: string) => Promise<{ sessionId: string } | void>) | null = null;
  /** Task ids with a run in flight — prevents a slow hourly job from
   *  overlapping itself and racing its own last_status writes. */
  private inFlight = new Set<string>();

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
  async init(runner: (prompt: string) => Promise<{ sessionId: string } | void>): Promise<void> {
    this.runTask = runner;
    const db = getDb();
    const tasks = db
      .prepare(`SELECT * FROM scheduled_tasks WHERE is_enabled=1`)
      .all() as ScheduledTask[];

    for (const task of tasks) {
      this.scheduleTask(task);
    }

    // Business-continuity heartbeat: a daily health check at 03:00 local time
    // that emits a Sentry monitor check-in. This gives a per-install heartbeat
    // so a bad release that silently breaks Ollama/SQLite for non-reporting
    // users still shows up as "missed check-ins" in cron monitoring.
    this.scheduleHealthCheck();

    console.log(`[Artha] Scheduler initialised — ${tasks.length} task(s) loaded.`);
  }

  /** Register the daily 03:00 health check. Idempotent. */
  private scheduleHealthCheck(): void {
    if (this.healthJob) { this.healthJob.cancel(); this.healthJob = null; }
    // '0 3 * * *' — every day at 03:00 local time.
    this.healthJob = schedule.scheduleJob('artha-health', '0 3 * * *', () => {
      void this.runHealthCheck();
    });
    if (this.healthJob) console.log('[Artha] Daily health check scheduled (03:00).');
  }

  /**
   * Run the daily health check and report it as a Sentry cron monitor check-in.
   * Checks three things, all locally:
   *   1. Ollama reachability (localhost:11434).
   *   2. SQLite integrity (PRAGMA integrity_check).
   *   3. Free disk space on the userData volume.
   * Only non-PII signals (booleans + numbers) are attached to the breadcrumb;
   * no paths, settings, or content. The check-in is 'error' when integrity is
   * not 'ok' or disk is critically low, else 'ok'.
   */
  async runHealthCheck(): Promise<{ ollama: boolean; integrityOk: boolean; freeDiskGb: number }> {
    const checkInId = startCheckIn(HEALTH_MONITOR_SLUG);

    let ollama = false;
    let integrityOk = false;
    let freeDiskGb = -1;
    try {
      // 1. Ollama reachability (short timeout so a down runtime can't hang us).
      try {
        const controller = new AbortController();
        const t = setTimeout(() => controller.abort(), 2000);
        const res = await fetch('http://localhost:11434/api/tags', { signal: controller.signal });
        clearTimeout(t);
        ollama = res.ok;
      } catch { ollama = false; }

      // 2. SQLite integrity.
      try {
        const result = getDb().pragma('integrity_check', { simple: true }) as string;
        integrityOk = result === 'ok';
      } catch { integrityOk = false; }

      // 3. Free disk space on the userData volume.
      try {
        const fs = await import('fs');
        // statfs is available on Node 18+. bavail * bsize = bytes available.
        const stat = await fs.promises.statfs(app.getPath('userData'));
        freeDiskGb = Math.round((stat.bavail * stat.bsize) / 1024 / 1024 / 1024);
      } catch { freeDiskGb = -1; }

      // Non-PII breadcrumb so the result is visible in any later crash report.
      addBreadcrumb('artha.health_check', 'daily health check', {
        ollama_connected: ollama,
        sqlite_integrity_ok: integrityOk,
        free_disk_gb: freeDiskGb,
      });

      // Disk under 1 GB is treated as critical for continuity purposes.
      const diskCritical = freeDiskGb >= 0 && freeDiskGb < 1;
      finishCheckIn(HEALTH_MONITOR_SLUG, checkInId, integrityOk && !diskCritical ? 'ok' : 'error');
    } catch (err) {
      captureException(err);
      finishCheckIn(HEALTH_MONITOR_SLUG, checkInId, 'error');
    }

    return { ollama, integrityOk, freeDiskGb };
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
    if (this.healthJob) { this.healthJob.cancel(); this.healthJob = null; }
    console.log('[Artha] Scheduler shut down.');
  }

  // ── CRUD helpers (used by IPC handlers) ──────────────────────────────────

  /** Return all tasks ordered newest-first (both enabled and disabled). */
  list(): ScheduledTask[] {
    return getDb().prepare(`SELECT * FROM scheduled_tasks ORDER BY created_at DESC`).all() as ScheduledTask[];
  }

  /** Persist a new task row and immediately schedule it. */
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

  /** Merge a partial patch over an existing task row and re-schedule it if
   *  still enabled. `is_enabled` can be passed directly (int 0/1) for internal
   *  toggle/disable-after-fire use. */
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

  /** Cancel the in-memory job and delete the DB row permanently. */
  remove(taskId: string): void {
    this.cancelTask(taskId);
    getDb().prepare(`DELETE FROM scheduled_tasks WHERE task_id=?`).run(taskId);
  }

  /** Convenience wrapper: enable or disable a task by boolean. */
  toggle(taskId: string, enabled: boolean): ScheduledTask {
    return this.update(taskId, { is_enabled: enabled ? 1 : 0 });
  }

  // ── Private ──────────────────────────────────────────────────────────────

  /** Wrap the runner with DB bookkeeping (last_run_at, last_status, run_count). */
  /**
   * Read what ACTUALLY happened in the run this fire started, and project it
   * through the shared outcome function so the scheduler notification uses the
   * same wording rules as every other surface (no surface may manufacture the
   * word "complete" on its own).
   */
  private readRunOutcome(
    db: ReturnType<typeof getDb>,
    sessionId: string | undefined,
  ): { lastStatus: string; runId: string | null; taskStatus: string; detail: string; title: string } {
    // No session means handleMessage returned before creating a run at all —
    // the approval dead-end (audit S1). That is emphatically not a completion.
    if (!sessionId) {
      return {
        lastStatus: 'blocked', runId: null, taskStatus: 'awaiting_approval',
        detail: 'requires your approval before it can continue. No consequential action was performed.',
        title: 'Artha — scheduled task needs approval',
      };
    }
    const row = db.prepare(
      `SELECT run_id, status, run_outcome, tool_calls_total, tool_calls_failed,
              tool_calls_blocked, error_detail
         FROM agent_runs WHERE session_id=? ORDER BY created_at DESC LIMIT 1`
    ).get(sessionId) as {
      run_id: string; status: string; run_outcome: string | null;
      tool_calls_total: number | null; tool_calls_failed: number | null;
      tool_calls_blocked: number | null; error_detail: string | null;
    } | undefined;

    if (!row) {
      return {
        lastStatus: 'blocked', runId: null, taskStatus: 'awaiting_approval',
        detail: 'did not execute — it is waiting for approval or was stopped before starting.',
        title: 'Artha — scheduled task did not run',
      };
    }

    const outcome = userFacingOutcome({
      run: {
        outcome: (row.run_outcome as RunOutcome) ?? legacyStatusToOutcome(row.status),
        toolCallsTotal: row.tool_calls_total ?? 0,
        toolCallsFailed: row.tool_calls_failed ?? 0,
        toolCallsBlocked: row.tool_calls_blocked ?? 0,
        mutationsTotal: 0,
        mutationsFailed: 0,
        errorDetail: row.error_detail,
      },
      criteria: [],
      acceptanceMode: 'system_verified',
      externalActionStates: [],
      evidenceCount: (row.tool_calls_total ?? 0) - (row.tool_calls_failed ?? 0),
      legacy: row.run_outcome == null,
    });

    const lastStatus =
      outcome.taskStatus === 'completed' ? 'ok'
      : outcome.taskStatus === 'failed' ? 'error'
      : outcome.taskStatus === 'cancelled' ? 'cancelled'
      : outcome.taskStatus === 'awaiting_approval' ? 'blocked'
      : 'unverified';

    const title =
      lastStatus === 'error' ? 'Artha — scheduled task failed'
      : lastStatus === 'ok' ? 'Artha — scheduled task done'
      : 'Artha — scheduled task ran, not verified';

    return { lastStatus, runId: row.run_id, taskStatus: outcome.taskStatus, detail: outcome.message, title };
  }

  private makeRunner(taskId: string, prompt: string): () => void {
    return async () => {
      const db = getDb();

      // Overlap guard: without this, an hourly job whose run exceeds an hour
      // starts a second concurrent run, double-counts run_count, and the two
      // last_status writes race — one run's 'error' silently overwritten by
      // the other's 'ok' (audit §5.4).
      if (this.inFlight.has(taskId)) {
        console.warn(`[Artha] Scheduled task ${taskId} skipped: previous run still in flight.`);
        return;
      }
      this.inFlight.add(taskId);

      const now = Math.floor(Date.now() / 1000);
      db.prepare(`UPDATE scheduled_tasks SET last_run_at=?, last_status='running', run_count=run_count+1 WHERE task_id=?`)
        .run(now, taskId);

      try {
        const taskRow = db.prepare(`SELECT name FROM scheduled_tasks WHERE task_id=?`).get(taskId) as { name: string } | undefined;
        const label = taskRow?.name ?? prompt.slice(0, 60);
        const handle = await this.runTask!(prompt);

        // The executor returning proves NOTHING — every orchestrator failure
        // path breaks rather than throws, so 'the promise resolved' was
        // reported as success for stalls, cancellations, LLM errors,
        // all-tools-failed runs, and plans that never executed at all
        // (audit C2/S1-S3). Read the real outcome instead.
        const outcome = this.readRunOutcome(db, (handle as { sessionId?: string } | void)?.sessionId);
        db.prepare(`UPDATE scheduled_tasks SET last_status=?, last_run_id=?, last_outcome=?, last_detail=? WHERE task_id=?`)
          .run(outcome.lastStatus, outcome.runId, outcome.taskStatus, outcome.detail, taskId);
        sendNotification(outcome.title, `${label} — ${outcome.detail}`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[Artha] Scheduled task ${taskId} failed:`, msg);
        db.prepare(`UPDATE scheduled_tasks SET last_status='error', last_outcome='failed', last_detail=? WHERE task_id=?`)
          .run(msg.slice(0, 300), taskId);
        const nameRow = db.prepare(`SELECT name FROM scheduled_tasks WHERE task_id=?`).get(taskId) as { name?: string } | undefined;
        sendNotification('Artha — scheduled task failed', `${nameRow?.name ?? prompt.slice(0, 60)} — ${msg.slice(0, 120)}`);
      } finally {
        this.inFlight.delete(taskId);
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
