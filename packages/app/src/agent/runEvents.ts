/**
 * Run event log — an append-only, per-run timeline of what an agent run did.
 *
 * Why it exists: the renderer receives a run's live stream as fire-and-forget
 * IPC events. A renderer reload or reconnect used to lose everything emitted
 * while it was away, and there was no replayable timeline of a run. Every
 * meaningful lifecycle point (status, plan, step, tool call/result,
 * interaction, heartbeat, terminal) is now also persisted to `run_events` with
 * a per-run monotonic `seq`, so a client can resubscribe from the last `seq`
 * it saw and get exactly the events it missed, then keep tailing live.
 *
 * What it is NOT: a source of truth for task completion. A `done` event only
 * records that the loop ENDED and the outcome the loop itself recorded;
 * whether the user's objective was achieved is still decided from evidence by
 * bodhi/. The heartbeat watchdog in particular can only ever append
 * `heartbeat` / `stalled` events — it never touches run status.
 */
import { EventEmitter } from 'events';
import { getDb } from '../db/schema';

/** Every kind of event the log records. `stalled` is the watchdog's signal
 *  that an active run has gone quiet; it is informational only. */
export type RunEventKind =
  | 'status'
  | 'plan'
  | 'step'
  | 'tool_call'
  | 'tool_result'
  | 'interaction'
  | 'heartbeat'
  | 'stalled'
  | 'done'
  | 'error';

/** One persisted event. `seq` starts at 1 and increases by exactly 1 per run. */
export interface RunEvent {
  runId: string;
  seq: number;
  ts: number;          // epoch milliseconds
  kind: RunEventKind;
  payload: unknown;
}

/** Storage seam. Production uses SQLite (`run_events`); tests inject an
 *  in-memory store because the native SQLite module is built for Electron. */
export interface RunEventStore {
  /** Highest seq stored for the run, or 0 if it has none. */
  maxSeq(runId: string): number;
  /** Insert one event. Must throw if (runId, seq) already exists. */
  insert(ev: RunEvent): void;
  /** Events with seq > afterSeq, ascending, at most `limit`. */
  list(runId: string, afterSeq: number, limit: number): RunEvent[];
}

/** Largest payload_json we persist. Tool results can be megabytes; the log is
 *  a timeline, not an archive (agent_steps keeps the fuller record). */
export const MAX_PAYLOAD_CHARS = 16_000;

/** SQLite-backed store over the shared WAL connection. Statements are
 *  prepared lazily so importing this module never requires an open DB. */
export function createSqliteRunEventStore(): RunEventStore {
  return {
    maxSeq(runId) {
      const row = getDb()
        .prepare(`SELECT MAX(seq) AS m FROM run_events WHERE run_id=?`)
        .get(runId) as { m: number | null } | undefined;
      return row?.m ?? 0;
    },
    insert(ev) {
      getDb()
        .prepare(`INSERT INTO run_events (run_id, seq, ts, kind, payload_json) VALUES (?, ?, ?, ?, ?)`)
        .run(ev.runId, ev.seq, ev.ts, ev.kind, serializePayload(ev.payload));
    },
    list(runId, afterSeq, limit) {
      const rows = getDb()
        .prepare(
          `SELECT run_id, seq, ts, kind, payload_json FROM run_events
           WHERE run_id=? AND seq>? ORDER BY seq ASC LIMIT ?`,
        )
        .all(runId, afterSeq, limit) as Array<{ run_id: string; seq: number; ts: number; kind: string; payload_json: string }>;
      return rows.map(r => ({
        runId: r.run_id, seq: r.seq, ts: r.ts, kind: r.kind as RunEventKind,
        payload: safeParse(r.payload_json),
      }));
    },
  };
}

/** Bounded JSON encoding: oversize payloads become a truncated preview rather
 *  than being dropped, so the timeline still shows that the event happened. */
export function serializePayload(payload: unknown): string {
  let json: string;
  try { json = JSON.stringify(payload ?? null) ?? 'null'; } catch { json = JSON.stringify({ unserializable: true }); }
  if (json.length <= MAX_PAYLOAD_CHARS) return json;
  return JSON.stringify({ truncated: true, preview: json.slice(0, MAX_PAYLOAD_CHARS) });
}

