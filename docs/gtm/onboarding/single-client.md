# SOP: Onboarding a single client (individual / small customer)

Use this playbook when you're putting a single person on Artha — a freelancer, a prosumer, a one-or-two-person team. End state: they have the desktop app installed, a working local model, and (if paid) a Pro license applied.

This is the high-volume, low-touch motion. Most steps the customer does themselves; sales/CS only steps in for the upgrade.

---

## Pre-flight (you)

- Their OS: macOS, Windows, or Linux? Pick the installer.
- Did they pay for Pro? If yes, mint their license (see step 4).
- Hardware check: at least 16 GB RAM for the recommended local models. Lower-RAM machines can run 3B/1B models or skip local entirely and use cloud-via-BYOK.

---

## Steps

### 1. Customer downloads the installer

Direct them to the release page. They get one of:
- `Artha-<ver>.dmg` (macOS, universal)
- `Artha-Setup-<ver>.exe` (Windows)
- `artha_<ver>_amd64.deb` (Linux)

### 2. They run the first-launch onboarding

- App opens to the **persona picker**. They click **"Just me"**.
- App checks for Ollama. If missing, they install it (linked in-app).
- App detects RAM and recommends a model. They pull it.
- App lands them in the chat. They're done with the Free experience.

### 3. (Optional) They apply a Pro license

Two places they can paste it:
- The collapsible **"Have a license key? (optional)"** strip on the onboarding screen.
- Anywhere later: **Workspace Settings → Team → License → Apply**.

After apply, the LicensePanel shows `Pro · <seats> seats · expires <date>` and the LAN/team server unlocks.

### 4. (For paid customers) You mint and deliver the license

```bash
node scripts/sign-license.mjs \
  --tier pro \
  --seats 5 \
  --org "Customer Name" \
  --days 365
```

- The single line of stdout is their license token.
- Deliver it via whichever channel matches the deal (email, customer portal, Stripe receipt).

### 5. Upgrade triggers

A Free user typically signals readiness for Pro when they:
- Try to add a team member or start the LAN server (the UI surfaces the upgrade copy).
- Ask about sharing/collab with a colleague.
- Hit the "single-seat" wall.

For self-serve upgrades, the LicensePanel is the entry point — no reinstall needed.

---

## Support handoff

- All state is local in `~/Library/Application Support/Artha/artha.db` (macOS) / equivalent on other OSes. If they're stuck, "quit, back up the file, reinstall, restore the file" almost always works.
- Logs live in the same userData directory under `logs/`.

---

## What NOT to do

- **Don't share license keys.** Each customer gets a fresh signed token. Re-using a token across customers makes revocation impossible.
- **Don't ship a custom build.** Same binary serves all tiers — what changes is the key they paste.
- **Don't try to phone home.** Free is genuinely free; there is no activation server. Treat any "telemetry" ask from a privacy-minded customer as a chance to confirm "we don't collect any."

Related: [Onboarding a large institution](./institution.md), [Deploying the org hub](../../deploy/org-hub.md)
