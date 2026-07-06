/**
 * Offline license key verification.
 *
 * Key format (single line, URL-safe):
 *   base64url(JSON payload) + "." + base64url(ed25519 signature)
 *
 * The signature is verified locally with the bundled public key
 * (./public-key.ts) using Node's built-in crypto — no `nacl`/`jose` dep, no
 * network call, no phone-home. This keeps the privacy/air-gap story intact:
 * an enterprise can run Artha entirely offline and still validate its key.
 *
 * The signature alone proves authenticity; we additionally reject expired keys
 * and reject keys whose payload fails a basic shape check. Failure → null →
 * caller falls back to FREE_ENTITLEMENTS.
 */

import { createPublicKey, verify as cryptoVerify } from 'crypto';

import {
  Entitlements,
  FREE_ENTITLEMENTS,
  Tier,
  entitlementsFor,
} from './entitlements';
import { PUBLIC_KEY_PEM } from './public-key';

/** Wire format of a verified license token. */
export interface LicensePayload {
  /** Opaque unique id — included so we can blocklist a specific token later. */
  id: string;
  org: string;
  tier: Tier;
  /** Seat cap encoded by the seller; min 1. */
  seats: number;
  /** Issued-at, unix seconds. */
  iat: number;
  /** Expires-at, unix seconds. Verified against `now`. */
  exp: number;
}

/** RFC 7515 §2 base64url → Buffer. Tolerates missing padding. */
function b64urlDecode(s: string): Buffer {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
  const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
  return Buffer.from(padded, 'base64');
}

const VALID_TIERS: ReadonlySet<Tier> = new Set<Tier>(['free', 'pro', 'team', 'enterprise']);

/**
 * Revoked license ids (the `id` field minted by scripts/sign-license.mjs).
 *
 * A signed key is otherwise valid until it expires, so a leaked or charged-back
 * Enterprise key would keep working. Listing its id here kills it on the next
 * app update — no public-key rotation (which would invalidate EVERY customer's
 * key) required. Add the offending UUID, ship a release. Keep this list small;
 * for routine churn, prefer short `--days` so keys lapse on their own.
 */
export const REVOKED_LICENSE_IDS: ReadonlySet<string> = new Set<string>([
  // ravitoor@truthtribe.ca — revoked 2026-06-17, replaced by a fresh 1-year key
  // (new id e4ac7618-a4c2-4a9a-b5f9-3c055c2d20e0). This id covered both the old
  // 2099 token and the 180-day reissue, so revoking it kills both at once.
  '967ba9ab-7a05-4049-b7c2-a88de26b7f9d',
]);

/** Verify signature + shape + expiry. Returns the payload or null on any
 *  failure. Catches every error so a malformed token can't crash boot. */
export function parseAndVerify(
  key: string,
  opts: { now?: number; publicKeyPem?: string; revokedIds?: ReadonlySet<string> } = {},
): LicensePayload | null {
  try {
    if (typeof key !== 'string' || !key.includes('.')) return null;
    const [head, sig] = key.split('.');
    if (!head || !sig) return null;

    const payloadBytes = b64urlDecode(head);
    const sigBytes = b64urlDecode(sig);

    const pub = createPublicKey(opts.publicKeyPem ?? PUBLIC_KEY_PEM);
    // Ed25519 — algorithm is null per the Node docs.
    if (!cryptoVerify(null, payloadBytes, pub, sigBytes)) return null;

    const payload = JSON.parse(payloadBytes.toString('utf8')) as Partial<LicensePayload>;
    if (!payload || typeof payload !== 'object') return null;
    if (typeof payload.id !== 'string' || !payload.id) return null;
    if (typeof payload.org !== 'string') return null;
    if (typeof payload.tier !== 'string' || !VALID_TIERS.has(payload.tier as Tier)) return null;
    if (typeof payload.seats !== 'number' || payload.seats < 1 || !Number.isFinite(payload.seats)) return null;
    if (typeof payload.iat !== 'number' || !Number.isFinite(payload.iat)) return null;
    if (typeof payload.exp !== 'number' || !Number.isFinite(payload.exp)) return null;

    const now = opts.now ?? Math.floor(Date.now() / 1000);
    if (payload.exp < now) return null;

    // Revocation: a validly-signed, unexpired key can still be killed by id.
    if ((opts.revokedIds ?? REVOKED_LICENSE_IDS).has(payload.id)) return null;

    return payload as LicensePayload;
  } catch {
    return null;
  }
}

/** Compute entitlements from a raw key string. Empty/invalid/expired → Free.
 *  `publicKeyPem` is a test seam — production callers use the bundled key. */
export function computeEntitlements(rawKey: string | null | undefined, now?: number, publicKeyPem?: string): Entitlements {
  if (!rawKey) return FREE_ENTITLEMENTS;
  const payload = parseAndVerify(rawKey, { now, publicKeyPem });
  if (!payload) return FREE_ENTITLEMENTS;
  return entitlementsFor(payload.tier, payload.seats, payload.org || null, payload.exp);
}

// ── Cached resolution ────────────────────────────────────────────────────────
// Verification is cheap (one Ed25519 verify) but the entitlement check is hit
// on EVERY LAN request and every gated IPC call. Cache by raw-key identity so
// we re-verify only when the user pastes/clears a key.
let cached: { key: string | null; ents: Entitlements } | null = null;

/**
 * Resolve the current entitlements. `readKey` is a callback the caller
 * provides so this module never imports the database. Pass a function that
 * returns `settings_json.license_key` or null.
 */
export function getEntitlements(
  readKey: () => string | null | undefined,
  opts: { now?: number; publicKeyPem?: string } = {},
): Entitlements {
  const key = readKey() ?? null;
  const nowSec = opts.now ?? Math.floor(Date.now() / 1000);
  if (cached && cached.key === key) {
    // Re-check expiry on every cache hit: annual (team/business) keys must
    // lapse the moment they expire, not at the next app restart. Cheap — one
    // comparison; the Ed25519 re-verify below only runs on the first call
    // AFTER expiry (computeEntitlements then falls back to Free).
    const exp = cached.ents.expiresAt;
    if (exp === null || exp >= nowSec) return cached.ents;
  }
  const ents = computeEntitlements(key, opts.now, opts.publicKeyPem);
  cached = { key, ents };
  return ents;
}

/** Drop the cached entitlements. Call after license:apply / license:clear. */
export function invalidateEntitlements(): void {
  cached = null;
}