/** Parse stored JSON without ever throwing on a corrupt row. */
function safeParse(s: string): unknown {
  try { return JSON.parse(s); } catch { return null; }
}

// ── Module state ─────────────────────────────────────────────────────────────

let store: RunEventStore = createSqliteRunEventStore();
/** Last seq handed out per run. Seeded from the store on first append so a
 *  run resumed after an app restart continues its sequence without gaps. */
const lastSeq = new Map<string, number>();
/** In-process fan-out for live tailing. One channel per run id. */
const emitter = new EventEmitter();
emitter.setMaxListeners(0); // many subscribers (renderer + LAN clients) is normal

/** Swap the storage backend (tests) and clear cached sequence state. */
export function setRunEventStore(s: RunEventStore): void {
  store = s;
  lastSeq.clear();
  emitter.removeAllListeners();
}

/**
 * Append one event and return its seq. Synchronous end to end, so two callers
 * can never be handed the same seq inside this process: JS runs one append at
 * a time and the counter is bumped before control returns. If the insert
 * collides anyway (another writer on the same DB), the counter is re-seeded
 * from the store and the insert retried once. Live subscribers are notified
 * only AFTER the row is durable, so a replay can never miss an event a tail
 * already delivered.
 */
export function appendRunEvent(runId: string, kind: RunEventKind, payload?: unknown): number {
  let next = (lastSeq.has(runId) ? lastSeq.get(runId)! : store.maxSeq(runId)) + 1;
  const ev: RunEvent = { runId, seq: next, ts: Date.now(), kind, payload: payload ?? null };
  try {
    store.insert(ev);
  } catch {
    next = store.maxSeq(runId) + 1;
    ev.seq = next;
    store.insert(ev); // a second failure is a real storage error — let it surface
  }
  // Terminal events drop the cached counter so the map can't grow without
  // bound; a later append for the run simply re-seeds from the store.
  if (kind === 'done' || kind === 'error') lastSeq.delete(runId); else lastSeq.set(runId, next);
  emitter.emit(runId, ev);
  return next;
}

/**
 * Best-effort append for instrumentation call sites inside the agent loop: a
 * logging failure must never break or alter a run. Returns the seq, or -1.
 */
export function recordRunEvent(runId: string, kind: RunEventKind, payload?: unknown): number {
  try { return appendRunEvent(runId, kind, payload); } catch (err) {
    console.warn('[Artha] run event append failed:', err);
    return -1;
  }
}

/** Persisted events after `fromSeq` (exclusive — pass the last seq you have,
 *  or 0 for the whole run), ascending, capped at `limit`. */
export function listRunEvents(runId: string, fromSeq = 0, limit = 500): RunEvent[] {
  const lim = Math.max(1, Math.min(5000, Math.floor(limit)));
  return store.list(runId, Math.max(0, Math.floor(fromSeq)), lim);
}

/** Raw live listener for one run (no replay). Returns an unsubscribe fn. */
export function onRunEvent(runId: string, listener: (ev: RunEvent) => void): () => void {
  emitter.on(runId, listener);
  return () => { emitter.off(runId, listener); };
}

/**
 * Replay-then-tail subscription with exactly-once delivery.
 *
 * 1. Attach a live listener FIRST, buffering anything that arrives meanwhile,
 *    so no event can fall between "replay finished" and "tail started".
 * 2. Replay persisted events after `fromSeq` in pages.
 * 3. Drain the buffer, then deliver live events directly.
 * A single `cursor` (highest seq delivered) gates every delivery, so an event
 * seen both in the replay and in the buffer is delivered once, in order.
 */
export function subscribeRunEvents(
  runId: string,
  fromSeq: number,
  deliver: (ev: RunEvent) => void,
): () => void {
  let cursor = Math.max(0, Math.floor(fromSeq));
  let replaying = true;
  const buffered: RunEvent[] = [];
  const push = (ev: RunEvent): void => {
    if (ev.seq <= cursor) return; // already delivered — the exactly-once gate
    cursor = ev.seq;
    deliver(ev);
  };
  const off = onRunEvent(runId, ev => { if (replaying) buffered.push(ev); else push(ev); });
  try {
    for (;;) {
      const page = listRunEvents(runId, cursor, 500);
      if (page.length === 0) break;
      for (const ev of page) push(ev);
    }
    buffered.sort((a, b) => a.seq - b.seq);
    for (const ev of buffered) push(ev);
  } finally {
    buffered.length = 0;
    replaying = false;
  }
  return off;
}

