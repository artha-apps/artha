# Artha Monetization — Technical Foundation

> Status: **Foundation document.** This describes the technical substrate for metering,
> cost accounting, budgets, and entitlement gating. It is explicitly **not** a pricing
> decision and does not modify any current GTM document. Managed cloud (Artha Cloud) is
> **deferred** — no billing, accounts, or credits implementation is in scope now.
>
> Companion: `ARTHA_PROVIDER_AND_RUNTIME_ARCHITECTURE.md` (execution profiles, provider
> abstraction, execution modes `local | byok | byoc | cloud`).
>
> Architectural invariant, stated once and enforced everywhere below:
> **capability logic and entitlement logic stay separate.** Capabilities describe what
> the engine *can* do (`src/bodhi/capabilities.ts`); entitlements describe what this
> installation is *licensed* to do (`src/license/entitlements.ts`). Gating code consults
> `getEntitlements()` only. It never inspects capability metadata, and capability
> selection never inspects the license tier.

---

## 1. Current state (as implemented)

### 1.1 Four-tier offline-signed license system

The shipped system (`packages/app/src/license/`) is a fully offline, signed-token design:

- **Key format** — `base64url(JSON payload) . base64url(ed25519 signature)` (`verify.ts`).
  Verified with Node built-in `crypto` against a bundled public key
  (`public-key.ts`); no network call, no phone-home. Air-gapped installs validate keys.
- **Payload** — `{ id, org, tier, seats, iat, exp }`. `id` supports per-token revocation
  via the shipped `REVOKED_LICENSE_IDS` set (kill a leaked key in the next release
  without rotating the public key).
- **Tiers** — wire strings `free | pro | team | enterprise` map to commercial names
  Free / Personal / Team / Business. The wire string lives inside signed keys and never
  changes when marketing labels do.
- **Entitlement matrix** (`entitlements.ts`, `TIER_ENTITLEMENTS`) — team flags
  (`lanServer`, `sharedMemory`, `sharedPacks`, `orgHub`, `rbac`, `auditExport`) plus solo
  caps (`docsPerMonth: 5|null`, `scheduler`, `maxContextPacks: 1|null`, `skillTemplates`).
  Any failure — missing, tampered, expired, revoked — falls back to `FREE_ENTITLEMENTS`.
- **Resolution** — `getEntitlements()` (`verify.ts`) caches by raw-key identity and
  re-checks expiry on every hit so annual keys lapse mid-session. `currentEntitlements()`
  (`current.ts`) is the shared accessor for IPC handlers and tool modules; seat usage is
  `team_members ∪ unbound enabled api_keys` (`seats.ts`).
- **Existing metering-adjacent counter** — exactly one: `docsGeneratedThisMonth()`
  (`current.ts`) counts `generated_documents` rows for the Free doc cap. It fails open.

### 1.2 Stripe → license-key pipeline (landing site)

`landing/app/api/stripe/*` implements zero-database fulfilment — Stripe is the customer
store:

- `checkout/route.ts` creates the Checkout session; `price/route.ts` serves authoritative
  prices from Stripe so the pricing page never hardcodes amounts.
- `webhook/route.ts` mints keys on `invoice.paid` (branching on **price id**, seats from
  line quantity for per-seat plans, expiry = period end + 7-day grace), handles legacy
  one-time purchases on `checkout.session.completed` (perpetual Personal), and sends a
  courtesy email on `customer.subscription.deleted`. Keys are signed server-side by
  `lib/license-gen.ts` (Ed25519, `ARTHA_LICENSE_PRIVATE_KEY`) and emailed via Resend.
- No idempotency store by design: re-processing re-mints an equivalent key.

### 1.3 No metering of any kind (audit finding)

There is currently **zero token or cost accounting** in the product:

- `packages/app/src/llm/client.ts` never reads the `usage` field from any response — not
  on the OpenAI-compat path (`complete` / `streamComplete`), and not on the native-Ollama
  `/api/chat` paths (which discard `prompt_eval_count` / `eval_count` that Ollama reports
  in its final stream event).
