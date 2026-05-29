/**
 * Ed25519 PUBLIC verification key for Artha license tokens.
 *
 * The matching PRIVATE key is held offline by Artha's seller (kept at
 * ~/.artha-license-key.pem with mode 0600) and is NEVER committed.
 *
 * To rotate keys for a new release line:
 *   1. Move the existing private key aside (the genkeys script refuses to
 *      overwrite): `mv ~/.artha-license-key.pem ~/.artha-license-key.old.pem`.
 *   2. `node scripts/sign-license.mjs --genkeys`.
 *   3. Paste the printed `-----BEGIN PUBLIC KEY-----` block below.
 *   4. Re-issue licenses to existing customers; previous-key tokens stop
 *      verifying immediately on the next app boot.
 *
 * Active key minted 2026-05-28 — the first production verification key.
 * Round-trip smoke-verified via scripts/sign-license.mjs + verify.ts.
 */

export const PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAAUvA/yKaZA8+g7F7pNrmeKOb6OjzSe0Ex+jYKdPpf20=
-----END PUBLIC KEY-----`;
