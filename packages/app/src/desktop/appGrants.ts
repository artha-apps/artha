/**
 * Per-app grants for desktop control.
 *
 * Desktop control drives the user's REAL cursor and keyboard, so turning it on
 * in settings is not, by itself, permission to drive every app. Before any
 * desktop action Artha resolves the app it will act on and checks for a grant
 * for that app. No grant → the existing tool-approval modal asks:
 *   "Allow Artha to control {App}?  Once · Always for this project (30 days) · Deny"
 *
 * SWAPPABLE: this file is the only place that knows how grants are stored. The
 * orchestrator talks to the `AppGrantStore` interface, so a generic grants
 * store (covering other resource kinds) can replace `SqliteAppGrantStore`
 * later without touching the gate logic or its callers.
 */

/** How long an "Always for this project" grant lasts. */
export const ALWAYS_GRANT_TTL_SEC = 30 * 24 * 60 * 60;
/** How long a "Once" grant lasts: it covers the rest of this chat session's
 *  work in that app (asking before every single click would be unusable), but
 *  lapses quickly so it never quietly becomes a standing permission. */
export const ONCE_GRANT_TTL_SEC = 12 * 60 * 60;

/** One stored grant row (mirrors table `app_grants`). Times are unix seconds. */
export interface AppGrant {
  appId: string;
  subject: string;
  createdAt: number;
  expiresAt: number;
}

/** Storage contract for app grants. Implementations must ignore expired rows
 *  on read — an expired grant is the same as no grant. */
export interface AppGrantStore {
  /** The live (unexpired at `nowSec`) grant for app+subject, or null. */
  get(appId: string, subject: string, nowSec: number): AppGrant | null;
  /** Insert or replace the grant for app+subject. */
  put(grant: AppGrant): void;
  /** Remove the grant for app+subject (no-op if absent). */
  revoke(appId: string, subject: string): void;
}

/** Normalise an app name into a stable grant key ("Google Chrome.app" →
 *  "google chrome"), so the same app always maps to the same row. */
export function normalizeAppId(appName: string): string {
  return appName.trim().replace(/\.app$/i, '').replace(/\s+/g, ' ').toLowerCase();
}

/** Subject strings: who a grant is FOR. A session grant is the "Once" scope;
 *  a project grant is the "Always for this project" scope. */
export const sessionSubject = (sessionId: string): string => `session:${sessionId}`;
export const projectSubject = (projectId: string): string => `project:${projectId}`;

/**
 * Apps that ALWAYS ask, even when a grant exists: shells (arbitrary command
 * execution), system settings (security/privacy toggles), and credential
 * stores. A mistaken keystroke here can do outsized, hard-to-undo damage, so a
 * stored "Always" grant never pre-approves them and unattended runs never
 * touch them.
 */
const DEFAULT_DENY_PATTERNS: RegExp[] = [
  /^terminal$/,
  /^iterm2?$/,
  /^system (settings|preferences)$/,
  /^keychain access$/,
  /^passwords$/,
  // Common password managers, matched by distinctive name fragments.
  /1password/, /bitwarden/, /lastpass/, /dashlane/, /keepass/, /enpass/,
  /nordpass/, /roboform/, /proton pass/, /password/,
];

/** True when the app is on the always-confirm deny list. */
export function isAlwaysConfirmApp(appName: string): boolean {
  const id = normalizeAppId(appName);
  return DEFAULT_DENY_PATTERNS.some(re => re.test(id));
}

/** Desktop tools that act ON an app (move/click/type/launch) and therefore
 *  need a grant. Read-only tools (screenshot, find, get_active_window) don't. */
export const GRANT_GATED_DESKTOP_TOOLS = new Set([
  'desktop_click', 'desktop_type', 'desktop_key', 'desktop_move_mouse', 'desktop_open_app',
]);

/** Placeholder name used when the target app can't be resolved. It is never
 *  granted durably — an unknown target always asks (fail closed). */
export const UNKNOWN_APP = 'an unidentified app';

/** Inputs to the grant decision for one desktop action. */
export interface GrantCheckInput {
  /** Resolved target app display name, or null if it couldn't be resolved. */
  appName: string | null;
  sessionId: string;
  /** The chat session's project, if any — enables the "Always" scope. */
  projectId: string | null;
  /** No interactive user watching (scheduled task / LAN). */
  unattended: boolean;
  nowSec: number;
}

/** What the gate decided BEFORE asking anyone. */
export type GrantDecision =
  | { kind: 'allow'; appName: string; via: 'session' | 'project' }
  | { kind: 'confirm'; appName: string; alwaysAllowed: boolean; reason: 'unapproved' | 'always_confirm' | 'unknown_app' }
  | { kind: 'skip'; appName: string; reason: string };

/**
 * Decide whether a desktop action on the resolved app may run now, needs the
 * user's confirmation, or must be skipped (unattended with no grant).
 * Pure apart from `store.get` — easy to test with the in-memory store.
 */