- `agent_runs` (`src/db/schema.ts`) stores only the model **name string**; `agent_steps`
  stores payloads with no token counts.
- Consequences: no per-run cost, no monthly spend view, no budget enforcement, no
  savings story, and no data to design managed-cloud economics against. Fixing this is
  **Phase B** (the cost ledger), specified below.

---

## 2. Metering architecture (Phase B target)

### 2.1 Capture points

Metering is a **recording concern in the LLM/tool call path**, not a gating concern.
One capture module (`src/metering/record.ts`, new) is invoked from:

| Capture point | Where | Notes |
|---|---|---|
| Every `LLMClient.complete()` | OpenAI-compat and `completeOllamaNative` | Read `usage` (compat) / `prompt_eval_count`+`eval_count` (native) |
| Every `LLMClient.streamComplete()` / `streamChat()` | Both transport paths | Compat: request `stream_options: { include_usage: true }` where supported; native Ollama: final `done` event carries counts. Estimate when neither is available |
| Tool invocations | Orchestrator tool dispatch | Zero token cost themselves, but rows give per-tool frequency + let LLM rows join to the tool that triggered them |
| Document generations | `docs_generate` path | Already counted for the Free cap; unify onto the ledger (the cap query can later read the ledger) |
| Browser actions | `invokeBrowserTool` | Later — recorded for run forensics, not cost |

Every LLM call site already flows through `LLMClient`, so the two class methods (plus
`streamChat`) are the complete choke point — no per-caller instrumentation.

### 2.2 What is recorded

Per event: `provider` (ollama / openai-compat host / openrouter / …), `model`,
`prompt_tokens` + `completion_tokens` **as reported by `usage` where the provider
returns them**, estimated tokens where not (see 2.4), `run_id` (joins `agent_runs`),
`session_id`, `capability` (skill/capability slug or orchestration phase:
`plan | tool_args | synthesis | chat`), execution mode `local | byok | byoc | cloud`,
and timestamp.

### 2.3 `usage_ledger` table

Additive migration in `src/db/schema.ts`, same pattern as every other table:

```sql
CREATE TABLE IF NOT EXISTS usage_ledger (
  event_id          TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
  ts                INTEGER NOT NULL DEFAULT (unixepoch()),
  kind              TEXT NOT NULL CHECK(kind IN ('llm','tool','doc','browser')),
  provider          TEXT NOT NULL,            -- 'ollama' | 'openai' | 'openrouter' | host
  model             TEXT NOT NULL DEFAULT '',
  exec_mode         TEXT NOT NULL DEFAULT 'local'
                    CHECK(exec_mode IN ('local','byok','byoc','cloud')),
  run_id            TEXT,                     -- agent_runs.run_id when in a run
  session_id        TEXT,                     -- chat session
  capability        TEXT,                     -- skill slug or phase: plan|tool_args|synthesis|chat
  profile_id        TEXT,                     -- execution profile (provider/runtime doc)
  prompt_tokens     INTEGER,                  -- NULL when unknown
  completion_tokens INTEGER,
  tokens_estimated  INTEGER NOT NULL DEFAULT 0,  -- 1 = counts are estimates, not provider-reported
  cost_usd          REAL,                     -- NULL for local ($0 marginal, see §3)
  cost_estimated    INTEGER NOT NULL DEFAULT 0,  -- 1 = price came from registry/estimate, not provider
  meta_json         TEXT NOT NULL DEFAULT '{}'   -- tool name, doc type, error, etc.
);
CREATE INDEX IF NOT EXISTS idx_usage_ts       ON usage_ledger(ts);
CREATE INDEX IF NOT EXISTS idx_usage_run      ON usage_ledger(run_id);
CREATE INDEX IF NOT EXISTS idx_usage_provider ON usage_ledger(provider, model, ts);
CREATE INDEX IF NOT EXISTS idx_usage_profile  ON usage_ledger(profile_id, ts);
```

