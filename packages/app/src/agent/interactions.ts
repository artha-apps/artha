/**
 * Unified human-in-the-loop interaction frame.
 *
 * Every place a run pauses for a person — an `ask_user` question, a plan
 * approval, a browser handoff (`browser_request_user`), or a policy `confirm`
 * on a tool call — opens ONE `Interaction`. The frame gives all four the same
 * shape, the same persistence (the `interactions` table, so a pending one
 * survives a renderer reload and is re-shown on load) and the same
 * answer/decline/expire lifecycle.
 *
 * It is additive: the legacy per-flow IPC (`agent:approvePlan`,
 * `agent:respondToolApproval`, `browser:resumeAgent`, …) keeps working; those
 * paths simply settle the matching interaction too.
 *
 * The in-memory waiter is authoritative for unblocking the run; persistence is
 * best-effort so a DB hiccup can never wedge (or silently approve) a run.
 */
import * as crypto from 'crypto';
import { getDb } from '../db/schema';

/** What kind of pause this is. */
export type InteractionKind = 'ask' | 'plan' | 'handoff' | 'confirm';

/** Lifecycle: pending until the user answers/declines, or until the run can no
 *  longer receive the answer (timeout, app restart) → expired. */
export type InteractionStatus = 'pending' | 'answered' | 'declined' | 'expired';

/** One persisted human-in-the-loop pause.
 *  `run_id` is the paused run's `agent_runs.run_id` where one exists (ask,
 *  confirm). Plan approval happens before a run row is created and the browser
 *  handoff only knows its workflow, so for those it holds the workflow id; the
 *  payload always carries `workflowId` too. */
export interface Interaction {
  id: string;
  run_id: string;
  kind: InteractionKind;
  payload: Record<string, unknown>;
  status: InteractionStatus;
  answer_json: string | null;
  created_at: number;
  answered_at: number | null;
}

/** How a pending interaction ended, as seen by the code awaiting it. */
export interface InteractionOutcome {
  status: Exclude<InteractionStatus, 'pending'>;
  answer: unknown;
}

/** Called when the UI responds to an interaction whose flow owns its own
 *  resolution (e.g. a plan review that may trigger a revision). The handler
 *  is responsible for eventually calling `settle()`. */
export type InteractionResponder = (status: 'answered' | 'declined', answer: unknown) => void;

/** Minimal SQLite surface used here. Satisfied by better-sqlite3 at runtime and
 *  by node:sqlite in tests. */
interface SqlLike {
  prepare(sql: string): {
    run(...args: unknown[]): unknown;
    get(...args: unknown[]): unknown;
    all(...args: unknown[]): unknown[];
  };
}

/** Row shape as stored (payload is JSON text). */
interface InteractionRow extends Omit<Interaction, 'payload'> { payload: string }

/** Decode a stored row; a corrupt payload degrades to `{}` rather than throwing. */
function fromRow(r: InteractionRow): Interaction {
  let payload: Record<string, unknown> = {};
  try { payload = JSON.parse(r.payload) as Record<string, unknown>; } catch { /* keep {} */ }
  return { ...r, payload };
}

// ── Persistence (pure functions over a DB handle — unit-testable) ───────────

/** Insert a new pending interaction and return it. */
export function insertInteraction(
  db: SqlLike,
  req: { id?: string; runId: string; kind: InteractionKind; payload: Record<string, unknown> },
): Interaction {
  const id = req.id ?? crypto.randomUUID();
  const createdAt = Math.floor(Date.now() / 1000);
  db.prepare(
    `INSERT INTO interactions (id, run_id, kind, payload, status, created_at) VALUES (?, ?, ?, ?, 'pending', ?)`,
  ).run(id, req.runId, req.kind, JSON.stringify(req.payload ?? {}), createdAt);
  return {
    id, run_id: req.runId, kind: req.kind, payload: req.payload ?? {},
    status: 'pending', answer_json: null, created_at: createdAt, answered_at: null,
  };
}

/** Move a PENDING interaction to a terminal status. Returns false when it was
 *  already settled (first answer wins — a late double-click is a no-op). */
export function settleInteractionRow(
  db: SqlLike,
  id: string,
  status: Exclude<InteractionStatus, 'pending'>,
  answer: unknown,
): boolean {
  const res = db.prepare(
    `UPDATE interactions SET status=?, answer_json=?, answered_at=? WHERE id=? AND status='pending'`,
  ).run(status, answer === undefined ? null : JSON.stringify(answer), Math.floor(Date.now() / 1000), id) as { changes?: number | bigint };
  return Number(res?.changes ?? 0) > 0;
}

/** All pending interactions, oldest first — what the renderer re-shows on load. */
export function listPendingInteractions(db: SqlLike): Interaction[] {
  const rows = db.prepare(
    `SELECT id, run_id, kind, payload, status, answer_json, created_at, answered_at
       FROM interactions WHERE status='pending' ORDER BY created_at ASC, rowid ASC`,
  ).all() as InteractionRow[];
  return rows.map(fromRow);
}

