/**
 * Sentry — operational resilience for the Artha main process.
 *
 * Privacy is the hard constraint of this module: Artha is a local-first app, so
 * NOTHING that could identify the user or reveal their data may leave the
 * machine. We send ONLY:
 *   - exception types + messages + stack traces (scrubbed of file paths)
 *   - the release version, environment, and a small set of NON-PII tags
 *     (artha.ollama_connected, artha.mcp_server_count)
 *   - breadcrumbs we explicitly add (DB health checkpoints, health-check runs)
 *
 * We never send: user messages, file contents, memory entity values, folder
 * paths, prompts, tool arguments/results, or any free text the user typed.
 *
 * Sentry is OPT-OUT: enabled by default, disabled from Settings. A one-time
 * disclosure is shown on first launch (see `ipc/handlers.ts` → sentry:* +
 * the renderer disclosure). When disabled, `initSentry()` is a no-op and every
 * helper below short-circuits, so not a single event is emitted.
 */
import * as Sentry from '@sentry/electron/main';
import { app } from 'electron';
import { getDb } from './db/schema';
import { scrubEvent } from './sentryScrub';

/** Default DSN baked into shipped builds.
 *
 *  This points at the Artha project (org `noopur-trivedi`, US region). A Sentry
 *  DSN is a PUBLIC, write-only ingest key — it can only submit events, never
 *  read them or touch the account — so it is safe to commit / ship in the
 *  client. Shape: https://<publicKey>@o<org>.ingest.sentry.io/<projectId>
 *
 *  With a DSN present, Artha ships with crash reporting ACTIVE but still fully
 *  user opt-out (see `isSentryEnabled` + the one-time disclosure) and only ever
 *  transmits scrubbed, non-PII operational data (see scrubEvent + the module
 *  header). To ship a DORMANT build instead (nothing ever transmitted), set
 *  this back to '' — `initSentry()` then becomes a no-op.
 *
 *  An explicit `ARTHA_SENTRY_DSN` env var still overrides this at build/runtime
 *  for dev / CI / self-hosted / fork builds. */
const DEFAULT_SENTRY_DSN = 'https://07535d0b32acc4920d76e140da1ed94c@o4511487247581184.ingest.us.sentry.io/4511487249547264';

/** Effective DSN: an explicit env override wins (dev / CI / self-hosted), else
 *  the committed default (empty by default → Sentry stays no-op and transmits
 *  nothing). */
const SENTRY_DSN = process.env.ARTHA_SENTRY_DSN ?? DEFAULT_SENTRY_DSN;

let initialised = false;
/** Runtime kill-switch. Mirrors the `sentry_enabled` setting so toggling it OFF
 *  mid-session stops all transmission immediately (without waiting for a
 *  restart). Every helper below checks `initialised && runtimeEnabled`. */
let runtimeEnabled = true;

/** Flip the runtime kill-switch when the user toggles the Settings opt-out.
 *  Disabling takes effect immediately; enabling resumes only if Sentry was
 *  initialised at launch (a fresh init requires a restart). */
export function setSentryRuntimeEnabled(enabled: boolean): void {
  runtimeEnabled = enabled;
}

/** True only when Sentry is initialised AND not runtime-disabled. */
function active(): boolean {
  return initialised && runtimeEnabled;
}

/** Read the user's opt-out flag from the settings blob. Default ON (opt-out):
 *  Sentry runs unless `sentry_enabled` is explicitly false. Best-effort — if
 *  the DB can't be read we default to DISABLED so we never transmit by accident
 *  before the user has had a chance to see the disclosure. */
export function isSentryEnabled(): boolean {
  try {
    const row = getDb().prepare(`SELECT settings_json FROM users WHERE user_id='default'`).get() as { settings_json: string } | undefined;
    const s = JSON.parse(row?.settings_json ?? '{}') as { sentry_enabled?: boolean };
    return s.sentry_enabled !== false;
  } catch {
    return false;
  }
}

/** The privacy backstop (`scrubEvent`) lives in `./sentryScrub` as a pure,
 *  electron-free function so it can be unit-tested in isolation. It runs last,
 *  as Sentry's `beforeSend`, stripping paths / user / request / device / frame
 *  vars and keeping only our own 'artha.*' breadcrumbs. */

/**
 * Initialise Sentry for the main process. No-op when disabled by the user, when
 * already initialised, or when no DSN is configured. Tags the session with the
 * release, environment, and the live operational signals the support workflow
 * correlates errors against.
 */
