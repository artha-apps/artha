# Artha Pricing Page — Canonical Copy

> **Status:** matches the shipped product and the live pricing section on
> artha.space (landing/app/page.tsx). Wire tiers in license keys:
> `free | pro (Personal) | team (Team) | enterprise (Business)`.
> All amounts USD; authoritative prices come from Stripe via `/api/stripe/price`.
> This replaces the earlier draft that promised cloud sync, SSO/SAML, and
> monthly billing — none of which exist. Never publish a feature this doc
> can't point to in the codebase.

---

## Header

**Local-first, honestly priced.**

Everything runs on your machine on every plan — your files never leave it.
License keys verify offline; no account, no phone-home, ever.

**Trust bar:** Local SQLite storage · Works fully offline · No account required · Zero telemetry · Offline license keys (Ed25519)

---

## Tiers

### Free — $0 forever
*Try the local AI coworker for real — no account, no card.*

- Chat, tools, local RAG & long-term memory
- BYOK cloud models (your key, your choice, per task)
- **5 generated documents / month** (the flagship, capped)
- 1 saved context pack
- No scheduler, no starter-template installs
- Community support

CTA: **Download free**

### Personal — $59/year (or $34/6 months) — PRIMARY
*The full solo experience — a fresh offline key on every renewal.*

- Everything in Free, uncapped
- **Unlimited document generation**
- Scheduled/recurring tasks
- Unlimited context packs
- Starter skill templates (legal · finance · operations)
- Priority email support

CTA: **Get Personal**
Mechanics: annual (or 6-month) Stripe subscription → a signed offline key
emailed on purchase and on every renewal (expiry = period end + 7-day grace).
No phone-home; the app verifies the key locally.

### Team — $168/seat/year (reads $14/seat/mo) — min 5 seats
*One hub machine, your whole team working with shared context.*

- Everything in Personal
- **LAN team hub** — teammates connect over your office network; data never
  leaves the hub machine
- Shared memories & **shared context packs**
- Seat-capped roster + per-member API keys

CTA: **Get Team** (seat stepper 5–500, live total)
Mechanics: per-seat annual subscription (Stripe quantity = seats). The key is
applied on the hub machine; seat changes re-issue the key on the proration
invoice. Requires Artha ≥ v0.2.0.

### Business — $348/seat/year (reads $29/seat/mo) — min 5 seats
*For regulated teams that must prove what their AI did.*

- Everything in Team
- **Audit-log export** — every tool call, hashed and attributable per teammate
- Org hub deployment + role controls
- Security-questionnaire support
- *(SSO/SAML: on the roadmap — do NOT promise a date)*

CTA: **Get Business**

### Enterprise / Air-gapped — from $7,500/year (sales-led)
*Legal, healthcare, finance, government, defense.*

- Site/volume licensing, fully air-gapped deployment
- On-prem org hub (dedicated host or container)
- Dedicated support, DPA/procurement paperwork

CTA: **Talk to us** → support@artha.space

---

## Comparison table (only real, code-enforced flags)

| | Free | Personal | Team | Business |
|---|---|---|---|---|
| Runs 100% locally | ✓ | ✓ | ✓ | ✓ |
| Documents / month | 5 | Unlimited | Unlimited | Unlimited |
| Scheduled tasks | — | ✓ | ✓ | ✓ |
| Context packs | 1 | Unlimited | Unlimited | Unlimited |
| Starter skill templates | — | ✓ | ✓ | ✓ |
| LAN team hub | — | — | ✓ | ✓ |
| Shared memories & packs | — | — | ✓ | ✓ |
| Seats | 1 | 1 | 5+ | 5+ |
| Audit-log export | — | — | — | ✓ |
| RBAC / org hub | — | — | — | ✓ |
| Support | Community | Priority | Priority | Priority + questionnaire |

---

## FAQ

**What happens if my subscription lapses?**
Your key includes a 7-day grace window past the renewal date. After that,
Personal falls back to the Free plan and a Team/Business hub stops serving
teammates — but *all your local data stays exactly where it is, yours*.
Re-subscribe any time and paste the new key.

**Do the apps phone home to check my license?**
Never. Keys are Ed25519-signed tokens verified entirely on-device — that's
why they work air-gapped. Subscriptions work by putting an expiry inside the
key and emailing you a fresh one on each renewal.

**Can I move my key between machines?**
Yes — it's a signed token, not a machine lock. One person, your machines.
(Team keys go on the hub machine.)

**I bought the early one-time license — what happens to me?**
You're grandfathered: your perpetual key now maps to **Personal, forever** —
everything solo, no subscription, as promised when you bought it.

**Why is there a document cap on Free?**
Document generation is the flagship and the thing that costs us support and
development time. Everything needed to *evaluate* Artha honestly stays free.

**Refunds?** 14 days, no questions — email support@artha.space.

---

## Copy rules (internal)

- Never claim: cloud sync, E2EE sync, SSO/SAML (until shipped), mobile,
  monthly billing, signed Windows builds (until the Authenticode cert exists).
- Always say "your machine / your office network", never "our cloud".
- Prices are illustrative in this doc; the page renders live Stripe amounts.
