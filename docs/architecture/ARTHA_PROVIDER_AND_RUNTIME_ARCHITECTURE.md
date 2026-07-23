# Artha Provider & Runtime Architecture

**Status:** Phase 0 decision record — approved direction, implementation staged across Phases A–B.
**Owners:** Core engineering.
**Companions:** [ARTHA_PLATFORM_VISION_AND_EXECUTION_MODES.md](./ARTHA_PLATFORM_VISION_AND_EXECUTION_MODES.md), [ARTHA_SECURITY_THREAT_MODEL.md](./ARTHA_SECURITY_THREAT_MODEL.md), [ARTHA_AUTOMATION_OBJECT_MODEL.md](./ARTHA_AUTOMATION_OBJECT_MODEL.md), [ARTHA_MONETIZATION_TECHNICAL_FOUNDATION.md](./ARTHA_MONETIZATION_TECHNICAL_FOUNDATION.md), [ARTHA_PHASED_ROADMAP.md](./ARTHA_PHASED_ROADMAP.md).

---

## 1. Where we are (current state, verified 2026-07-22)

The good news: Artha already has **one** LLM transport, not N.

- `packages/app/src/llm/client.ts` — a single OpenAI-compatible adapter. Local Ollama gets a native-path override (num_ctx / keep_alive / think); everything else speaks `/v1/chat/completions`.
- `llm_models` (SQLite) — every model is a row: `provider`, `base_url`, `api_key` (sealed at rest as of Phase A commit 1), `context_window`, `is_active`.
- `packages/app/src/llm/providerKind.ts` (Phase A commit 2) — the single classifier for "is this row's lifecycle Ollama-managed?". `ollamaRuntime.ts` (warm-up/unload/auto-start/status) now consults it.
- `getActiveLLMClient()` throws typed `NoModelConfiguredError` instead of inventing a localhost default (Phase A commit 3).

The remaining coupling (the debt this document retires):

| Coupling | Where | Retired in |
|---|---|---|
| Embeddings hardwired to `localhost:11434` + `nomic-embed-text` | `agent/contextGather.ts`, `rag/indexer.ts` | Phase B (embedder abstraction) |
| Router/benchmark iterate local Ollama tags only | `router/benchmark.ts`, `resolveModelName()` in `llm/client.ts` | Phase B (hybrid routing) |
| Aux phases (plan / tool_args / classify) always use the local router even mid-cloud-escalation | `agent/orchestrator.ts` | Phase B (profile role assignments) |
| Provider presets limited to OpenAI / Anthropic / custom; no model discovery, no connection test | `renderer .../ModelsPanel.tsx` | Phase A commits 4–6 |
| Onboarding hardwired to the Ollama flow | `renderer .../Onboarding.tsx` | Phase A commit 7 |
| No usage capture (`usage` discarded on every path) | `llm/client.ts` | Phase B (ledger) |

## 2. The Artha Provider & Runtime SDK (normative principle)

Artha will have a **shared provider and runtime SDK** — plain TypeScript, one package boundary — that can execute in multiple environments:

1. inside Artha Desktop (Electron main),
2. inside the future Artha local headless service,
3. inside the Artha CLI where appropriate,
4. inside an optional Artha Gateway,
5. inside future cloud workers,
6. inside enterprise BYOC deployments.

The SDK is **shared code**. Railway (or any cloud platform) is an optional *deployment environment* for services that use the SDK; it is not the SDK itself.

**The SDK must remain independent of:** Electron, Railway, UI components, the database implementation, a specific secret store, a specific cloud provider, and a specific model vendor.

### 2.1 Injectable interfaces

Everything environment-specific enters through constructor-injected ports. Names are normative; signatures will be refined in the Phase A commit that first extracts each one.

```ts
interface ProviderAdapter        // one per provider family; OpenAI-compat is the default impl
interface RuntimeAdapter         // local runtime lifecycle: discover, health, install/remove, warm/unload
interface SecretStore            // get/set/seal/open; desktop impl = safeStorage envelope (secretString.ts)
interface RequestTransport       // fetch-shaped; lets gateway/workers add pooling, proxies, retries
interface UsageRecorder          // per-call usage events → usage_ledger (desktop) or metering (gateway)
interface CostCalculator         // price registry + estimated-vs-reported labeling
interface CapabilityDetector     // static registry + runtime probes (see §4)
interface ErrorNormalizer        // provider error → { kind, retryable, humanMessage }
interface PolicyEvaluator        // tags/sensitivity/budget/approval decisions (see threat model §4)
interface Router                 // execution-profile-driven model selection per task role
interface AuditSink              // telemetry + audit events; desktop impl = tool_audit_log + Sentry breadcrumbs
```

Extraction strategy: **strangler, not rewrite.** `llm/client.ts`, `providerKind.ts`, `secretString.ts`, and the capability registry are already (or are being written as) electron-light modules; the SDK package boundary is drawn around them when the headless core is extracted (§6). We do NOT create a speculative `packages/sdk` in Phase A — we keep new modules pure and dependency-injected so the later move is mechanical.

