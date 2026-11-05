/**
 * Bodhi — Standing grants (expiring "always allow" permissions).
 *
 * When the user answers an approval prompt with "Always allow (30 days)", Artha
 * records a grant instead of asking again for the same thing. A grant binds a
 * SCOPE (what is allowed) to a SUBJECT (where it applies):
 *
 *   scope_kind   scope_value                 matches a call when…
 *   ──────────   ─────────────────────────   ─────────────────────────────────
 *   tool         exact tool name             the call's tool name is identical
 *   host         hostname (e.g. example.com)  every URL host in the call is that
 *                                             host or a subdomain of it
 *   folder       absolute folder path         every path argument is inside it
 *   app          desktop app name             the call opens/targets that app
 *   connector    MCP server id                the tool belongs to that server
 *
 *   subject = session:<id> | project:<id> | schedule:<id> | global
 *
 * Safety properties (enforced here, unit-tested in grants.test.ts):
 *   - An expired grant (expires_at <= now) NEVER matches.
 *   - A revoked grant (revoke_gen > 0) NEVER matches. revokeGrant bumps the
 *     generation instead of deleting, so the list keeps an audit trail.
 *   - Path / host scopes require EVERY path / host in the call to be covered —
 *     a call that reaches one covered folder and one uncovered one is not
 *     granted. A call with no paths/hosts never matches a folder/host grant.
 *   - Grants only ever turn an "ask" into "run". They cannot override a
 *     `forbid` policy or a mode-level block (see agent/modes.ts for the order),
 *     and the always-confirm floor accepts only an explicit `tool` grant that
 *     names the tool and carries an expiry.
 *
 * Storage is the additive `grants` table (db/schema.ts). The logic is written
 * against the `GrantStore` interface so it can be tested without SQLite.
 */
import * as path from 'path';
import { getDb } from '../db/schema';

/** What kind of thing a grant covers. Mirrors the table's CHECK constraint. */
export type GrantScopeKind = 'tool' | 'host' | 'folder' | 'app' | 'connector';

/** All valid scope kinds, for input validation at the IPC boundary. */
export const GRANT_SCOPE_KINDS: readonly GrantScopeKind[] = ['tool', 'host', 'folder', 'app', 'connector'];

/** Default lifetime of an "Always allow" answer from the approval modal. */
export const DEFAULT_GRANT_TTL_SECONDS = 30 * 24 * 60 * 60;

/** A row of the `grants` table. Times are unix seconds (like the rest of the schema). */
export interface Grant {
  id: string;
  scope_kind: GrantScopeKind;
  scope_value: string;
  /** session:<id> | project:<id> | schedule:<id> | global */
  subject: string;
  created_at: number;
  /** null = never expires. */
  expires_at: number | null;
  /** 0 = active; >0 = revoked (bumped by revokeGrant). */
  revoke_gen: number;
}

/** Input for creating a grant. `ttlSeconds` wins over `expiresAt` when both are given. */
export interface GrantInput {
  scopeKind: GrantScopeKind;
  scopeValue: string;
  subject: string;
  /** Absolute expiry in unix seconds, or null for no expiry. */
  expiresAt?: number | null;
  /** Relative expiry from now, in seconds. */
  ttlSeconds?: number;
}

/** Everything about one tool call that a grant could match against. */
export interface GrantQuery {
  toolName: string;
  /** Subjects that apply to this run, e.g. ['session:abc', 'project:p1', 'global']. */
  subjects: string[];
  /** Filesystem paths the call touches (already extracted from its args). */
  paths?: string[];
  /** URL hosts the call reaches. */
  hosts?: string[];
  /** Desktop app the call targets, if any. */
  app?: string;
  /** MCP server id that owns the tool, if any. */
  connector?: string;
  /** When true only an explicit `tool` grant naming `toolName` with an expiry
   *  counts — used for the always-confirm floor (email_send). */
  explicitToolOnly?: boolean;
}

/** Storage-agnostic grant operations. The SQLite implementation is
 *  `SqliteGrantStore`; tests use `InMemoryGrantStore`. */
