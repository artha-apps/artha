# Artha Phased Roadmap & Traceability

**Status:** Phase 0 decision record. Phases preserve every approved long-term requirement as an explicit commitment or reserved seam — deferral is sequencing, never descoping (the two founder-removed items excepted).
**Companions:** all five other Phase 0 documents in this directory.

---

## 1. Doc governance

Detailed subsystem architecture is written **just in time**, at the start of the phase that implements it: `ARTHA_BROWSER_ARCHITECTURE.md` (start of Phase C), `ARTHA_CLI_ARCHITECTURE.md` (Phase D), `ARTHA_CODING_ARCHITECTURE.md` (Phase F), `ARTHA_ARTIFACT_SYSTEM.md` (Phase G), gateway/managed-cloud design (Phase H). Their binding constraints already decided in Phase 0 live in the provider/runtime doc's decision records (D-P7 headless core, D-P8 browser substrate) and the object-model doc.

## 2. Phases and gates

| Phase | Theme | Ships when |
|---|---|---|
| **0** | Architecture & audit (this doc set) | ✅ done — 6 docs, traceability, headless-core + browser-substrate + SDK decisions |
| **A** | Provider foundation | A new user can choose Local / BYOK / compatible endpoint / configure-later; a BYOK user activates a provider, discovers a model, sees its capabilities, restarts, and continues — no Ollama-specific errors, no insecure key storage, no silent localhost calls, no deceptive feature states. Commits 1–3 shipped; 4–10 planned below |
| **B** | Embeddings, routing, economics | Pluggable embedders + honest degraded states; hybrid routing policies; usage ledger + budgets + savings card |
| **C** | Artha Browser MVP | Secure visible browser (tabs, isolated sessions, per-site permissions), structured automation via CDP, risk-tiered approvals, action log, injection mitigations, browser tests |
| **D** | Headless core + CLI | Core extracted per D-P7; `artha` CLI against the core's HTTP/NDJSON surface; diagnostics (`artha doctor`, `artha status`); Ollama-runtime integration |
| **E** | Automation object model | Tags, approvals, routines, workflows v2, Dispatch — one shared substrate (see object-model doc) |
| **F** | Coding environment | Repo tools, sandboxed terminal, diff/test/checkpoint loop, language intelligence, benchmark suite BEFORE parity claims |
| **G** | Artifacts & Design | Persistent typed artifacts, editors/previews/exports/versions; design-to-code seams |
| **H** | Managed cloud & enterprise BYOC | Only after metering, routing, security, reliability, and unit economics are proven |

Gate rule: a phase starts only when the prior phase's acceptance line is green; cross-phase prep is allowed only as reserved schema/interfaces, never speculative backends.

## 3. Phase A remaining plan (commits 4–10)

| # | Commit | Content |
|---|---|---|
| 4 | Provider preset registry | Data-driven presets: Ollama-remote, OpenAI, Anthropic, Gemini, OpenRouter, Groq, Moonshot/Kimi, DeepSeek, Mistral, Together, Azure OpenAI (where practical), custom. Each: base URL template, key format hint, docs link, capability-registry key |
| 5 | Model discovery + connection test | `GET /v1/models` listing + a one-shot cheap completion probe as IPC (`llm:discoverModels`, `llm:testConnection`); normalized errors (ErrorNormalizer v0). Built against the mock-provider fixture |
| 6 | Mock provider fixture | In-process OpenAI-compat server for vitest per provider-doc §8 (discovery/streaming/tools/usage/401/429/timeouts/malformed/5xx/partial-stream). Lands WITH commit 5's tests; no live keys in CI |
| 7 | Onboarding paths | Four-way first-run choice: Local (existing flow) / BYOK (preset picker → key → discover → test → activate) / Compatible endpoint / Configure later (exits into the honest no_model state from commit 3) |
| 8 | Capability registry v1 | Static data file + folded runtime probes (migrate `thinkingUnsupported`); consumed by ModelsPanel capability chips + degraded-state notices |
| 9 | Execution profiles v0 | `execution_profiles` table + implicit Default profile synthesized from the active model; `getActiveLLMClient` resolves through it; zero visible change for existing users |
| 10 | Degraded-state surfacing | "Semantic memory unavailable — using keyword matching" (contextGather/RAG), capability-missing notices, at-rest-encryption warning card. No silent degradation anywhere reachable in Phase A |

