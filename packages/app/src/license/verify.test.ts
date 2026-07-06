/**
 * Verification tests — mint an Ed25519 keypair in-process, sign payloads with
 * the private half, and verify them with the public half passed in via
 * `opts.publicKeyPem`. This keeps the test self-contained: no fixtures, no
 * touching the real public-key.ts, no environment setup.
 */

import { describe, expect, it } from 'vitest';
import {
  generateKeyPairSync,
  sign as cryptoSign,
} from 'crypto';

import { computeEntitlements, parseAndVerify, invalidateEntitlements, getEntitlements } from './verify';
import { FREE_ENTITLEMENTS, entitlementsFor } from './entitlements';

function b64url(buf: Buffer): string {
  return buf.toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}

/** Generate a single keypair shared across the test cases. */
const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const PUB_PEM = publicKey.export({ type: 'spki', format: 'pem' }) as string;

interface Payload {
  id: string; org: string; tier: 'free' | 'pro' | 'team' | 'enterprise';
  seats: number; iat: number; exp: number;
}

function mint(payload: Payload, key = privateKey): string {
  const bytes = Buffer.from(JSON.stringify(payload), 'utf8');
  const sig = cryptoSign(null, bytes, key);
  return `${b64url(bytes)}.${b64url(sig)}`;
}

const now = 1_700_000_000;
const goodPayload: Payload = {
  id: 'lic-acme-1',
  org: 'Acme',
  tier: 'enterprise',
  seats: 250,
  iat: now - 1000,
  exp: now + 86_400 * 30,
};

