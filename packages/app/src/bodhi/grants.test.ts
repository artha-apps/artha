/**
 * Standing-grant tests: matching per scope kind, expiry, revocation, subject
 * isolation and the explicit-tool-only rule used by the always-confirm floor.
 * Uses the in-memory store (same GrantStore contract as SQLite) plus a fake DB
 * for the SQLite store's SQL shape.
 */
import { describe, it, expect } from 'vitest';
import {
  InMemoryGrantStore, SqliteGrantStore, grantMatches, isGrantActive, pathInside, hostCovered,
  normaliseGrantInput, DEFAULT_GRANT_TTL_SECONDS, type Grant, type GrantDb,
} from './grants';

const NOW = 1_800_000_000;
const S = ['session:s1', 'project:p1', 'global'];

describe('isGrantActive', () => {
  it('active when not revoked and not expired', () => {
    expect(isGrantActive({ expires_at: null, revoke_gen: 0 }, NOW)).toBe(true);
    expect(isGrantActive({ expires_at: NOW + 1, revoke_gen: 0 }, NOW)).toBe(true);
  });
  it('expired at or before now never counts', () => {
    expect(isGrantActive({ expires_at: NOW, revoke_gen: 0 }, NOW)).toBe(false);
    expect(isGrantActive({ expires_at: NOW - 10, revoke_gen: 0 }, NOW)).toBe(false);
  });
  it('revoked never counts', () => {
    expect(isGrantActive({ expires_at: null, revoke_gen: 1 }, NOW)).toBe(false);
  });
});

describe('path / host helpers', () => {
  it('pathInside is segment-aware', () => {
    expect(pathInside('/a/b/c.txt', '/a/b')).toBe(true);
    expect(pathInside('/a/b', '/a/b/')).toBe(true);
    expect(pathInside('/a/bc/x', '/a/b')).toBe(false);
    expect(pathInside('/a/b/../../etc/passwd', '/a/b')).toBe(false);
  });
  it('hostCovered accepts subdomains only', () => {
    expect(hostCovered('docs.example.com', 'example.com')).toBe(true);
    expect(hostCovered('EXAMPLE.com', 'example.com')).toBe(true);
    expect(hostCovered('badexample.com', 'example.com')).toBe(false);
  });
});

describe('grantMatches', () => {
  const base = (over: Partial<Grant>): Grant => ({
    id: 'g', scope_kind: 'tool', scope_value: 'fs_delete_file', subject: 'global',
    created_at: NOW - 100, expires_at: NOW + 100, revoke_gen: 0, ...over,
  });

  it('tool grants match the exact tool name only', () => {
    expect(grantMatches(base({}), { toolName: 'fs_delete_file', subjects: S }, NOW)).toBe(true);
    expect(grantMatches(base({}), { toolName: 'fs_delete_folder', subjects: S }, NOW)).toBe(false);
  });

  it('a grant for another subject does not match', () => {
    expect(grantMatches(base({ subject: 'session:other' }), { toolName: 'fs_delete_file', subjects: S }, NOW)).toBe(false);
    expect(grantMatches(base({}), { toolName: 'fs_delete_file', subjects: [] }, NOW)).toBe(false);
  });

  it('an expired grant is ignored', () => {
    expect(grantMatches(base({ expires_at: NOW - 1 }), { toolName: 'fs_delete_file', subjects: S }, NOW)).toBe(false);
  });

  it('folder grants need every path inside the folder', () => {
    const g = base({ scope_kind: 'folder', scope_value: '/home/u/proj' });
    expect(grantMatches(g, { toolName: 'fs_delete_file', subjects: S, paths: ['/home/u/proj/a.txt'] }, NOW)).toBe(true);
    expect(grantMatches(g, { toolName: 'fs_move_file', subjects: S, paths: ['/home/u/proj/a', '/tmp/a'] }, NOW)).toBe(false);
    expect(grantMatches(g, { toolName: 'fs_delete_file', subjects: S, paths: [] }, NOW)).toBe(false);
  });

  it('host, app and connector grants', () => {
    expect(grantMatches(base({ scope_kind: 'host', scope_value: 'example.com' }),
      { toolName: 'browser_navigate', subjects: S, hosts: ['www.example.com'] }, NOW)).toBe(true);
    expect(grantMatches(base({ scope_kind: 'host', scope_value: 'example.com' }),
      { toolName: 'browser_navigate', subjects: S, hosts: [] }, NOW)).toBe(false);
    expect(grantMatches(base({ scope_kind: 'app', scope_value: 'Notes' }),
      { toolName: 'desktop_open_app', subjects: S, app: 'notes' }, NOW)).toBe(true);
    expect(grantMatches(base({ scope_kind: 'connector', scope_value: 'srv1' }),
      { toolName: 'x_tool', subjects: S, connector: 'srv1' }, NOW)).toBe(true);
    expect(grantMatches(base({ scope_kind: 'connector', scope_value: 'srv1' }),
      { toolName: 'x_tool', subjects: S, connector: 'srv2' }, NOW)).toBe(false);
  });

  it('explicitToolOnly accepts only an expiring tool grant naming the tool', () => {
    const q = { toolName: 'email_send', subjects: S, explicitToolOnly: true, connector: 'gmail', paths: ['/x'] };
    expect(grantMatches(base({ scope_value: 'email_send' }), q, NOW)).toBe(true);
    expect(grantMatches(base({ scope_value: 'email_send', expires_at: null }), q, NOW)).toBe(false);
    expect(grantMatches(base({ scope_kind: 'connector', scope_value: 'gmail' }), q, NOW)).toBe(false);
    expect(grantMatches(base({ scope_kind: 'folder', scope_value: '/' }), q, NOW)).toBe(false);
  });
});