export interface GrantStore {
  add(input: GrantInput, now?: number): Grant;
  /** The first active grant matching the query, or null. Never throws. */
  findActive(query: GrantQuery, now?: number): Grant | null;
  /** Revoke by id. Returns true when an active grant was revoked. */
  revoke(id: string): boolean;
  /** All grants (active, expired and revoked), newest first. */
  list(): Grant[];
}

/** Current time in unix seconds. */
export function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/** True when a grant is neither revoked nor expired at `now`. */
export function isGrantActive(g: Pick<Grant, 'expires_at' | 'revoke_gen'>, now: number = nowSeconds()): boolean {
  if (g.revoke_gen > 0) return false;
  if (g.expires_at !== null && g.expires_at !== undefined && g.expires_at <= now) return false;
  return true;
}

/** Normalise a folder/file path for prefix comparison (resolved, no trailing slash). */
function normPath(p: string): string {
  const r = path.resolve(p);
  return r.length > 1 ? r.replace(/[\\/]+$/, '') : r;
}

/** True when `p` is `root` or inside it (segment-aware: /a/bc is not inside /a/b). */
export function pathInside(p: string, root: string): boolean {
  const np = normPath(p);
  const nr = normPath(root);
  return np === nr || np.startsWith(nr.endsWith(path.sep) ? nr : nr + path.sep);
}

/** True when `host` equals `grantHost` or is a subdomain of it (case-insensitive). */
export function hostCovered(host: string, grantHost: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, '');
  const g = grantHost.toLowerCase().replace(/\.$/, '');
  if (!h || !g) return false;
  return h === g || h.endsWith('.' + g);
}

/** Pure matcher: does an ACTIVE grant `g` cover this call? Expired/revoked
 *  grants and grants for another subject never match. */
export function grantMatches(g: Grant, q: GrantQuery, now: number = nowSeconds()): boolean {
  if (!isGrantActive(g, now)) return false;
  if (!q.subjects.includes(g.subject)) return false;
  if (q.explicitToolOnly) {
    // Floor tools: only an explicit, expiring grant naming exactly this tool.
    return g.scope_kind === 'tool' && g.scope_value === q.toolName && g.expires_at !== null;
  }
  switch (g.scope_kind) {
    case 'tool':
      return g.scope_value === q.toolName;
    case 'folder': {
      const paths = q.paths ?? [];
      return paths.length > 0 && paths.every(p => pathInside(p, g.scope_value));
    }
    case 'host': {
      const hosts = q.hosts ?? [];
      return hosts.length > 0 && hosts.every(h => hostCovered(h, g.scope_value));
    }
    case 'app':
      return !!q.app && q.app.trim().toLowerCase() === g.scope_value.trim().toLowerCase();
    case 'connector':
      return !!q.connector && q.connector === g.scope_value;
    default:
      return false; // unknown kind — fail closed
  }
}

/** Validate + normalise a GrantInput into the stored fields. Throws on bad input
 *  (bad kind, empty value, malformed subject) so the IPC layer rejects it. */
export function normaliseGrantInput(input: GrantInput, now: number = nowSeconds()): Omit<Grant, 'id' | 'revoke_gen'> {
  if (!GRANT_SCOPE_KINDS.includes(input.scopeKind)) throw new Error(`Invalid grant scope kind: ${String(input.scopeKind)}`);
  const value = String(input.scopeValue ?? '').trim();
  if (!value) throw new Error('Grant scope value is required.');
  const subject = String(input.subject ?? '').trim();
  if (!/^(global|(session|project|schedule):.+)$/.test(subject)) throw new Error(`Invalid grant subject: ${subject}`);
  let expires: number | null = null;
  if (typeof input.ttlSeconds === 'number' && input.ttlSeconds > 0) expires = now + Math.floor(input.ttlSeconds);
  else if (typeof input.expiresAt === 'number') expires = Math.floor(input.expiresAt);
  return {
    scope_kind: input.scopeKind,
    scope_value: input.scopeKind === 'folder' ? normPath(value) : value,
    subject,
    created_at: now,
    expires_at: expires,
  };
}

/** In-memory store — used by tests and as a safe fallback. */
export class InMemoryGrantStore implements GrantStore {
  private rows: Grant[] = [];
  private seq = 0;

