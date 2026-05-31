/**
 * License key generation for Artha — server-side (Vercel only).
 *
 * Key format (matches packages/app/src/license/verify.ts):
 *   base64url(JSON payload) + "." + base64url(ed25519 signature)
 *
 * The Ed25519 private key is stored in the ARTHA_LICENSE_PRIVATE_KEY env var
 * (full PEM string). The matching public key is bundled in the Electron app at
 * packages/app/src/license/public-key.ts.
 *
 * To extract your private key and set it in Vercel:
 *   cat ~/.artha-license-key.pem            # copy the PEM block
 *   vercel env add ARTHA_LICENSE_PRIVATE_KEY # paste when prompted
 */

import { createPrivateKey, sign, randomUUID } from 'crypto';

export type Tier = 'free' | 'pro' | 'enterprise';

export interface LicensePayload {
  /** Unique license ID (UUID v4). */
  id: string;
  /** Customer identifier — typically email address. */
  org: string;
  tier: Tier;
  /** Number of seats (1 for individual Pro). */
  seats: number;
  /** Issued-at Unix timestamp (seconds). */
  iat: number;
  /** Expiry Unix timestamp (seconds). Use year 2099 for perpetual keys. */
  exp: number;
}

/** Unix timestamp for 2099-01-01 — effectively perpetual for one-time purchases. */
const PERPETUAL_EXPIRY = Math.floor(new Date('2099-01-01T00:00:00Z').getTime() / 1000);

function b64urlEncode(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

/**
 * Generate a signed Artha license key.
 *
 * @param email   Customer email — stored in the `org` field for support lookups.
 * @param tier    License tier ('pro' | 'enterprise').
 * @param seats   Number of seats (default 1).
 * @param expiry  Expiry Unix timestamp in seconds (default: 2099 = perpetual).
 */
export function generateLicenseKey(
  email: string,
  tier: Tier = 'pro',
  seats = 1,
  expiry = PERPETUAL_EXPIRY,
): string {
  const privatePem = process.env.ARTHA_LICENSE_PRIVATE_KEY;
  if (!privatePem) {
    throw new Error('ARTHA_LICENSE_PRIVATE_KEY env var is not set');
  }

  const payload: LicensePayload = {
    id: randomUUID(),
    org: email,
    tier,
    seats,
    iat: Math.floor(Date.now() / 1000),
    exp: expiry,
  };

  const payloadBuf = Buffer.from(JSON.stringify(payload), 'utf8');
  const privKey = createPrivateKey(privatePem.replace(/\\n/g, '\n'));
  // Ed25519 — algorithm param must be null per Node docs.
  const sigBuf = sign(null, payloadBuf, privKey);

  return `${b64urlEncode(payloadBuf)}.${b64urlEncode(sigBuf)}`;
}