describe('InMemoryGrantStore', () => {
  it('add → findActive → revoke → never matches again', () => {
    const st = new InMemoryGrantStore();
    const g = st.add({ scopeKind: 'tool', scopeValue: 'fs_delete_file', subject: 'global', ttlSeconds: DEFAULT_GRANT_TTL_SECONDS }, NOW);
    expect(g.expires_at).toBe(NOW + DEFAULT_GRANT_TTL_SECONDS);
    expect(st.findActive({ toolName: 'fs_delete_file', subjects: S }, NOW)?.id).toBe(g.id);
    expect(st.revoke(g.id)).toBe(true);
    expect(st.revoke(g.id)).toBe(false);
    expect(st.findActive({ toolName: 'fs_delete_file', subjects: S }, NOW)).toBeNull();
    expect(st.list()[0].revoke_gen).toBe(1); // kept for the audit trail
  });

  it('expired grants are ignored after their expiry', () => {
    const st = new InMemoryGrantStore();
    st.add({ scopeKind: 'tool', scopeValue: 'web_fetch', subject: 'global', ttlSeconds: 60 }, NOW);
    expect(st.findActive({ toolName: 'web_fetch', subjects: S }, NOW + 59)).not.toBeNull();
    expect(st.findActive({ toolName: 'web_fetch', subjects: S }, NOW + 60)).toBeNull();
  });
});

describe('normaliseGrantInput', () => {
  it('rejects bad kinds, empty values and malformed subjects', () => {
    expect(() => normaliseGrantInput({ scopeKind: 'nope' as never, scopeValue: 'x', subject: 'global' })).toThrow();
    expect(() => normaliseGrantInput({ scopeKind: 'tool', scopeValue: '  ', subject: 'global' })).toThrow();
    expect(() => normaliseGrantInput({ scopeKind: 'tool', scopeValue: 'x', subject: 'everyone' })).toThrow();
    expect(() => normaliseGrantInput({ scopeKind: 'tool', scopeValue: 'x', subject: 'session:' })).toThrow();
  });
});

describe('SqliteGrantStore', () => {
  /** Minimal fake DB that records SQL and returns canned rows. */
  function fakeDb(rows: Grant[]) {
    const sqls: string[] = [];
    const db: GrantDb = {
      prepare: (sql: string) => {
        sqls.push(sql);
        return { run: () => ({ changes: 1 }), get: () => undefined, all: () => rows };
      },
    };
    return { db, sqls };
  }

  it('pre-filters revoked/expired rows in SQL and re-checks in JS', () => {
    // The fake returns an expired row even though SQL would have filtered it —
    // the JS re-check must still reject it.
    const { db, sqls } = fakeDb([{ id: 'a', scope_kind: 'tool', scope_value: 'web_fetch', subject: 'global', created_at: NOW - 10, expires_at: NOW - 1, revoke_gen: 0 }]);
    const st = new SqliteGrantStore(() => db);
    expect(st.findActive({ toolName: 'web_fetch', subjects: S }, NOW)).toBeNull();
    expect(sqls[0]).toMatch(/revoke_gen = 0/);
    expect(sqls[0]).toMatch(/expires_at IS NULL OR expires_at > \?/);
  });

  it('fails closed (no grant) when the DB throws', () => {
    const st = new SqliteGrantStore(() => { throw new Error('db down'); });
    expect(st.findActive({ toolName: 'web_fetch', subjects: S }, NOW)).toBeNull();
  });
});
