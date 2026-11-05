/**
 * Tests for per-app desktop-control grants: decision logic, expiry, the
 * always-confirm deny list, unattended skipping and the SQLite store's SQL.
 */
import { describe, it, expect } from 'vitest';
import {
  InMemoryAppGrantStore, SqliteAppGrantStore, checkAppGrant, applyGrantAnswer,
  isAlwaysConfirmApp, normalizeAppId, sessionSubject, projectSubject,
  ALWAYS_GRANT_TTL_SEC, UNKNOWN_APP, type SqlLike,
} from './appGrants';

const NOW = 1_800_000_000;
const base = { sessionId: 's1', projectId: 'p1', unattended: false, nowSec: NOW };

describe('checkAppGrant', () => {
  it('asks for confirmation when the app is unapproved', () => {
    const d = checkAppGrant(new InMemoryAppGrantStore(), { ...base, appName: 'Notes' });
    expect(d).toEqual({ kind: 'confirm', appName: 'Notes', alwaysAllowed: true, reason: 'unapproved' });
  });

  it('allows an app with a live session or project grant', () => {
    const store = new InMemoryAppGrantStore();
    store.put({ appId: 'notes', subject: sessionSubject('s1'), createdAt: NOW, expiresAt: NOW + 60 });
    expect(checkAppGrant(store, { ...base, appName: 'Notes' }).kind).toBe('allow');
    const store2 = new InMemoryAppGrantStore();
    store2.put({ appId: 'notes', subject: projectSubject('p1'), createdAt: NOW, expiresAt: NOW + 60 });
    expect(checkAppGrant(store2, { ...base, appName: 'Notes.app' })).toMatchObject({ kind: 'allow', via: 'project' });
  });

  it('ignores an expired grant', () => {
    const store = new InMemoryAppGrantStore();
    store.put({ appId: 'notes', subject: projectSubject('p1'), createdAt: NOW - 100, expiresAt: NOW - 1 });
    expect(checkAppGrant(store, { ...base, appName: 'Notes' }).kind).toBe('confirm');
  });

  it('a grant for another project or session does not apply', () => {
    const store = new InMemoryAppGrantStore();
    store.put({ appId: 'notes', subject: projectSubject('other'), createdAt: NOW, expiresAt: NOW + 60 });
    store.put({ appId: 'notes', subject: sessionSubject('s2'), createdAt: NOW, expiresAt: NOW + 60 });
    expect(checkAppGrant(store, { ...base, appName: 'Notes' }).kind).toBe('confirm');
  });

  it('unattended + unapproved → skipped, never confirm', () => {
    const d = checkAppGrant(new InMemoryAppGrantStore(), { ...base, unattended: true, appName: 'Notes' });
    expect(d.kind).toBe('skip');
  });

  it('deny-listed apps always ask, even with a live grant', () => {
    const store = new InMemoryAppGrantStore();
    for (const app of ['Terminal', 'iTerm', 'iTerm2', 'System Settings', 'Keychain Access', '1Password 7', 'Bitwarden']) {
      store.put({ appId: normalizeAppId(app), subject: sessionSubject('s1'), createdAt: NOW, expiresAt: NOW + 999 });
      store.put({ appId: normalizeAppId(app), subject: projectSubject('p1'), createdAt: NOW, expiresAt: NOW + 999 });
      const d = checkAppGrant(store, { ...base, appName: app });
      expect(d).toMatchObject({ kind: 'confirm', reason: 'always_confirm', alwaysAllowed: false });
    }
  });

  it('deny-listed apps are skipped when unattended, even with a grant', () => {
    const store = new InMemoryAppGrantStore();
    store.put({ appId: 'terminal', subject: projectSubject('p1'), createdAt: NOW, expiresAt: NOW + 999 });
    expect(checkAppGrant(store, { ...base, unattended: true, appName: 'Terminal' }).kind).toBe('skip');
  });

  it('an unresolved app asks (attended) or skips (unattended)', () => {
    const store = new InMemoryAppGrantStore();
    expect(checkAppGrant(store, { ...base, appName: null })).toMatchObject({ kind: 'confirm', reason: 'unknown_app' });
    expect(checkAppGrant(store, { ...base, appName: null, unattended: true }).kind).toBe('skip');
  });

  it('"Always" is not offered without a project', () => {
    const d = checkAppGrant(new InMemoryAppGrantStore(), { ...base, projectId: null, appName: 'Notes' });
    expect(d).toMatchObject({ kind: 'confirm', alwaysAllowed: false });
  });
});