export function initSentry(opts: { ollamaConnected: boolean; mcpServerCount: number }): void {
  if (initialised) return;
  if (!isSentryEnabled()) return;
  if (!SENTRY_DSN) {
    console.log('[Artha] Sentry DSN not configured — telemetry disabled.');
    return;
  }

  Sentry.init({
    dsn: SENTRY_DSN,
    // Release tagging so a "this broke in 0.1.x" report points at a real build.
    release: process.env.npm_package_version ?? app.getVersion(),
    environment: process.env.NODE_ENV === 'development' ? 'development' : 'production',
    // Low default trace sample — enough to catch slow/failed migrations
    // (which we wrap in spans) without shipping volume from every install.
    tracesSampleRate: 0.1,
    // Belt-and-braces: never auto-collect PII even before beforeSend runs.
    sendDefaultPii: false,
    // The privacy backstop — strips paths/content from every outbound event.
    // Also the enforcement point for the runtime kill-switch: when the user
    // toggles Sentry OFF mid-session, dropping the event here stops EVERY event
    // immediately — including Sentry's own auto-captured crashes (uncaught
    // exceptions, native minidumps) that never pass through our helpers. Our
    // helpers' `active()` check alone wouldn't catch those.
    beforeSend: (event) => (runtimeEnabled ? scrubEvent(event) : null),
    // Drop noisy console breadcrumbs that could capture prompts/content. We add
    // our own 'artha.*' breadcrumbs explicitly where they're safe.
    beforeBreadcrumb: (crumb) =>
      (crumb.category ?? '').startsWith('artha.') ? crumb : null,
  });

  // Operational tags — non-PII signals the support workflow correlates against.
  Sentry.setTag('artha.ollama_connected', opts.ollamaConnected);
  Sentry.setTag('artha.mcp_server_count', opts.mcpServerCount);

  initialised = true;
  console.log('[Artha] Sentry initialised (opt-out telemetry, PII-scrubbed).');
}

/** Update the Ollama-reachability tag after the initial probe / on session
 *  start. No-op when Sentry isn't running. */
export function setOllamaConnectedTag(connected: boolean): void {
  if (!active()) return;
  Sentry.setTag('artha.ollama_connected', connected);
}

/** Update the MCP-server-count tag so errors can be correlated with how many
 *  MCP servers the user has configured. No-op when Sentry isn't running. */
export function setMcpServerCountTag(count: number): void {
  if (!active()) return;
  Sentry.setTag('artha.mcp_server_count', count);
}

/** Add a privacy-safe breadcrumb (category is forced into the 'artha.*'
 *  namespace so it survives `beforeBreadcrumb`/`beforeSend` filtering). Pass
 *  ONLY non-PII data — never message text, paths, or file contents. */
export function addBreadcrumb(category: string, message: string, data?: Record<string, number | string | boolean>): void {
  if (!active()) return;
  Sentry.addBreadcrumb({
    category: category.startsWith('artha.') ? category : `artha.${category}`,
    message,
    level: 'info',
    data,
  });
}

/** Capture a caught exception. No-op when Sentry is disabled. The message/stack
 *  is scrubbed by `beforeSend` before transmission. */
export function captureException(err: unknown): void {
  if (!active()) return;
  Sentry.captureException(err);
}

/** Run `fn` inside a performance span (transaction) so its duration + outcome
 *  are tracked even when it succeeds. Used to wrap SQLite migrations so a slow
 *  or failing migration shows up as a transaction, not just an error. When
 *  Sentry is disabled this simply runs `fn` directly. Re-throws on failure
 *  after marking the span errored + capturing the exception. */
export async function withTransaction<T>(
  name: string,
  op: string,
  fn: () => Promise<T> | T,
): Promise<T> {
  if (!active()) return fn();
  return Sentry.startSpan({ name, op }, async (span) => {
    try {
      const result = await fn();
      span?.setStatus?.({ code: 1 }); // ok
      return result;
    } catch (err) {
      span?.setStatus?.({ code: 2 }); // error
      Sentry.captureException(err);
      throw err;
    }
  });
}

/**
 * Send a Sentry "monitor check-in" (cron monitoring) for the daily health
 * check. Returns the check-in id for the in-progress call so the caller can
 * close it with an ok/error status. No-op (returns null) when Sentry is off.
 */
export function startCheckIn(monitorSlug: string): string | null {
  if (!active()) return null;
  try {
    return Sentry.captureCheckIn(
      { monitorSlug, status: 'in_progress' },
      {
        // Expected daily at 03:00 local; 60-min grace before "missed".
        schedule: { type: 'crontab', value: '0 3 * * *' },
        checkinMargin: 60,
        maxRuntime: 30,
      },
    );
  } catch {
    return null;
  }
}

/** Close a previously-opened check-in with its final status. No-op when Sentry
 *  is off or when `checkInId` is null (start was a no-op). */
export function finishCheckIn(monitorSlug: string, checkInId: string | null, status: 'ok' | 'error'): void {
  if (!active() || !checkInId) return;
  try {
    Sentry.captureCheckIn({ checkInId, monitorSlug, status });
  } catch {
    /* best-effort — a failed check-in must never break the health check */
  }
}
