# Windows code signing

How the Windows installer gets signed, what each option actually buys you, and how
to set it up. The release pipeline lives in
[`.github/workflows/release.yml`](../.github/workflows/release.yml); the test-cert
generator is [`scripts/gen-windows-test-cert.mjs`](../scripts/gen-windows-test-cert.mjs).

## TL;DR for a single beta tester

**You don't need to sign anything to let one person test the app.** The unsigned
`.exe` installs fine — Windows just shows a SmartScreen "Windows protected your PC /
unknown publisher" screen. The tester clicks **More info → Run anyway** and it
installs. That's the fastest path and costs nothing.

Sign it only when (a) you're past a handful of testers and the warning is hurting
adoption, or (b) you want to verify the CI signing pipeline before launch.

## The three strategies (auto-selected in CI by which secrets exist)

| Strategy | Secrets needed | Clears "unknown publisher"? | Clears SmartScreen reputation? | Cost / effort |
|---|---|---|---|---|
| **Unsigned** (default today) | none | ❌ | ❌ | free |
| **Self-signed `.pfx`** (demo) | `WIN_CSC_LINK`, `WIN_CSC_KEY_PASSWORD` | only if tester manually trusts the cert | ❌ | free, but per-tester manual trust |
| **OV `.pfx`** (real cert from DigiCert/Sectigo) | `WIN_CSC_LINK`, `WIN_CSC_KEY_PASSWORD` | ✅ | builds over time | ~$200–400/yr + identity validation |
| **Azure Trusted Signing** (recommended) | `AZURE_*` (below) | ✅ | builds over time | ~$10/mo + identity validation |
| **EV cert** | hardware token / cloud HSM | ✅ | ✅ instantly | most expensive |

The Windows publish step in `release.yml` checks for `AZURE_CLIENT_ID` first, then
`WIN_CSC_LINK`, then falls back to unsigned — so **adding the secrets is all it
takes to turn signing on**; no workflow edits.

> ⚠️ **The truth about the self-signed "demo" cert:** signing with it does **not**
> remove the SmartScreen warning for a normal download. A self-signed cert isn't
> chained to a CA Windows trusts. It only helps if the *tester* imports the cert
> into their **Trusted Root** + **Trusted Publishers** stores (an admin action,
> security-sensitive — only do this for a cert you generated yourself), and even
> then Defender SmartScreen can still warn on low reputation. Its honest value is
> proving the CI signing pipeline works end-to-end before you pay for a real cert.

---

## Option A — Self-signed demo cert (free, today)

Generate the cert (already done once; re-run to rotate):

```bash
node scripts/gen-windows-test-cert.mjs
```

It writes the `.pfx` + base64 to `~/.artha-win-signing/` (gitignored) and prints the
two secret values. Set them on the repo:

```bash
gh secret set WIN_CSC_KEY_PASSWORD --repo artha-apps/artha --body '<printed password>'
gh secret set WIN_CSC_LINK --repo artha-apps/artha < ~/.artha-win-signing/artha-win-test.pfx.base64.txt
```

Next tagged release signs the `.exe` with it. For the tester to get a *clean* UAC
prompt (not "unknown publisher"), they must import the cert — share
`~/.artha-win-signing/win-test-cert.pem` (the **public** cert only, never the `.pfx`)
and have them run, in an elevated PowerShell:

```powershell
Import-Certificate -FilePath .\win-test-cert.pem -CertStoreLocation Cert:\LocalMachine\Root
Import-Certificate -FilePath .\win-test-cert.pem -CertStoreLocation Cert:\LocalMachine\TrustedPublisher
```

Most testers won't want to do this. **"Run anyway" is usually the better ask.**

---

## Option B — Azure Trusted Signing (production fix)

This is the real fix that clears "unknown publisher" for everyone with no manual
trust. One-time setup:

1. **Azure account** with a subscription.
2. **Identity validation** — create a *Trusted Signing Account* + *Certificate
   Profile* in the Azure portal. Microsoft validates your identity:
   - Org with a 3+ year-old verifiable history → fast public-trust validation.
   - Newer org / individual → may require extra documentation. **Budget a few
     business days; this is the long pole, so start it before the tester needs it.**
3. **Service principal (Entra ID app registration)** with the *Trusted Signing
   Certificate Profile Signer* role on the account, then create a client secret.
4. **Set the GitHub secrets** (repo `artha-apps/artha`):

   ```bash
   gh secret set AZURE_TENANT_ID            --repo artha-apps/artha --body '<tenant id>'
   gh secret set AZURE_CLIENT_ID            --repo artha-apps/artha --body '<app/client id>'
   gh secret set AZURE_CLIENT_SECRET        --repo artha-apps/artha --body '<client secret>'
   gh secret set AZURE_PUBLISHER_NAME       --repo artha-apps/artha --body 'Shree Labs Inc.'
   gh secret set AZURE_CODE_SIGNING_ENDPOINT --repo artha-apps/artha --body 'https://<region>.codesigning.azure.net/'
   gh secret set AZURE_CODE_SIGNING_ACCOUNT  --repo artha-apps/artha --body '<trusted signing account name>'
   gh secret set AZURE_CERT_PROFILE          --repo artha-apps/artha --body '<certificate profile name>'
   ```

   `AZURE_PUBLISHER_NAME` must match the certificate's subject exactly.
5. Cut a release tag. The Windows step detects `AZURE_CLIENT_ID` and signs via
   electron-builder's native `azureSignOptions`.

> SmartScreen *reputation* (the blue warning) is separate from publisher trust and
> builds up as more users install a given signed publisher. An OV cert (Azure
> default) earns it over time; only an **EV** cert gets it instantly.

---

## Verifying a signature

On Windows: right-click the `.exe` → **Properties → Digital Signatures**, or:

```powershell
Get-AuthenticodeSignature .\Artha-Setup-*.exe | Format-List
```

`Status: Valid` with the expected signer = signing worked.