describe('parseAndVerify', () => {
  it('accepts a valid signed token', () => {
    const token = mint(goodPayload);
    const result = parseAndVerify(token, { now, publicKeyPem: PUB_PEM });
    expect(result).not.toBeNull();
    expect(result?.tier).toBe('enterprise');
    expect(result?.seats).toBe(250);
    expect(result?.org).toBe('Acme');
  });

  it('rejects a revoked token even though signature + expiry are valid', () => {
    const token = mint(goodPayload);
    const revokedIds = new Set([goodPayload.id]);
    // Sanity: same token verifies when not revoked.
    expect(parseAndVerify(token, { now, publicKeyPem: PUB_PEM })).not.toBeNull();
    // Revoked → null, so the caller falls back to FREE_ENTITLEMENTS.
    expect(parseAndVerify(token, { now, publicKeyPem: PUB_PEM, revokedIds })).toBeNull();
  });

  it('rejects a tampered payload (signature no longer matches)', () => {
    const token = mint(goodPayload);
    const [head, sig] = token.split('.');
    // Decode, mutate seats, re-encode without resigning.
    const json = JSON.parse(Buffer.from(head.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
    json.seats = 10_000;
    const mutated = b64url(Buffer.from(JSON.stringify(json), 'utf8'));
    expect(parseAndVerify(`${mutated}.${sig}`, { now, publicKeyPem: PUB_PEM })).toBeNull();
  });

  it('rejects an expired token', () => {
    const expired = mint({ ...goodPayload, exp: now - 1 });
    expect(parseAndVerify(expired, { now, publicKeyPem: PUB_PEM })).toBeNull();
  });

  it('rejects a token signed by a different key', () => {
    const other = generateKeyPairSync('ed25519');
    const token = mint(goodPayload, other.privateKey);
    expect(parseAndVerify(token, { now, publicKeyPem: PUB_PEM })).toBeNull();
  });

  it('rejects garbage input without throwing', () => {
    expect(parseAndVerify('', { now, publicKeyPem: PUB_PEM })).toBeNull();
    expect(parseAndVerify('not-a-token', { now, publicKeyPem: PUB_PEM })).toBeNull();
    expect(parseAndVerify('a.b', { now, publicKeyPem: PUB_PEM })).toBeNull();
  });

  it('rejects payloads with an out-of-range tier or seats', () => {
    expect(parseAndVerify(mint({ ...goodPayload, tier: 'platinum' as Payload['tier'] }), { now, publicKeyPem: PUB_PEM })).toBeNull();
    expect(parseAndVerify(mint({ ...goodPayload, seats: 0 }), { now, publicKeyPem: PUB_PEM })).toBeNull();
  });
});

describe('computeEntitlements', () => {
  it('returns FREE when no key is given', () => {
    invalidateEntitlements();
    const ents = computeEntitlements(null);
    expect(ents).toEqual(FREE_ENTITLEMENTS);
  });

  it('returns FREE when key is invalid (so a bad license is non-blocking)', () => {
    // Real public key won't match the placeholder shipped in public-key.ts,
    // so any non-test caller will fall back to free — exercised indirectly here
    // by passing a syntactically-valid token signed with the wrong key.
    const other = generateKeyPairSync('ed25519');
    expect(computeEntitlements(mint(goodPayload, other.privateKey))).toEqual(FREE_ENTITLEMENTS);
  });
});

describe('tier restructure (free/pro=Personal/team/enterprise=Business)', () => {
  it('accepts a team-tier token and grants LAN + shared features', () => {
    const token = mint({ ...goodPayload, tier: 'team', seats: 5 });
    const p = parseAndVerify(token, { now, publicKeyPem: PUB_PEM });
    expect(p?.tier).toBe('team');
    const ents = entitlementsFor('team', 5, 'Acme', now + 86_400 * 365);
    expect(ents.lanServer).toBe(true);
    expect(ents.sharedMemory).toBe(true);
    expect(ents.sharedPacks).toBe(true);
    expect(ents.orgHub).toBe(false);
    expect(ents.rbac).toBe(false);
    expect(ents.docsPerMonth).toBeNull();
    expect(ents.scheduler).toBe(true);
  });

  it('pro (Personal) is a full solo tier with NO team flags', () => {
    const ents = entitlementsFor('pro', 1, 'someone@x.com', null);
    expect(ents.lanServer).toBe(false);
    expect(ents.sharedMemory).toBe(false);
    expect(ents.sharedPacks).toBe(false);
    // …but nothing solo is capped.
    expect(ents.docsPerMonth).toBeNull();
    expect(ents.scheduler).toBe(true);
    expect(ents.maxContextPacks).toBeNull();
    expect(ents.skillTemplates).toBe(true);
  });

  it('free is capped: 5 docs/month, no scheduler, 1 pack, no templates', () => {
    expect(FREE_ENTITLEMENTS.docsPerMonth).toBe(5);
    expect(FREE_ENTITLEMENTS.scheduler).toBe(false);
    expect(FREE_ENTITLEMENTS.maxContextPacks).toBe(1);
    expect(FREE_ENTITLEMENTS.skillTemplates).toBe(false);
    expect(FREE_ENTITLEMENTS.lanServer).toBe(false);
  });

  it('enterprise (Business) gets everything', () => {
    const ents = entitlementsFor('enterprise', 25, 'BigCo', now + 86_400 * 365);
    expect(ents.lanServer).toBe(true);
    expect(ents.sharedPacks).toBe(true);
    expect(ents.orgHub).toBe(true);
    expect(ents.rbac).toBe(true);
    expect(ents.auditExport).toBe(true);
  });
});

describe('getEntitlements cache expiry', () => {
  it('an expired key lapses to FREE on the next CALL, not the next restart', () => {
    invalidateEntitlements();
    const key = mint({ ...goodPayload, tier: 'team', seats: 5, exp: now + 3600 });

    // t0: key valid → Team entitlements, cached.
    const t0 = getEntitlements(() => key, { now, publicKeyPem: PUB_PEM });
    expect(t0.tier).toBe('team');
    expect(t0.lanServer).toBe(true);

    // t0+10s: cache hit, still valid.
    const t1 = getEntitlements(() => key, { now: now + 10, publicKeyPem: PUB_PEM });
    expect(t1.tier).toBe('team');

    // t0+2h: SAME key, cache still holds Team — the expiry re-check must
    // reject the hit and recompute, which falls back to FREE.
    const t2 = getEntitlements(() => key, { now: now + 7200, publicKeyPem: PUB_PEM });
    expect(t2.tier).toBe('free');
    expect(t2.lanServer).toBe(false);

    // And it stays FREE on subsequent hits (expired result cached with null exp).
    const t3 = getEntitlements(() => key, { now: now + 7300, publicKeyPem: PUB_PEM });
    expect(t3.tier).toBe('free');
    invalidateEntitlements();
  });

  it('perpetual keys (exp far future) are unaffected by the re-check', () => {
    invalidateEntitlements();
    const key = mint({ ...goodPayload, tier: 'pro', seats: 1, exp: now + 86_400 * 365 * 50 });
    const a = getEntitlements(() => key, { now, publicKeyPem: PUB_PEM });
    const b = getEntitlements(() => key, { now: now + 86_400 * 300, publicKeyPem: PUB_PEM });
    expect(a.tier).toBe('pro');
    expect(b.tier).toBe('pro');
    expect(b).toBe(a); // same cached object — no recompute happened
    invalidateEntitlements();
  });
});