Writes are fire-and-forget and **fail open** — a broken ledger must never block a run
(same principle as `docsGeneratedThisMonth()`).

### 2.4 Estimation

When a provider path reports no usage (aborted streams, compat endpoints without
`stream_options`), estimate `prompt_tokens` from the serialized message array and
`completion_tokens` from accumulated output (chars/4 heuristic or a bundled tokenizer),
and set `tokens_estimated = 1`. Estimated and reported numbers are **never mixed
silently** — the flag travels through every aggregate.

### 2.5 Aggregation views

SQL views (or prepared queries) over the ledger — per **run** (cost of one Delegate
task), per **day**, per **month**, per **provider/model**, per **execution profile**.
Each aggregate carries `SUM(cost_estimated)` so the UI can label any figure containing
estimates.

### 2.6 Privacy

The ledger is **local-only by default — it is the user's data**, in the user's SQLite
file. No usage telemetry leaves the machine without explicit consent; Sentry scrubbing
rules (`sentryScrub.ts`) already exclude such data and stay that way. Any future opt-in
aggregate reporting is a separate, consent-gated feature.

---

## 3. Cost calculation

### 3.1 Provider price registry

Three layers, in override order:

1. **Static shipped table** — `src/metering/prices.ts`: per-1M input/output token USD
   prices for known models, each entry carrying a `lastUpdated` date. Ships with the
   binary; refreshed each release.
2. **User-editable overrides** — stored in settings; a user with negotiated or updated
   pricing corrects any entry.
3. **Live pricing where available** — OpenRouter's models API reports per-token prices;
   when the provider is OpenRouter, fetched prices (cached, TTL) take precedence and
   mark the cost as provider-reported.

### 3.2 Honest cost reporting (engineering principle)

- A cost computed from the static registry or from estimated tokens is an **estimate**
  and is labeled as one everywhere ("~$0.42 est."), never presented as an exact figure.
- Provider-reported usage priced by live provider pricing may drop the estimate label.
- **Local models report $0 marginal cost** — optionally with an informational
  energy/hardware note — and never a fake dollar figure. We do not invent numbers to
  make the savings story look better; the story survives honesty or it isn't real.

---

## 4. Budgets

Budget limits attach to **execution profiles** (per-profile monthly/rolling ceiling) and
to **individual tasks** (per-run cap), per the provider/runtime architecture doc.

**Enforcement points:**

1. **Before dispatch** — projected cost of the first call (prompt size × registry price)
   is checked against remaining budget before the run starts.
2. **Mid-run** — cumulative run cost (one indexed `SUM` over `usage_ledger` by `run_id`)
   is re-checked **between ReAct iterations**, before each next LLM call.