## 3. Providers and gateways

### 3.1 First-class adapter roster (Phase A: presets; later: adapters where behavior differs)

| Entry | Kind | Notes |
|---|---|---|
| Ollama | local runtime | today's default; lifecycle via `RuntimeAdapter` |
| Ollama-compatible remote | runtime endpoint | same wire protocol, no local lifecycle |
| OpenAI | cloud provider | |
| Anthropic | cloud provider | OpenAI-compat surface |
| Gemini | cloud provider | OpenAI-compat endpoint |
| OpenRouter | hosted multi-model **gateway** | one key → many models; live pricing API |
| Groq | cloud inference provider | speed tier |
| Moonshot / Kimi | specialist cloud model + provider | |
| DeepSeek | cloud provider | cost tier |
| Mistral | cloud provider | |
| Together | cloud provider | |
| Azure OpenAI | cloud provider (BYOC-adjacent) | deployment-scoped URLs; where practical |
| Custom OpenAI-compatible | escape hatch | covers vLLM, LM Studio, llmster, LocalAI, private endpoints |

### 3.2 What Artha never delegates

External gateways (OpenRouter today; OmniRoute as an optional external gateway / reference implementation) may assist with provider normalization, catalogue discovery, quotas, availability, and provider-level fallback — but they remain **replaceable adapters**. Artha retains ownership of:

local-vs-cloud selection · privacy rules · data-sensitivity decisions · budget enforcement · tool permissions · approval gates · model-role assignments · task decomposition · execution limits · final validation.

### 3.3 The three external-provider paths

1. **Direct BYOK** (default desktop mode): device → provider. Key sealed on device. Must keep working when every Artha cloud service is down.
2. **Optional BYOK cloud proxy**: client → Artha Gateway → provider. Only for features that require cloud execution (device-independent schedules, cross-device usage, shared team policies, cloud workers, cloud browser sessions, durable background execution). Explicit opt-in with plain disclosure: credentials and task content transit Artha infrastructure.
3. **Artha Managed Cloud**: client → gateway → provider on Artha-managed credentials. **Deferred (Phase H).** Phase A footprint: the `execution mode` enum reserves `managed`; nothing else. No billing, no accounts, no backend scaffolding.

## 4. Capability registry

Providers are not interchangeable. A static, versioned registry (data file, not code) records per provider/model family:

chat · reasoning · streaming · tool calling · structured output · embeddings · vision · audio · computer/browser use · context size · max output · usage reporting · prompt caching · batch processing · data-retention options.

Runtime probes **fold into** the registry rather than living as scattered caches — the existing `LLMClient.thinkingUnsupported` set (a 400-triggered "this model can't think" cache) is the proof-of-need and the first probe to migrate. Registry answers are consulted by the Router, by degraded-state UI ("this model doesn't support tool calling — Delegate is unavailable"), and by the mock-provider test fixture (§7).

Rule: **capability logic and entitlement logic never mix.** Capabilities describe what a provider *can* do; entitlements (`license/entitlements.ts`) describe what a tier *may* do.

## 5. Execution profiles

A first-class saved object (new `execution_profiles` table, additive migration) replacing scattered "which model?" decisions:

```
profile_id, name, mode ('local'|'byok'|'byoc'|'managed'|'hybrid'),
chat_model, reasoning_model, coding_model, embedding_model, vision_model,
browser_model, tool_calling_model,           -- each: llm_models.model_id or NULL=inherit chat
fallbacks_json, escalation_policy,           -- 'local_only'|'prefer_local'|'prefer_cloud'|'ask'|'budget'
data_rules_json,                             -- tag/sensitivity constraints (PolicyEvaluator input)
budget_cents_month, latency_pref, privacy_level, offline_behaviour
```

- Phase A commit 9 ships the table plus **one implicit "Default" profile** synthesized from the current active model — existing users migrate invisibly.
- The Router resolves `(profile, task role, capability requirements, policy) → llm_models row`. `resolveModelName()`'s task-type routing and skill `pinnedModel` become inputs to this resolution, not parallel mechanisms.
- Renderer switching UI and multi-profile management land with Phase B routing; Phase A only guarantees the schema and the invisible default.

## 6. Headless-core process boundary (Phase 0 decision)

**Decision:** Artha's domain logic will live in a headless core service; Electron becomes one client of it. We decide the boundary now and migrate incrementally; Phase A implements none of it but every new Phase A module is written core-side-clean (no Electron imports outside designated shims).