## 4. Traceability matrix (46 feature groups)

Legend — **Status:** ✅ shipped · 🟡 partial · ❌ absent. **Work:** → extend, ＋ create.

| # | Feature group | Status | Existing code / tables | Work | DB impact | Security impact | Tests | Phase |
|---|---|---|---|---|---|---|---|---|
| 1 | Secure credential storage (LLM keys) | ✅ (commit 1) | `security/secretString.ts`, `secrets.ts`; `llm_models.api_key` | → seal `oauth_tokens` next | in-place seal migration | plaintext-at-rest closed; keychain-absent honesty | 12 unit | A |
| 2 | Provider-aware runtime lifecycle | ✅ (commit 2) | `llm/providerKind.ts`, `ollamaRuntime.ts` | → runtime health IPC | provider-id normalization | no false states; no unintended localhost calls | 13 unit | A |
| 3 | Explicit no-model state | ✅ (commit 3) | `NoModelConfiguredError`, `no_model` phase, banner + chat deep-links | → CLI `doctor` reuse later | none | deceptive-failure class closed | 9 unit | A |
| 4 | Provider preset roster | 🟡 (3 presets) | `ModelsPanel.tsx` `CLOUD_PROVIDERS` | ＋ preset registry (data) | none | per-provider disclosure copy | fixture matrix | A |
| 5 | Model discovery + connection testing | ❌ | — | ＋ `llm:discoverModels` / `llm:testConnection` | none | key sent only to its provider | fixture | A |
| 6 | Provider switching UX | 🟡 | ModelPicker, ModelsPanel | → capability chips, test-before-activate | none | — | fixture + unit | A |
| 7 | Onboarding (4 paths) | 🟡 (local only) | `Onboarding.tsx`, `OrgSetup.tsx` | → branch UI; reuse discovery/test | none | key entry in onboarding uses same seal path | e2e-ish unit | A |
| 8 | Capability registry | 🟡 (ad-hoc caches) | `LLMClient.thinkingUnsupported` | ＋ static registry + probe fold-in | none | honest unavailable-feature states | unit + fixture | A |
| 9 | Execution profiles | ❌ | skill `pinned_model`, `router_overrides` as inputs | ＋ `execution_profiles` + resolver | ＋ table, additive | data_rules feed PolicyEvaluator | unit + migration | A/B |
| 10 | Mock provider test fixture | ❌ | — | ＋ vitest in-process server | none | enables no-live-keys CI | is the harness | A |
| 11 | Existing-user migration & backward compat | ✅ pattern | `runMigrations()` additive pattern | → per-commit migrations | additive only | rollback = keys still open via passthrough | migration unit | every |
| 12 | Pluggable embeddings | ❌ (hardwired) | `contextGather.ts`, `rag/indexer.ts`, `rag_indexes.embedding_model` | ＋ `EmbeddingProvider` port; Ollama + OpenAI-compat impls | embedding metadata per index (dim/model) | embeddings may cross cloud boundary → policy-gated | unit + fixture | B |
| 13 | Bundled local embedder | ❌ | — | ＋ ONNX MiniLM spike → impl if size/quality passes | none | keeps memory/RAG fully local without Ollama | quality eval | B |
| 14 | Honest degraded states | 🟡 (silent zero-vectors) | indexer zero-vector fallback | → surfaced states everywhere | none | "no silent degradation" principle | unit + visual | A(10)/B |
| 15 | Hybrid routing policies | ❌ (one-shot escalate) | `resolveModelName`, `modelOverride`, "Retry on ☁" | ＋ Router over profiles; policy enum incl. ask-before-cloud | profile columns | cloud-eligibility enforcement point | unit | B |
| 16 | Data-sensitivity routing (tags) | ❌ | — | ＋ PolicyEvaluator at context assembly | tags tables (see #33) | THE cloud-boundary control; honest limits per threat model | unit | B/E |
| 17 | Token/usage capture | ❌ (usage discarded) | `llm/client.ts` all 4 paths | → read `usage` / eval counts | ＋ `usage_ledger` | local-only; no telemetry without consent | unit + fixture | B |
| 18 | Cost ledger + price registry | ❌ | — | ＋ registry (static + user override + OpenRouter API); ledger UI | price table (data file) | estimates labeled honestly | unit | B |
| 19 | Budgets | ❌ | — | ＋ enforcement pre-dispatch + mid-run | profile budget col | pause+ask on breach, never silent | unit | B |
| 20 | Savings comparison card | ❌ | — | ＋ monthly aggregate vs reference prices | view over ledger | reference prices dated, maintained | unit | B |
| 21 | Visible browser (tabs, chrome) | 🟡 (single view) | `BrowserController`, BrowserPane/Toolbar/Resizer | → tab model, downloads/uploads, history controls | browser_sessions table | see threat model §6 | Playwright-driven UI tests against app | C |
| 22 | Browser automation layer | 🟡 (basic actions) | `browser/actions.ts`, `tools/browser.ts` | ＋ CDP via `webContents.debugger`: a11y snapshots, structured DOM, element selection, form fill (D-P8) | none | layered injection mitigation | browser tests | C |
| 23 | Session isolation & logins | ❌ | single session | ＋ per-workspace persistent + ephemeral sessions/partitions | session registry | cookie/permission mgmt; user-controlled | browser tests | C |
| 24 | Per-site permissions & domain policies | ❌ | SSRF guard only | ＋ domain policy store + permission interception | policy table | navigation validation, download controls | browser tests | C |
| 25 | Risk-tiered approvals | 🟡 (tool approval modal) | `ToolApprovalModal`, `tool_policies` | ＋ 4-tier action classes (read/reversible/external-comms/consequential) | ＋ `approvals` (see #33) | purchases/financial/destructive = immediate confirm | unit + browser | C |
| 26 | Prompt-injection mitigations (browser) | 🟡 (overlay, handoff) | `controlOverlay.ts`, HandoffBanner | ＋ content/instruction separation, action gating, evidence capture | none | documented as risk reduction, not prevention | red-team suite | C |
| 27 | Action history & emergency stop | 🟡 (audit log, stop) | `tool_audit_log`, stop button | → browser action timeline + panic stop | audit columns | user-visible history principle | browser tests | C |
| 28 | Research workflow & context capture | 🟡 (readability, citations) | `readability.ts`, Citations, web cache | → save-to-memory/pack from browser; multi-page research | provenance links | provenance preserved | unit | C |
| 29 | Headless core extraction | ❌ (decided) | LAN hub HTTP+NDJSON dialect; electron-free new modules | ＋ core process per D-P7 | none | local-process auth token | integration | D |
| 30 | Artha CLI | ❌ | — | ＋ `artha` command set (ask/chat/run/schedule/models/profile/status/doctor/serve/stop/memory/artifacts/dispatch); JSON + streaming output, exit codes, completions | none | permission enforcement parity with desktop | CLI integration | D |
| 31 | Local service authentication | ❌ | LAN Bearer pattern | ＋ per-install token via SecretStore | token storage | 0600 fallback file; never plaintext-world-readable | unit | D |
| 32 | OS integrations (shortcut, menu-bar, deep links) | ❌ | tray exists | ＋ global shortcut, "Ask Artha" entry points, deep links | none | wake-word explicitly OUT (research item) | manual + unit | D |
| 33 | Tags & approvals object model | ❌ | — | ＋ `tags`, `tag_assignments`, `approvals` per object-model doc | ＋ 3 tables | routing/retention/cloud-eligibility semantics | unit | E |
| 34 | Scheduler upgrades | 🟡 (cron + one-shot) | `scheduler.ts`, `scheduled_tasks` | → missed-run, retries, budgets, approvals, awake-requirements, durable queue | columns on `scheduled_tasks` | unattended runs respect policies | unit | E |
| 35 | Routines | ❌ | skills + scheduler + packs as ingredients | ＋ routine object composing them | ＋ `routines` | approval requirements honored | unit | E |
| 36 | Workflows v2 | 🟡 (primitive templates) | `workflow_templates` | → versioned graph: conditions/loops/approvals/error branches/dry-run/schemas/cost estimates/import-export | ＋ `workflow_versions` | secrets in workflows via SecretStore | unit | E |
| 37 | Dispatch | 🟡 (Bodhi seed) | `bodhi/*` (capabilities, tasks, executor, operator), `runChildCapability`, `runParallel` | → classify→select→decompose→limits→validate pipeline | task limit columns | explicit time/cost/tool/retry/external-action limits | unit | E |
| 38 | Coding: repo intelligence | 🟡 (fs tools, IDE panel, Code tab) | filesystem tools, `IDEIntegrationPanel`, scopes/RAG | ＋ git awareness, code search, LSP/AST, dependency graph | repo index tables | approval policies per edit mode | unit | F |
| 39 | Coding: sandboxed execution | ❌ | — | ＋ sandboxed terminal, test/build/lint loops, checkpoints/rollback | run records | command sandbox = hard security boundary | unit + sandbox escapes | F |
| 40 | Coding benchmarks | ❌ | — | ＋ suite: bugfix/feature/refactor/tests/multi-file/build-recovery/security/frontend/backend/migrations | results store | no parity claims before results | the suite | F |
| 41 | Artifacts v2 | 🟡 (files + panel) | `artifacts`, `generated_documents`, docs generator, ProvenancePanel | → typed versioned artifacts: preview/edit/export/regenerate/comments/access/tags | version + provenance columns | access controls; provenance | unit | G |
| 42 | Design module | ❌ (seam only) | artifact system accommodates | ＋ later per vision doc | — | — | — | G |
| 43 | BYOK cloud proxy (Gateway) | ❌ | — | ＋ Artha Gateway using the SDK; explicit disclosure UX | server-side | credentials transit disclosure; gateway-side metering | integration | H |
| 44 | Managed cloud | ❌ (enum reserved) | — | ＋ accounts/plans/credits/routing economics | server-side | billing-grade metering gateway-side only | integration | H |
| 45 | Enterprise BYOC | 🟡 (org hub interim) | `Dockerfile.hub`, org-hub runbook, license tiers | → core-service container replaces xvfb hack; VPC/private endpoints; SSO/residency | server-side | RBAC (exists as flag), audit export | integration | H |
| 46 | Team/Business admin | 🟡 (shipped basics) | LAN hub, seats, shared memory/packs, `TeamPanel`, RBAC flag | → central policy controls, approved-provider lists | policy tables | admin-set provider allowlists | unit | E/H |

## 5. Residual assumptions register (to burn down; verified 2026-07-22)

Every place the code still assumes the old world. Each entry names its retirement phase.

**Ollama-as-synonym-for-local / localhost:**
- `agent/contextGather.ts` — `OLLAMA_EMBED_URL` + `nomic-embed-text` hardwired (B)
- `rag/indexer.ts` — same, plus zero-vector silent fallback (B, surfaced in A commit 10)
- `router/benchmark.ts` — probes `localhost:11434` only; cloud models unbenchmarkable (B)
- `llm/client.ts` `resolveModelName()` — smallest-local-model fallback queries `provider='ollama'` only (B)
- `ollamaRuntime.ensureEmbedModel` — Ollama-only embed provisioning (B)
- `scheduler.ts` health check — probes local Ollama regardless of active provider (B/E)
- ModelsPanel cloud/local split by base_url substring (`localhost`) rather than `providerKind` (A commits 4–6)

**Local planner during cloud runs:** `orchestrator.ts` — `generatePlan`/`runThinkPhase`/`classifyIntent`/`detectClarificationNeeded` call `getActiveLLMClient(undefined, taskType)` with no override, so a cloud-escalated run still plans locally with no indication (B: profile role assignments).

**Single active model / single provider:** `llm_models.is_active` as a global singleton; per-skill `pinned_model` and `router_overrides` as uncoordinated exceptions (A commit 9 → B: profiles subsume).

**Electron as the only process host:** `Dockerfile.hub` (xvfb-wrapped Electron); scheduler dies with the window; LAN hub lives inside the app process; `getDb()` bound to `app.getPath` (D: headless core per D-P7).

**Landing/marketing:** BYOC/BYOK story absent from `landing/` copy — no code dependency, flagged for post-Phase-B packaging work (per directive: GTM documents unchanged until architecture + packaging recommendations complete).

## 6. Preserved future commitments

One shared local-and-cloud core · Local execution · Direct BYOK · Optional BYOK cloud proxy · Enterprise BYOC · Artha Managed Cloud · Hybrid routing · Artha Browser · Artha CLI · Scheduler · Routines · Tags · Workflows · Dispatch · Coding · Artifacts · Design — all present above with an owner phase; none descoped. Removed by founder direction: `ollama launch artha` (permanently), "Hey Artha" wake word (distant research item, preconditions in the vision doc).