**On breach: pause and ask, never silently stop.** The run enters the existing
clarification flow ("This task has used ~$0.38 of its $0.50 budget — continue, raise the
limit, or stop?") so a long task is never discarded and never silently truncated.

**UI:** budget state is surfaced — remaining budget on the profile, a live cost readout
on the run (Delegate timeline / WorkingIndicator region), and month-to-date in Settings.

---

## 5. Savings comparison

The retention surface the ledger enables: *"You spent $1.63 across 214 tasks this month
— ChatGPT Plus is $20/mo."*

- Computed from the monthly aggregation view vs a **reference price table**
  (`src/metering/referencePrices.ts`): subscription name, monthly USD price, source URL,
  `lastUpdated` date. Maintained data, **not hardcoded marketing claims** — every
  comparison renders its as-of date, and a stale entry (> N months) is flagged or hidden.
- Inherits §3 honesty rules: if the month's figure includes estimates, the card says so.
- Local-only computation; nothing about it phones home.

---

## 6. Provisional entitlement map

> **Explicitly provisional.** This table exists so that gating logic added during
> Phases B+ lands consistently instead of being retrofitted; it is **not** a pricing or
> packaging decision, and rows may move between tiers before any public commitment.

All checks consult `getEntitlements()` / `currentEntitlements()` — the existing pattern —
and **never** capability logic. New rows become fields on `Entitlements` in
`entitlements.ts` (one edit per SKU, as designed).

| Feature | free | pro (Personal) | team | enterprise (Business) | Rationale |
|---|---|---|---|---|---|
| Execution profiles (custom) | 1 | unlimited | unlimited | unlimited | Free users get the defaults + one custom; profile power is a solo-upgrade lever |
| **Direct BYOK** | **yes** | yes | yes | yes | **Key decision: BYOK is available on ALL tiers, including Free. BYOK is not a paywall — it is the affordability story.** Charging to use your own key would contradict the product's core economic claim |
| Cost ledger (view) | yes | yes | yes | yes | Honest cost reporting is a product principle, not a feature to sell |
| Cost ledger export (CSV/JSON) | no | yes | yes | yes | Expensing/bookkeeping is a paid workflow |
| Browser automation | yes | yes | yes | yes | Core capability; runs on local/BYOK compute the user already owns |
| Scheduler | no | yes | yes | yes | Existing gate (`scheduler` flag) — unchanged |
| Workflows | limited | yes | yes | yes | Mirrors `maxContextPacks` shape: taste on Free, depth on paid |
| Coding | yes | yes | yes | yes | Table-stakes for the audience; gating it hurts adoption more than it converts |
| Artifacts | yes | yes | yes | yes | Output viewing must never be gated — users own their outputs |
| Cloud execution (future) | — | — | — | — | Deferred entirely; economics gated by Phase H (§7). Will be usage-priced, not a tier flag |

---

## 7. Three-path economics

| Path | Who pays for inference | Artha's cost | Prerequisites |
|---|---|---|---|
| **Direct BYOK** | User pays their provider directly | **Zero infrastructure cost** | None — ships today. The ledger only observes |
| **BYOK cloud proxy** (byoc) | User's key; calls transit an Artha gateway | Gateway compute only (routing, retries, streaming relay) | Gateway service; no billing needed |
| **Managed cloud** | **Artha bears provider costs**, resells | Full provider spend + margin risk | **Phase H gate** — see below |

Managed cloud must not launch before all of the following exist: **metering integrity**
(gateway-measured usage, §8), **margin visibility** (per-request cost vs price, live),
**provider-failure handling** (who eats the cost of a failed/retried upstream call), and
**routing economics** (cheapest-capable-model routing so margin isn't a bet on user
behaviour). Hence managed cloud is a Phase H gate, not a roadmap date.

---

## 8. Metering integrity (future cloud)

Design constraint recorded now so Phase B doesn't paint us into a corner:

- The local `usage_ledger` is **advisory, for the user** — budgets, savings, forensics.
  It lives in a user-writable SQLite file and is trivially tamperable by the machine's
  owner. That is fine: it exists to serve the user, not to bill them.
- **Billing-grade metering must be gateway-side only.** Any paid cloud path measures
  usage at the Artha gateway (request/response token counts observed by infrastructure
  the user cannot modify) and reconciles against provider invoices.
- **Never bill from client-reported numbers.** Client and gateway figures may be
  compared for drift detection and user-facing display, but the gateway number is the
  only billing input. Nothing in the Phase B schema assumes otherwise — `usage_ledger`
  carries no billing semantics and needs none added.

---

## Phase summary

| Phase | Scope |
|---|---|
| **Now (shipped)** | Four-tier offline license, Stripe→key pipeline, doc-cap counter. No metering |
| **Phase B** | `usage_ledger` + capture in `LLMClient`, price registry, cost display, budgets, savings card — all local-only |
| **Phase H (gated)** | Managed cloud: gateway metering, billing, margin/routing economics. Blocked on §7 prerequisites |