| Concern | Decision |
|---|---|
| What stays in Electron | Window/tray/overlay chrome, WebContentsView browser hosting, native dialogs, `safeStorage` access (exposed to the core as a `SecretStore` impl), auto-update, desktop-control (nut-js) |
| What moves to the core | Orchestrator/Bodhi, LLM SDK, MCP registry, RAG/memory, scheduler, LAN hub, license/entitlements, DB access |
| Transport | Local HTTP + NDJSON streaming on a loopback port (the LAN hub already speaks this dialect); IPC channel names preserved via a thin Electron shim so the renderer contract survives the migration |
| AuthN between local processes | Per-install token minted at first run, stored via SecretStore; CLI reads it from the OS keychain / a mode-0600 file fallback |
| Lifecycle | Desktop app owns start/stop of the core in Phase D (spawned child); `artha serve` runs it standalone; OS service integration (launchd/systemd/Windows service) deferred until proven needed |
| Crash recovery | Supervisor in the shell process restarts the core; the core is stateless between requests apart from SQLite (WAL already crash-consistent) |
| Cross-platform | The core is plain Node — no Electron APIs; platform variance is confined to SecretStore + service lifecycle |
| Cloud workers | The same core services run in a container behind the Gateway (this is what replaces the `Dockerfile.hub` xvfb-wrapped-Electron interim hack) |
| Migration path | (1) Phase A–B: new modules electron-free; (2) Phase D: extract core process for CLI + hub; (3) Phase E+: scheduler moves in-core so schedules run with the window closed |

**Consequence for the CLI (binding):** the CLI is designed against the core's local HTTP/NDJSON surface from day one — never against Electron IPC — so extracting the core does not force a CLI rebuild.

## 7. Local runtime strategy

Ollama remains the supported local runtime through Phases A–B; it is a `RuntimeAdapter`, not a synonym for "local".

- **Current coupling:** `ollamaRuntime.ts` (lifecycle), `router/benchmark.ts` (probes), embed model provisioning (`ensureEmbedModel`), model install/remove IPC, ModelsPanel catalog.
- **Target interface (`RuntimeAdapter`):** `discover()` (is the runtime present; which models are installed), `health()`, `ensureModel(name)`, `removeModel(name)`, `warm(model, opts)`, `unload(model)`, `hardware()` (RAM/VRAM/accelerator detection), `normalizeError(err)`.
- **Future seams (reserved, not built):** embedded llama.cpp; MLX / MLX-LM on Apple Silicon; LM Studio / llmster; LocalAI; vLLM-compatible private endpoints — the last three are already reachable today via the custom OpenAI-compatible preset; a full adapter adds lifecycle, not transport.
- **Spikes:** embedded llama.cpp and MLX get technical spikes **after Phase A is stable** — not before.

## 8. Provider test strategy (Phase A commitment)

A mock OpenAI-compatible provider server ships as a vitest fixture (in-process HTTP server) with configurable simulation of: model discovery (`/v1/models`), streaming (SSE), tool calls, structured output, embeddings, vision capability metadata, usage blocks, auth failure (401), rate limits (429 + retry-after), timeouts, malformed output, unsupported parameters (400), provider unavailability (5xx), and partial stream interruption. **Phase A tests must not require live provider keys.** The fixture doubles as the capability-registry conformance harness: a provider preset is "supported" when the adapter passes the fixture matrix that the registry claims for it.

## 9. Decision records

| # | Decision | Rationale |
|---|---|---|
| D-P1 | One OpenAI-compat transport + per-provider presets; adapters only where behavior genuinely differs | The existing single-adapter design is correct; presets are data |
| D-P2 | Provider classification centralized in `providerKind.ts` | Kills the scattered-localhost-checks bug class (commit 2) |
| D-P3 | Scalar secrets sealed via the `v1:` envelope family (`secretString.ts`); the ONLY persistent form is keychain-sealed `v1:enc:` — no base64/raw fallback. No trustworthy keychain (incl. Linux `basic_text`, which uses a static in-binary key) → session-only (in-memory, `v1:session` sentinel) or refuse-with-remediation. Legacy plaintext/raw rows: seal-on-read when possible, locked (typed error) otherwise | One at-rest format; version prefix = key-version hook; reversible-obfuscation persistence prohibited (commits 1 + 3.5) |
| D-P4 | No silent model fallback — typed `NoModelConfiguredError` | Honest empty states over deceptive failures (commit 3) |
| D-P5 | Execution profiles as a table + implicit Default profile | First-class abstraction; invisible migration |
| D-P6 | Capability registry = static data + folded runtime probes | Providers differ; failures should be predicted, not discovered |
| D-P7 | Headless core boundary as specified in §6; CLI never binds Electron IPC | Avoids rebuilding CLI/hub/scheduler after extraction |
| D-P8 | **Browser substrate:** visible layer = Electron `WebContentsView` (existing `BrowserController`); automation layer = CDP via `webContents.debugger`. Playwright is NOT bundled into the desktop app; reserved for a possible future headless browser-worker where it offers a clear operational advantage | Playwright drives out-of-process browsers — wrong shape for a visible, hand-off-able in-app browser; CDP is the same protocol Playwright uses underneath, without a ~150MB dependency or a second browser install |
| D-P9 | Managed-cloud placeholder = reserved enum value only | No speculative backend; provider-agnosticism IS the readiness |
| D-P10 | External gateways (OpenRouter/OmniRoute) are replaceable adapters; the §3.2 ownership list never delegates | User control is the product |
