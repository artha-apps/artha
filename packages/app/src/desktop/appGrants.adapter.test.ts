/**
 * The desktop per-app grant gate running on the generic grant store
 * (bodhi/grants.ts) through GrantStoreAppGrantAdapter.
 */
import { describe, it, expect } from 'vitest';
import { InMemoryGrantStore, grantMatches } from '../bodhi/grants';
import {
  GrantStoreAppGrantAdapter, checkAppGrant, sessionSubject, projectSubject, DESKTOP_APP_GRANT_PREFIX,
} from './appGrants';

const NOW = 1_800_000_000;
const base = { sessionId: 's1', projectId: 'p1', unattended: false, nowSec: NOW };

describe('GrantStoreAppGrantAdapter', () => {
  it('stores app grants in the generic store and the gate honours them', () => {
    const generic = new InMemoryGrantStore();
    const store = new GrantStoreAppGrantAdapter(() => generic);
    expect(checkAppGrant(store, { ...base, appName: 'Notes' }).kind).toBe('confirm');
    store.put({ appId: 'notes', subject: projectSubject('p1'), createdAt: NOW, expiresAt: NOW + 60 });
    expect(checkAppGrant(store, { ...base, appName: 'Notes.app' })).toMatchObject({ kind: 'allow', via: 'project' });
    const rows = generic.list();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ scope_kind: 'app', scope_value: `${DESKTOP_APP_GRANT_PREFIX}notes`, subject: 'project:p1' });
  });

  it('ignores expired grants and grants revoked in the generic store', () => {
    const generic = new InMemoryGrantStore();
    const store = new GrantStoreAppGrantAdapter(() => generic);
    store.put({ appId: 'notes', subject: sessionSubject('s1'), createdAt: NOW - 100, expiresAt: NOW - 1 });
    expect(checkAppGrant(store, { ...base, appName: 'Notes' }).kind).toBe('confirm');
    store.put({ appId: 'notes', subject: sessionSubject('s1'), createdAt: NOW, expiresAt: NOW + 60 });
    expect(checkAppGrant(store, { ...base, appName: 'Notes' }).kind).toBe('allow');
    const live = generic.list().find(g => g.revoke_gen === 0 && (g.expires_at ?? 0) > NOW)!;
    generic.revoke(live.id); // e.g. Settings → Grants → Revoke
    expect(checkAppGrant(store, { ...base, appName: 'Notes' }).kind).toBe('confirm');
  });

  it('put replaces the live grant; revoke removes it', () => {
    const generic = new InMemoryGrantStore();
    const store = new GrantStoreAppGrantAdapter(() => generic);
    store.put({ appId: 'notes', subject: sessionSubject('s1'), createdAt: NOW, expiresAt: NOW + 60 });
    store.put({ appId: 'notes', subject: sessionSubject('s1'), createdAt: NOW, expiresAt: NOW + 120 });
    expect(generic.list().filter(g => g.revoke_gen === 0)).toHaveLength(1);
    expect(store.get('notes', sessionSubject('s1'), NOW)?.expiresAt).toBe(NOW + 120);
    store.revoke('notes', sessionSubject('s1'), NOW);
    expect(store.get('notes', sessionSubject('s1'), NOW)).toBeNull();
  });

  it('a desktop-control grant never satisfies a permission-mode app query', () => {
    const generic = new InMemoryGrantStore();
    new GrantStoreAppGrantAdapter(() => generic)
      .put({ appId: 'notes', subject: 'global', createdAt: NOW, expiresAt: NOW + 60 });
    const g = generic.list()[0];
    expect(grantMatches(g, { toolName: 'desktop_open_app', subjects: ['global'], app: 'Notes' }, NOW)).toBe(false);
    expect(grantMatches(g, { toolName: 'desktop_open_app', subjects: ['global'], app: 'notes' }, NOW)).toBe(false);
  });
});