describe('isAlwaysConfirmApp', () => {
  it('matches shells, settings and credential stores but not ordinary apps', () => {
    expect(isAlwaysConfirmApp('Terminal')).toBe(true);
    expect(isAlwaysConfirmApp('System Preferences')).toBe(true);
    expect(isAlwaysConfirmApp('Passwords')).toBe(true);
    expect(isAlwaysConfirmApp('LastPass')).toBe(true);
    expect(isAlwaysConfirmApp('Notes')).toBe(false);
    expect(isAlwaysConfirmApp('Safari')).toBe(false);
  });
});

describe('applyGrantAnswer', () => {
  const ctx = { appName: 'Notes', sessionId: 's1', projectId: 'p1', nowSec: NOW };

  it('deny stores nothing and refuses', () => {
    const store = new InMemoryAppGrantStore();
    expect(applyGrantAnswer(store, 'deny', ctx)).toBe(false);
    expect(checkAppGrant(store, { ...base, appName: 'Notes' }).kind).toBe('confirm');
  });

  it('always stores a 30-day project grant', () => {
    const store = new InMemoryAppGrantStore();
    expect(applyGrantAnswer(store, 'always', ctx)).toBe(true);
    const g = store.get('notes', projectSubject('p1'), NOW);
    expect(g?.expiresAt).toBe(NOW + ALWAYS_GRANT_TTL_SEC);
    expect(store.get('notes', projectSubject('p1'), NOW + ALWAYS_GRANT_TTL_SEC + 1)).toBeNull();
  });

  it('once stores only a session grant', () => {
    const store = new InMemoryAppGrantStore();
    applyGrantAnswer(store, 'once', ctx);
    expect(store.get('notes', sessionSubject('s1'), NOW)).not.toBeNull();
    expect(store.get('notes', projectSubject('p1'), NOW)).toBeNull();
  });

  it('never persists a grant for a deny-listed or unknown app', () => {
    const store = new InMemoryAppGrantStore();
    expect(applyGrantAnswer(store, 'always', { ...ctx, appName: 'Terminal' })).toBe(true);
    expect(applyGrantAnswer(store, 'once', { ...ctx, appName: UNKNOWN_APP })).toBe(true);
    expect(store.get('terminal', projectSubject('p1'), NOW)).toBeNull();
    expect(store.get('terminal', sessionSubject('s1'), NOW)).toBeNull();
  });
});

describe('SqliteAppGrantStore', () => {
  it('filters expired rows in SQL and upserts', () => {
    const calls: { sql: string; params: unknown[] }[] = [];
    const fake: SqlLike = {
      prepare: (sql: string) => ({
        get: (...params: unknown[]) => { calls.push({ sql, params }); return undefined; },
        run: (...params: unknown[]) => { calls.push({ sql, params }); return {}; },
      }),
    };
    const store = new SqliteAppGrantStore(() => fake);
    expect(store.get('notes', 'project:p1', NOW)).toBeNull();
    store.put({ appId: 'notes', subject: 'project:p1', createdAt: NOW, expiresAt: NOW + 5 });
    expect(calls[0].sql).toMatch(/expires_at > \?/);
    expect(calls[0].params).toEqual(['notes', 'project:p1', NOW]);
    expect(calls[1].sql).toMatch(/INSERT OR REPLACE INTO app_grants/);
  });
});
