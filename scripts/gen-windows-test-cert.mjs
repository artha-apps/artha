#!/usr/bin/env node
// Generate a SELF-SIGNED Windows Authenticode "test" certificate (.pfx) for beta
// signing. Seller-only tool — analogous to scripts/sign-license.mjs.
//
// ⚠️  READ THIS BEFORE USING IT TO "FIX" THE SMARTSCREEN WARNING:
//   A self-signed cert is NOT trusted by Windows. Signing the installer with it
//   does NOT remove the SmartScreen "unknown publisher" warning for a normal
//   download. It only helps if the tester *manually imports* this cert into their
//   Trusted Root + Trusted Publishers stores (an admin/security-sensitive action),
//   and even then SmartScreen reputation warnings can persist. Its real value is
//   verifying that the CI signing pipeline works end-to-end before you pay for a
//   real cert. For a production fix that clears the warning for everyone, use
//   Azure Trusted Signing (see docs/windows-signing.md).
//
// Output: a .pfx (cert + private key) plus the base64 + password you paste into
// the GitHub secrets WIN_CSC_LINK and WIN_CSC_KEY_PASSWORD. The .pfx and key are
// written OUTSIDE the repo (~/.artha-win-signing/) and are gitignored anyway.
//
// Usage:
//   node scripts/gen-windows-test-cert.mjs
//   node scripts/gen-windows-test-cert.mjs --cn "Artha Beta" --org "Shree Labs Inc." --days 365

import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync, readFileSync, chmodSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`)
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}

const CN = arg('cn', 'Artha (Shree Labs Inc.) — TEST')
const ORG = arg('org', 'Shree Labs Inc.')
const COUNTRY = arg('country', 'CA')
const DAYS = arg('days', '365')

const outDir = join(homedir(), '.artha-win-signing')
mkdirSync(outDir, { recursive: true })

const keyPem = join(outDir, 'win-test-key.pem')
const certPem = join(outDir, 'win-test-cert.pem')
const pfxPath = join(outDir, 'artha-win-test.pfx')
const password = randomBytes(18).toString('base64url')

const subj = `/CN=${CN}/O=${ORG}/C=${COUNTRY}`

console.error(`Generating self-signed code-signing cert:\n  subject: ${subj}\n  valid:   ${DAYS} days\n  out dir: ${outDir}\n`)

// 1. Key + self-signed cert with the codeSigning EKU (what Authenticode checks).
execFileSync('openssl', [
  'req', '-x509', '-newkey', 'rsa:3072', '-sha256',
  '-keyout', keyPem, '-out', certPem,
  '-days', DAYS, '-nodes',
  '-subj', subj,
  '-addext', 'keyUsage=critical,digitalSignature',
  '-addext', 'extendedKeyUsage=critical,codeSigning',
], { stdio: ['ignore', 'inherit', 'inherit'] })

// 2. Bundle into a .pfx (PKCS#12) — the format electron-builder/signtool consume.
execFileSync('openssl', [
  'pkcs12', '-export',
  '-out', pfxPath,
  '-inkey', keyPem,
  '-in', certPem,
  '-passout', `pass:${password}`,
  '-name', CN,
], { stdio: ['ignore', 'inherit', 'inherit'] })

chmodSync(pfxPath, 0o600)
chmodSync(keyPem, 0o600)

const b64 = readFileSync(pfxPath).toString('base64')
const b64File = join(outDir, 'artha-win-test.pfx.base64.txt')
writeFileSync(b64File, b64, { mode: 0o600 })

console.error('\n✅ Done. Files written to', outDir)
console.error('   - artha-win-test.pfx            (the cert + private key)')
console.error('   - artha-win-test.pfx.base64.txt (base64 of the pfx, for the secret)')
console.error('\n── Set these GitHub repo secrets (artha-apps/artha) ──────────────')
console.error('WIN_CSC_KEY_PASSWORD = ' + password)
console.error('WIN_CSC_LINK         = <contents of artha-win-test.pfx.base64.txt>')
console.error('\nQuick set with gh CLI:')
console.error(`  gh secret set WIN_CSC_KEY_PASSWORD --repo artha-apps/artha --body '${password}'`)
console.error(`  gh secret set WIN_CSC_LINK --repo artha-apps/artha < ${b64File}`)
console.error('\n⚠️  Self-signed: does NOT clear SmartScreen on its own. See docs/windows-signing.md.')
