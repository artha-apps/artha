# SOP: Onboarding a large institution

Use this playbook when you're standing Artha up for a mid-to-large enterprise — a dozen seats to thousands. Higher-touch, longer cycle, real procurement. End state: an Artha **org hub** running inside the customer's network with seats provisioned for every teammate.

The big shift vs. a single-client onboarding: **no data leaves the customer's network, and the hub is operated by the customer's IT**. You sell, license, and support; they host. This is a single-tenant deployment per customer, not a multi-tenant SaaS — see [docs/gtm/](../) for the GTM rationale.

---

## Pre-flight (you + procurement)

- Confirm scope: seat count, contract length (default 1 year), data residency (their network, by construction).
- Identify their **hub admin** (a single person on their side who runs the install and provisions seats).
- Confirm host: dedicated mini-PC / VM (Option A, recommended) or container (Option B, interim). See [docs/deploy/org-hub.md](../../deploy/org-hub.md).
- Security review: hand them the privacy policy, SOC 2 readiness checklist, and the deploy runbook. They almost always have follow-up questions about data isolation — the answer is "your hub, your network, your DB file."

---

## Steps

### 1. Mint the org license

```bash
node scripts/sign-license.mjs \
  --tier enterprise \
  --seats 250 \
  --org "Acme Corp" \
  --days 365
```

Deliver the token via your contract delivery channel (DocuSign attachment, secure email, customer portal). Treat it like any other access credential.

### 2. Admin stands up the hub

The hub admin follows [docs/deploy/org-hub.md](../../deploy/org-hub.md):
- Provisions the host (sizing table in the runbook).
- Installs Ollama (or points the hub at their existing GPU box).
- Installs Artha.
- Runs **first-launch onboarding → "Setting up for my organization"**.
- Pastes the license token. Confirms tier = Enterprise.
- Starts the hub (LAN server).
- Notes the hub URL (`http://<host-lan-ip>:7842`).
- Enables LAN auto-start.

### 3. Admin provisions seats

Inside the same OrgSetup flow (or later in **Workspace Settings → Team**):
- For each teammate, add a `team_members` row (name + optional email + role).
- Mint an API key bound to that member.
- Copy the auto-generated **connection card** (hub URL + key + curl example).
- Distribute the card to that teammate via the customer's internal comms.

Bulk provisioning: for very large rollouts, script the calls — the IPC bridge exposes `team:addMember` and `apikeys:create` and they can be invoked from a Node script on the hub host.

### 4. Teammates connect

For Phase 1, teammates have three working integration points:
- **curl / HTTP**: the connection card includes a working example.
- **IDE bridge**: Settings → Integrations → IDE generates a `.cursor`/`.vscode` MCP config that points at the hub.
- **Their own MCP-aware tool**: hit `<hub-url>/chat` directly.

The polished in-app "Connect to team hub" thin-client mode is on the Phase 2 roadmap. Until it ships, the canonical member experience is via the LAN API.

### 5. Operationalise

Confirm with the hub admin:
- **Backups**: the SQLite file is the entire state of the deployment (path in the runbook). Their existing backup target works.
- **Updates**: Auto-update on by default; change-managed environments should disable it and pull installers on their schedule.
- **Monitoring**: `GET /health` is public — they can wire it into their uptime monitoring without sharing the bearer key.

---

## Pricing & renewals

- Pricing scales with seats encoded in the license. Re-issue a new token for upsells (more seats / longer term).
- Mid-term seat changes = mint a new token, customer pastes it into LicensePanel, old token immediately replaced.
- Renewal at end of term: deliver a new token before expiry — verification will refuse expired tokens and silently downgrade to Free.

---

## Support handoff

- **Single point of contact** on the customer side: the hub admin. Triage everything through them.
- **State location** is the SQLite file on the hub host; they own it.
- **Open hub logs** for an issue: the hub host's userData directory under `logs/`.

---

## What NOT to do

- **Don't promise multi-tenant cloud.** That's not the architecture. Lean into single-tenant isolation as a feature (compliance, residency, network-locality).
- **Don't lift seat caps unofficially.** Always re-issue a signed token — that's the only mechanism, and verification is local.
- **Don't bypass the customer's IT for hub install.** Even if it's slower, customer-operated deployment is the whole pitch.

Related: [Onboarding a single client](./single-client.md), [Deploying the org hub](../../deploy/org-hub.md)