export function checkAppGrant(store: AppGrantStore, input: GrantCheckInput): GrantDecision {
  const appName = input.appName?.trim() || null;
  if (!appName) {
    return input.unattended
      ? { kind: 'skip', appName: UNKNOWN_APP, reason: 'the target app could not be identified and no one is present to approve it' }
      : { kind: 'confirm', appName: UNKNOWN_APP, alwaysAllowed: false, reason: 'unknown_app' };
  }
  const appId = normalizeAppId(appName);

  // Deny-listed apps always ask; stored grants are deliberately ignored.
  if (isAlwaysConfirmApp(appName)) {
    return input.unattended
      ? { kind: 'skip', appName, reason: `${appName} always needs live confirmation and this run is unattended` }
      : { kind: 'confirm', appName, alwaysAllowed: false, reason: 'always_confirm' };
  }

  if (store.get(appId, sessionSubject(input.sessionId), input.nowSec)) {
    return { kind: 'allow', appName, via: 'session' };
  }
  if (input.projectId && store.get(appId, projectSubject(input.projectId), input.nowSec)) {
    return { kind: 'allow', appName, via: 'project' };
  }

  return input.unattended
    ? { kind: 'skip', appName, reason: `${appName} is not approved for desktop control and this run is unattended` }
    : { kind: 'confirm', appName, alwaysAllowed: !!input.projectId, reason: 'unapproved' };
}

/** The user's answer to the "Allow Artha to control {App}?" prompt. */
export type GrantAnswer = 'once' | 'always' | 'deny';

/**
 * Persist the user's answer. "Once" → a short session-scoped grant; "Always"
 * → a 30-day project grant (falls back to session scope when there's no
 * project). Deny-listed and unknown apps are never stored, so the next action
 * asks again. Returns true when the action may proceed.
 */
export function applyGrantAnswer(
  store: AppGrantStore,
  answer: GrantAnswer,
  ctx: { appName: string; sessionId: string; projectId: string | null; nowSec: number },
): boolean {
  if (answer === 'deny') return false;
  if (ctx.appName === UNKNOWN_APP || isAlwaysConfirmApp(ctx.appName)) return true; // allowed this one time only
  const appId = normalizeAppId(ctx.appName);
  if (answer === 'always' && ctx.projectId) {
    store.put({ appId, subject: projectSubject(ctx.projectId), createdAt: ctx.nowSec, expiresAt: ctx.nowSec + ALWAYS_GRANT_TTL_SEC });
  } else {
    store.put({ appId, subject: sessionSubject(ctx.sessionId), createdAt: ctx.nowSec, expiresAt: ctx.nowSec + ONCE_GRANT_TTL_SEC });
  }
  return true;
}

// ── Implementations ──────────────────────────────────────────────────────────

/** In-memory store — used by tests and as a fallback when SQLite is absent. */
export class InMemoryAppGrantStore implements AppGrantStore {
  private rows = new Map<string, AppGrant>();
  private key(appId: string, subject: string): string { return `${appId}\u0000${subject}`; }
  get(appId: string, subject: string, nowSec: number): AppGrant | null {
    const g = this.rows.get(this.key(appId, subject));
    return g && g.expiresAt > nowSec ? g : null;
  }
  put(grant: AppGrant): void { this.rows.set(this.key(grant.appId, grant.subject), { ...grant }); }
  revoke(appId: string, subject: string): void { this.rows.delete(this.key(appId, subject)); }
}

/** The minimal slice of better-sqlite3 this store needs — keeps it testable
 *  and decoupled from the concrete driver. */
export interface SqlLike {
  prepare(sql: string): {
    get(...params: unknown[]): unknown;
    run(...params: unknown[]): unknown;
  };
}

/** SQLite-backed store over table `app_grants` (see db/schema.ts). */
export class SqliteAppGrantStore implements AppGrantStore {
  constructor(private readonly db: () => SqlLike) {}
  get(appId: string, subject: string, nowSec: number): AppGrant | null {
    const r = this.db().prepare(
      `SELECT app_id, subject, created_at, expires_at FROM app_grants WHERE app_id=? AND subject=? AND expires_at > ?`,
    ).get(appId, subject, nowSec) as { app_id: string; subject: string; created_at: number; expires_at: number } | undefined;
    return r ? { appId: r.app_id, subject: r.subject, createdAt: r.created_at, expiresAt: r.expires_at } : null;
  }
  put(grant: AppGrant): void {
    this.db().prepare(
      `INSERT OR REPLACE INTO app_grants (app_id, subject, created_at, expires_at) VALUES (?,?,?,?)`,
    ).run(grant.appId, grant.subject, grant.createdAt, grant.expiresAt);
  }
  revoke(appId: string, subject: string): void {
    this.db().prepare(`DELETE FROM app_grants WHERE app_id=? AND subject=?`).run(appId, subject);
  }
}