  add(input: GrantInput, now: number = nowSeconds()): Grant {
    const g: Grant = { id: `g${++this.seq}`, revoke_gen: 0, ...normaliseGrantInput(input, now) };
    this.rows.push(g);
    return { ...g };
  }

  findActive(query: GrantQuery, now: number = nowSeconds()): Grant | null {
    const hit = this.rows.find(g => grantMatches(g, query, now));
    return hit ? { ...hit } : null;
  }

  revoke(id: string): boolean {
    const g = this.rows.find(r => r.id === id);
    if (!g || g.revoke_gen > 0) return false;
    g.revoke_gen += 1;
    return true;
  }

  list(): Grant[] {
    return [...this.rows].sort((a, b) => b.created_at - a.created_at).map(g => ({ ...g }));
  }
}

/** The minimal slice of better-sqlite3 the SQLite store needs (keeps it testable). */
export interface GrantDb {
  prepare(sql: string): {
    run(...args: unknown[]): unknown;
    get(...args: unknown[]): unknown;
    all(...args: unknown[]): unknown[];
  };
}

/** SQLite-backed store over the `grants` table. */
export class SqliteGrantStore implements GrantStore {
  constructor(private readonly db: () => GrantDb) {}

  add(input: GrantInput, now: number = nowSeconds()): Grant {
    const n = normaliseGrantInput(input, now);
    const id = `${now.toString(36)}${Math.random().toString(36).slice(2, 10)}`;
    this.db().prepare(
      `INSERT INTO grants (id, scope_kind, scope_value, subject, created_at, expires_at, revoke_gen)
       VALUES (?, ?, ?, ?, ?, ?, 0)`,
    ).run(id, n.scope_kind, n.scope_value, n.subject, n.created_at, n.expires_at);
    return { id, revoke_gen: 0, ...n };
  }

  findActive(query: GrantQuery, now: number = nowSeconds()): Grant | null {
    try {
      if (!query.subjects.length) return null;
      const marks = query.subjects.map(() => '?').join(',');
      // SQL pre-filters revoked/expired rows; grantMatches re-checks everything.
      const rows = this.db().prepare(
        `SELECT * FROM grants
          WHERE revoke_gen = 0 AND (expires_at IS NULL OR expires_at > ?)
            AND subject IN (${marks})
          ORDER BY created_at DESC`,
      ).all(now, ...query.subjects) as Grant[];
      return rows.find(g => grantMatches(g, query, now)) ?? null;
    } catch {
      return null; // a DB hiccup means "no grant" — i.e. ask (fail closed)
    }
  }

  revoke(id: string): boolean {
    const info = this.db().prepare(
      `UPDATE grants SET revoke_gen = revoke_gen + 1 WHERE id = ? AND revoke_gen = 0`,
    ).run(id) as { changes?: number };
    return (info?.changes ?? 0) > 0;
  }

  list(): Grant[] {
    return this.db().prepare(`SELECT * FROM grants ORDER BY created_at DESC`).all() as Grant[];
  }
}

// ── Default (app) store + function API ─────────────────────────────────────

let defaultStore: GrantStore | null = null;

/** The app's grant store (SQLite via getDb). */
export function getGrantStore(): GrantStore {
  if (!defaultStore) {
    // getDb is called per operation (not here), so creating the store never
    // touches the database before initDatabase() has run.
    defaultStore = new SqliteGrantStore(() => getDb() as unknown as GrantDb);
  }
  return defaultStore;
}

/** Swap the default store (tests). Pass null to reset. */
export function setGrantStore(store: GrantStore | null): void {
  defaultStore = store;
}

/** Create a grant in the default store. */
export function addGrant(input: GrantInput): Grant {
  return getGrantStore().add(input);
}

/** First active grant matching the query in the default store, or null. */
export function findActiveGrant(query: GrantQuery): Grant | null {
  return getGrantStore().findActive(query);
}

/** Revoke a grant in the default store. */
export function revokeGrant(id: string): boolean {
  return getGrantStore().revoke(id);
}

/** List grants in the default store, annotated with whether each is active now. */
export function listGrants(): Array<Grant & { active: boolean }> {
  const now = nowSeconds();
  return getGrantStore().list().map(g => ({ ...g, active: isGrantActive(g, now) }));
}
