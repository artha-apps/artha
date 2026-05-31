#!/usr/bin/env node
/**
 * Offline license signing tool — for the seller's use, NOT shipped to users.
 *
 * Two modes:
 *
 *   1. Generate the long-lived signing keypair, once:
 *        node scripts/sign-license.mjs --genkeys
 *      Writes the PRIVATE key to ~/.artha-license-key.pem (mode 0600).
 *      Prints the PUBLIC key — paste it into packages/app/src/license/public-key.ts
 *      and ship the next release.
 *
 *   2. Mint a license token for a customer:
 *        node scripts/sign-license.mjs \
 *          --tier enterprise --seats 250 --org "Acme Corp" --days 365
 *      Reads the private key from $ARTHA_LICENSE_PRIVATE_KEY_FILE or
 *      ~/.artha-license-key.pem and prints the token on stdout.
 *
 * The private key MUST NEVER be committed. The repo's root .gitignore already
 * excludes *.pem just in case.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  createPrivateKey,
  generateKeyPairSync,
  randomUUID,
  sign as cryptoSign,
} from 'node:crypto';

// Minimal --key value / --flag parser — no external deps so this stays drop-in.
function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      out[key] = true;
    } else {
      out[key] = next;
      i++;
    }
  }
  return out;
}

function b64url(buf) {
  return Buffer.from(buf).toString('base64')
    .replace(/=+$/, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

function die(msg, code = 1) {
  process.stderr.write(`sign-license: ${msg}\n`);
  process.exit(code);
}

const args = parseArgs(process.argv.slice(2));
const privPath = process.env.ARTHA_LICENSE_PRIVATE_KEY_FILE
  || join(homedir(), '.artha-license-key.pem');

if (args.help || args.h) {
  process.stdout.write(`Usage:
  node scripts/sign-license.mjs --genkeys
  node scripts/sign-license.mjs --tier <free|pro|enterprise> --seats <n> --org <name> [--days 365] [--id <uuid>]

Env:
  ARTHA_LICENSE_PRIVATE_KEY_FILE  Override the default private key path
                                  (default: ~/.artha-license-key.pem)
`);
  process.exit(0);
}

if (args.genkeys) {
  if (existsSync(privPath)) {
    die(`Refusing to overwrite an existing private key at ${privPath}. Move it aside (mv ~/.artha-license-key.pem ~/.artha-license-key.old.pem) and re-run.`);
  }
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const privPem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  const pubPem = publicKey.export({ type: 'spki', format: 'pem' });

  writeFileSync(privPath, privPem, { mode: 0o600 });
  process.stdout.write(`Private key written to ${privPath} (mode 0600). KEEP IT OFFLINE. Never commit.\n\n`);
  process.stdout.write(`Paste this PUBLIC KEY into packages/app/src/license/public-key.ts:\n\n`);
  process.stdout.write(pubPem);
  process.exit(0);
}

if (!existsSync(privPath)) {
  die(`Private key not found at ${privPath}. Run: node scripts/sign-license.mjs --genkeys`);
}

const tier = String(args.tier ?? '').toLowerCase();
if (!['free', 'pro', 'enterprise'].includes(tier)) {
  die('--tier must be one of: free, pro, enterprise');
}

const seats = Number(args.seats ?? 1);
if (!Number.isFinite(seats) || seats < 1 || !Number.isInteger(seats)) {
  die('--seats must be a positive integer');
}

const org = String(args.org ?? '').trim();
if (!org) die('--org is required (the customer organisation name)');

const days = Number(args.days ?? 365);
if (!Number.isFinite(days) || days < 1) die('--days must be a positive number');

const id = args.id ?? randomUUID();
const now = Math.floor(Date.now() / 1000);
const payload = { id, org, tier, seats, iat: now, exp: now + Math.floor(days) * 86400 };

const privKey = createPrivateKey(readFileSync(privPath));
const payloadBytes = Buffer.from(JSON.stringify(payload), 'utf8');
const sig = cryptoSign(null, payloadBytes, privKey);
const token = `${b64url(payloadBytes)}.${b64url(sig)}`;

process.stdout.write(token + '\n');
process.stderr.write(`Issued: tier=${tier} seats=${seats} org="${org}" days=${days} id=${id}\n`);
