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

import { computeEntitlements, parseAndVerify, invalidateEntitlements } from './verify';
import { FREE_ENTITLEMENTS } from './entitlements';

function b64url(buf: Buffer): string {
  return buf.toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}

/** Generate a single keypair shared across the test cases. */
const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const PUB_PEM = publicKey.export({ type: 'spki', format: 'pem' }) as string;

interface Payload {
  id: string; org: string; tier: 'free' | 'pro' | 'enterprise';
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