/** Fetch one interaction by id (any status). */
export function getInteraction(db: SqlLike, id: string): Interaction | null {
  const r = db.prepare(
    `SELECT id, run_id, kind, payload, status, answer_json, created_at, answered_at FROM interactions WHERE id=?`,
  ).get(id) as InteractionRow | undefined;
  return r ? fromRow(r) : null;
}

// ── Hub: in-memory waiters + persistence + renderer events ──────────────────

/** Renderer event channels. */
export const INTERACTION_PENDING_CHANNEL = 'interaction:pending';
export const INTERACTION_RESOLVED_CHANNEL = 'interaction:resolved';

/** Process-wide broker. A singleton because several AgentOrchestrator
 *  instances exist (desktop, scheduler) while there is one IPC surface. */
export class InteractionHub {
  private waiters = new Map<string, {
    workflowId?: string;
    resolve: (o: InteractionOutcome) => void;
    responder?: InteractionResponder;
  }>();
  private emitFn: (channel: string, payload: unknown) => void = () => {};

  constructor(private db: () => SqlLike = () => getDb() as unknown as SqlLike) {}

  /** Wire renderer delivery (ipc/handlers.ts installs a safe webContents send). */
  setEmitter(fn: (channel: string, payload: unknown) => void): void {
    this.emitFn = fn;
  }

  /** Open a pending interaction. Persists it (best-effort), tells the renderer,
   *  and returns a promise that resolves when it is settled. An optional
   *  `responder` intercepts UI responses for flows that settle themselves. */
  open(
    req: { id?: string; runId: string; workflowId?: string; kind: InteractionKind; payload: Record<string, unknown> },
    responder?: InteractionResponder,
  ): { interaction: Interaction; outcome: Promise<InteractionOutcome> } {
    const payload = { ...req.payload, ...(req.workflowId ? { workflowId: req.workflowId } : {}) };
    let interaction: Interaction;
    try {
      interaction = insertInteraction(this.db(), { id: req.id, runId: req.runId, kind: req.kind, payload });
    } catch (err) {
      // Never let persistence block the pause itself — the in-memory waiter
      // still works; only reload-survival is lost.
      console.warn('[Artha] interaction persist failed (continuing in memory):', err);
      interaction = {
        id: req.id ?? crypto.randomUUID(), run_id: req.runId, kind: req.kind, payload,
        status: 'pending', answer_json: null, created_at: Math.floor(Date.now() / 1000), answered_at: null,
      };
    }
    const outcome = new Promise<InteractionOutcome>(resolve => {
      this.waiters.set(interaction.id, { workflowId: req.workflowId, resolve, responder });
    });
    this.emitFn(INTERACTION_PENDING_CHANNEL, interaction);
    return { interaction, outcome };
  }

  /** Entry point for a UI response. Routes to the flow's responder when one is
   *  registered, otherwise settles directly. Returns false for an unknown /
   *  already-settled id. */
  respond(id: string, status: 'answered' | 'declined', answer?: unknown): boolean {
    const w = this.waiters.get(id);
    if (!w) return false;
    if (w.responder) { w.responder(status, answer); return true; }
    return this.settle(id, status, answer);
  }

  /** Terminal transition: persist, release the waiter, notify the renderer.
   *  Idempotent — the first settle wins. */
  settle(id: string, status: Exclude<InteractionStatus, 'pending'>, answer?: unknown): boolean {
    const w = this.waiters.get(id);
    try { settleInteractionRow(this.db(), id, status, answer); } catch (err) {
      console.warn('[Artha] interaction settle persist failed:', err);
    }
    if (!w) return false;
    this.waiters.delete(id);
    w.resolve({ status, answer: answer ?? null });
    this.emitFn(INTERACTION_RESOLVED_CHANNEL, { id, status });
    return true;
  }

  /** Stop button: decline every pending interaction of a workflow so the run
   *  unblocks immediately instead of waiting on a card nobody will answer. */
  declineForWorkflow(workflowId: string): void {
    for (const [id, w] of [...this.waiters]) {
      if (w.workflowId === workflowId) this.settle(id, 'declined', { reason: 'cancelled' });
    }
  }

  /** Whether an interaction is still awaiting a live answer in this process. */
  isLive(id: string): boolean {
    return this.waiters.has(id);
  }

  /** Pending interactions for the renderer to re-show after a reload. Only rows
   *  with a live waiter are returned — a row whose run is gone cannot be
   *  answered, so showing it would be dishonest. */
  listPending(): Interaction[] {
    try {
      return listPendingInteractions(this.db()).filter(i => this.waiters.has(i.id));
    } catch {
      return [];
    }
  }
}

let hub: InteractionHub | null = null;

/** The process-wide hub. */
export function getInteractionHub(): InteractionHub {
  if (!hub) hub = new InteractionHub();
  return hub;
}