// ── IPC channel mapping ──────────────────────────────────────────────────────

/** Truncate long strings inside a tool payload so live events stay small. */
function clip(s: unknown, n = 4000): unknown {
  return typeof s === 'string' && s.length > n ? `${s.slice(0, n)}…` : s;
}

/**
 * Map an existing renderer IPC event from the agent loop to a run event, or
 * null when the channel is not part of the timeline (tokens, reasoning, stream
 * resets are high-volume UI detail, not lifecycle). Keeps the orchestrator
 * diff to one call in its emit gate.
 */
export function runEventFromChannel(
  channel: string,
  data: unknown,
): { kind: RunEventKind; payload: unknown } | null {
  const d = (data ?? {}) as Record<string, unknown>;
  switch (channel) {
    case 'agent:status':
      return { kind: 'status', payload: { text: typeof data === 'string' ? data : d } };
    case 'agent:modelRouted':
      return { kind: 'status', payload: { modelRouted: data } };
    case 'agent:toolCall':
      if (d.type === 'tool_invoke') return { kind: 'tool_call', payload: { name: d.name, args: clip(d.args) } };
      if (d.type === 'tool_result') return { kind: 'tool_result', payload: { name: d.name, status: d.status, result: clip(d.result) } };
      return null;
    default:
      return null;
  }
}

// ── Heartbeat + stall watchdog ───────────────────────────────────────────────

/** Tunables for the per-run monitor (defaults per spec: 10 s / 60 s). */
export interface RunMonitorOptions {
  heartbeatMs?: number;
  stallMs?: number;
}

/** Kinds that do NOT count as run activity for the watchdog — otherwise its
 *  own heartbeats would keep a frozen run looking alive forever. */
const PASSIVE_KINDS: ReadonlySet<RunEventKind> = new Set(['heartbeat', 'stalled']);

/**
 * Start the heartbeat + watchdog for an active run. Returns a stop function
 * (idempotent); the monitor also stops itself on a `done` / `error` event.
 *
 * - Every `heartbeatMs` it appends a `heartbeat` so clients can tell "run is
 *   alive but quiet" from "connection dropped".
 * - If no activity event lands for `stallMs`, it appends ONE `stalled` event
 *   (re-armed when activity resumes). While an interaction is pending — the
 *   run is waiting on the user — it does not report a stall.
 *
 * Honest-status guarantee: this function's only side effect is appending
 * `heartbeat` / `stalled` events. It never writes run status, never emits
 * `done`, and never declares a run completed.
 */
export function startRunMonitor(runId: string, opts: RunMonitorOptions = {}): () => void {
  const heartbeatMs = opts.heartbeatMs ?? 10_000;
  const stallMs = opts.stallMs ?? 60_000;
  let lastActivity = Date.now();
  let stalledReported = false;
  let awaitingUser = false;
  let stopped = false;

  const off = onRunEvent(runId, ev => {
    if (PASSIVE_KINDS.has(ev.kind)) return;
    lastActivity = ev.ts;
    stalledReported = false;
    if (ev.kind === 'interaction') {
      const phase = (ev.payload as { phase?: string } | null)?.phase;
      awaitingUser = phase === 'request';
    }
    if (ev.kind === 'done' || ev.kind === 'error') stop();
  });

  const timer = setInterval(() => {
    if (stopped) return;
    const idleMs = Date.now() - lastActivity;
    recordRunEvent(runId, 'heartbeat', { idleMs });
    if (!awaitingUser && !stalledReported && idleMs >= stallMs) {
      stalledReported = true;
      recordRunEvent(runId, 'stalled', { idleMs, note: 'no run activity; run status unchanged' });
    }
  }, heartbeatMs);
  // Never keep the process alive just to heartbeat.
  (timer as { unref?: () => void }).unref?.();

  function stop(): void {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    off();
  }
  return stop;
}
