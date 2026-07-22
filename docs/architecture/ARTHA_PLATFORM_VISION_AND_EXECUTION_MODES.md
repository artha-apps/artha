# Artha Platform Vision & Execution Modes

**Status:** Approved (founder-signed). Phase 0 foundational document.
**Audience:** Internal engineering. This is a decision record, not marketing copy.
**Companion documents:** `ARTHA_PROVIDER_AND_RUNTIME_ARCHITECTURE.md`, `ARTHA_SECURITY_THREAT_MODEL.md`, `ARTHA_AUTOMATION_OBJECT_MODEL.md`, `ARTHA_MONETIZATION_TECHNICAL_FOUNDATION.md`, `ARTHA_PHASED_ROADMAP.md`.

---

## 1. Platform thesis

Artha began as a local AI chat app. It is becoming a **user-controlled AI productivity and execution platform** — a genuine alternative to the combination of ChatGPT/Claude desktop clients, coding agents, schedulers, workflow tools, and browser agents, unified in one shared core.

The defining differentiator is not a model, a UI, or a price point. It is **user control**, concretely over:

- **Where intelligence runs** — on-device, on user-owned infrastructure, or in a cloud the user selected.
- **Which model and provider** — per task, per capability, per profile; never hardwired.
- **Where data is stored** — local SQLite and local files by default; anything else is a choice.
- **What tasks are allowed** — permissions, tool allowlists, and approval gates are first-class.
- **Spend** — budgets, honest cost reporting, and visible per-provider cost.
- **When local vs. cloud** — routing policy is user-set, inspectable, and overridable per message.
- **Which actions need approval** — plan approval, clarification gates, and takeover already exist in the product (`PlanApproval.tsx`, `ClarificationModal.tsx`, browser handoff) and generalize platform-wide.

Every large incumbent optimizes for their cloud, their model, their billing relationship. Artha's bet is that a meaningful segment of individuals and organizations wants the opposite: capable AI execution where the user holds the levers. Everything in this document derives from that bet.

## 2. "Local-first" means local-first, not local-only

**Normative definition.** In Artha:

1. The **application and orchestration run locally** wherever practical. The ReAct loop, context assembly, memory, RAG, scheduling, and tool dispatch live in the Electron main process today (`packages/app/src/agent/`, `src/bodhi/`) and stay device-resident by default.
2. **Data is local by default.** State lives in on-device SQLite (`~/Library/Application Support/Artha/artha.db`) and local files. Nothing syncs anywhere without an explicit act.
3. **Local models are a genuine option, not a demo.** Ollama is a managed runtime today (`src/llm/ollamaRuntime.ts` auto-starts, pre-warms, and pulls the local embedding model); local memory, embeddings, and RAG are the shipping defaults.
4. **Cloud use is explicit and transparent.** When a request leaves the device, the user chose that — via configuration, a routing policy, or a visible per-message action (the existing "Retry on ☁" escalation is the pattern: explicit, audit-logged).
5. **The user chooses the provider.** The core speaks one OpenAI-compatible adapter configured by base URL (`src/llm/client.ts`); providers are data, not code paths.
6. **The user controls what leaves the device.** Scopes, tags, and context-assembly rules gate what can be included in any outbound request (see §10 and `ARTHA_SECURITY_THREAT_MODEL.md`).
7. **Artha stays useful without an Artha cloud account.** No login wall, ever, for local and BYOK operation. Licensing is offline-verified Ed25519 today (`src/license/verify.ts`) and stays that way.

**One shared core.** Execution modes are selectable configurations of a single codebase — never separate forks, never separate "editions" with divergent engines. A feature that cannot work in some mode degrades *visibly* (disabled with an explanation), it is not silently removed or reimplemented in a fork.

### 2.1 Current state, for grounding

The vision above is an extension of what ships, not a rewrite. As of v0.2.0 the codebase already contains the seeds of each pillar:

| Pillar | Exists today (v0.2.0) |
|---|---|
| Local orchestration | ReAct loop, planning, clarification, tool dispatch in the Electron main process (`src/agent/orchestrator.ts`) |
| Local runtime management | Ollama lifecycle owned by Artha — auto-start, model pre-warm, embed-model pull, clean shutdown (`src/llm/ollamaRuntime.ts`) |
| Provider-independent client | One OpenAI-compatible adapter configured by base URL; Ollama, LM Studio, llama.cpp, and cloud providers share it (`src/llm/client.ts`) |
| Local data | SQLite + skills YAML + artifacts + RAG indexes all under the app-data dir; no sync, no account |
| BYOK | Cloud keys configurable in `ModelsPanel.tsx`; models are `llm_models` rows with a `provider` column |
| Explicit escalation | Per-message "Retry on ☁" with audit logging — the prototype of `ask-before-cloud` |
| Task substrate | Bodhi layer: durable `agent_runs`-backed Tasks, capability registry, single executor shared by Chat and Delegate (`src/bodhi/`) |
| Approval & takeover | Plan approval, clarification modal, browser agent/user handoff, desktop-control overlay |
| Credential hygiene | OS-keychain encryption via `safeStorage` (`src/security/secrets.ts`); PII-scrubbed telemetry (`src/sentryScrub.ts`) |
| Routing groundwork | Local model benchmarking + Model Fit scoring (`src/router/benchmark.ts`, `RouterPanel.tsx`) |

What does **not** exist yet, and is committed by this document: execution modes as a named, user-visible concept; execution profiles; hybrid routing policies; tags as routing/eligibility inputs; the Dispatch layer; any Artha-operated cloud component.

## 3. Execution modes

Four modes. All run the same orchestrator, the same object model, the same tool layer. They differ only in where model inference happens and who holds the credentials.

### 3.1 Artha Local

Maximum privacy. Inference via Ollama today, with additional local runtimes (LM Studio, llama.cpp server — already reachable through the single OpenAI-compat adapter) formalized as first-class runtimes per `ARTHA_PROVIDER_AND_RUNTIME_ARCHITECTURE.md`. Memory, embeddings (`nomic-embed-text`), and RAG indexing are fully local. Offline-capable: no network dependency for core chat, memory, RAG, scheduling, or document generation. No Artha cloud account exists or is asked for. This mode is the shipping default and the honesty baseline — every privacy claim Artha makes must be literally true in this mode.

### 3.2 Artha BYOK

The user supplies their own API keys for external providers (OpenAI, Anthropic, Google, etc.). The user pays the provider directly; Artha is not in the billing path. Requirements:

- **Multiple providers concurrently** — keys are per-provider, models are rows (`llm_models.provider`), and different capabilities may be assigned to different providers (coding on one, embeddings on another).
- **Cost visibility** — Artha reports what each request/task/profile costs, from provider-published pricing plus measured tokens. Estimates are labeled as estimates.
- **Per-capability provider assignment** — chat, reasoning, coding, embedding, vision, browser, and tool-calling may each resolve to a different model/provider (see §6).
- Keys are encrypted at rest via OS keychain (`src/security/secrets.ts` pattern) and never appear in logs, telemetry, exports, or the renderer.

### 3.3 Artha Cloud (managed) — **deferred to Phase H**

A managed offering where Artha operates the credentials and infrastructure. **Explicitly deferred** (see `ARTHA_PHASED_ROADMAP.md`). Decisions made now to avoid painting ourselves into a corner:

- When built, it is a **provider-agnostic gateway** — no vendor hardwiring, same adapter contract as everything else.
- **Phase A ships only a reserved enum value** for the mode (and, optionally, a disabled "coming later" onboarding card). **No backend, no endpoints, no account system, no billing integration** is built, stubbed, or mocked before Phase H. Reserving the enum now is purely to keep migrations and profile schemas stable.

### 3.4 Artha Hybrid

Local for routine and sensitive work; cloud for hard reasoning — under user policy, not heuristic vibes. Routing considers **task, capability, sensitivity, latency, and cost**. Named policies (normative vocabulary):

| Policy | Meaning |
|---|---|
| `local-only` | Never route off-device. Cloud-requiring features disable visibly. |
| `prefer-local` | Local unless the local model demonstrably cannot do the task (router-scored, per `src/router/benchmark.ts` lineage). |
| `prefer-cloud` | Cloud by default; local as fallback/offline. |
| `ask-before-cloud` | Any first off-device call in a task requires explicit user approval. |
| `best-within-budget` | Optimize quality subject to a user-set spend cap. |
| `never-send-tagged-sensitive` | Objects carrying designated sensitivity tags are excluded from any cloud-bound context, regardless of other policy (see §10). |
| per-skill model | A skill/capability pins its own model assignment, overriding the profile default. |

Routing inputs, precisely:

- **Task** — what the user asked for (a summary vs. a repo-wide refactor vs. a scheduled digest).
- **Capability** — which capability slot handles it (chat/reasoning/coding/embedding/vision/browser/tool-calling), each with its own model assignment.
- **Sensitivity** — tags/classification on every object entering the context (see §10); the hard gate.
- **Latency** — interactive turns tolerate less than background tasks; profiles state a preference.
- **Cost** — remaining budget and per-provider price; `best-within-budget` optimizes against it.

Policies compose (e.g. `prefer-local` + `never-send-tagged-sensitive` + a budget). Conflicts resolve conservatively: the more restrictive rule wins, and sensitivity exclusions are absolute — no policy combination can override `never-send-tagged-sensitive` for a tagged object. Full resolution semantics live in `ARTHA_PROVIDER_AND_RUNTIME_ARCHITECTURE.md`.

## 4. BYOK vs. BYOC — normative terminology

These terms are **not interchangeable** in code, docs, UI copy, or commit messages:

- **BYOK (Bring Your Own Key):** the user supplies **credentials** for an external provider's public API (an OpenAI key, an Anthropic key). The provider runs the infrastructure.
- **BYOC (Bring Your Own Cloud/Compute):** the user connects **infrastructure they own or control** — a VPC deployment, an Azure OpenAI / AWS Bedrock deployment in their account, a private inference endpoint, an enterprise model gateway. Artha talks to the user's endpoint, not the vendor's public one.

BYOC matters for enterprise (data residency, private networking, existing negotiated contracts) and is architecturally just "BYOK with a user-supplied base URL plus auth scheme" — which is why the single-adapter design must not assume public provider hostnames. Enum values, config keys, and UI labels must use the correct term.

## 5. Three external-provider paths — normative

There are exactly three ways a request can reach an external model provider. Naming them precisely prevents the most dangerous class of architecture drift: quietly routing user credentials or content through infrastructure the user didn't opt into.

**(a) Direct BYOK: device → provider.**
The default desktop mode and the only path that exists today. The key is encrypted on-device; requests go straight from the user's machine to the provider. This path **must keep working when any Artha cloud is down** — no Artha-side dependency may ever be inserted into it.

**(b) Optional BYOK cloud proxy: client → Artha Gateway → provider.**
Permitted **only** for features that genuinely require cloud-side execution: device-independent schedules, cross-device continuity, team-level policy enforcement, cloud workers / hosted browser sessions, durable background execution that must survive the laptop sleeping. Constraints:

- Strictly **opt-in per feature**, never a silent default, never a performance "optimization."
- **Clear disclosure at opt-in**: the user's provider credentials and task content transit Artha infrastructure. This is said plainly, in the consent UI, not buried in a policy page.
- A feature that works via path (a) must not be moved to path (b) for Artha's convenience.

**(c) Artha Managed Cloud: client → gateway → provider on Artha-managed credentials.**
The Phase H managed offering (§3.3). Deferred; listed here only so the taxonomy is complete and stable.

Threat-model treatment of paths (b) and (c) — what Artha infrastructure can see, retention, isolation — is specified in `ARTHA_SECURITY_THREAT_MODEL.md`.

## 6. Execution profiles (concept)

Users should not re-answer "which model, what budget, what leaves the device" per conversation. An **execution profile** is a named, saved bundle of those answers:

- mode (§3) and routing policy (§3.4);
- **per-capability model assignments** — chat, reasoning, coding, embedding, vision, browser, tool-calling;
- fallback chain and escalation policy (when and how to move up-model);
- data rules (tag/sensitivity constraints, what context classes are cloud-eligible);
- budget, latency preference, privacy level, offline behaviour.

Illustrative profiles (names are examples, not a fixed catalog):

| Profile | Mode | Policy sketch | Notes |
|---|---|---|---|
| Private Local | Local | `local-only` | Nothing leaves the device; cloud-requiring features visibly disabled |
| Affordable Daily Use | Hybrid | `prefer-local` + budget | Local for routine turns; small cloud budget for escalation |
| Best Coding | BYOK | per-skill model | Strongest available coding model assigned to the coding capability |
| Research | Hybrid | `best-within-budget` | Web tools on; higher budget; latency deprioritized |
| Sensitive Documents | Hybrid | `never-send-tagged-sensitive` + `ask-before-cloud` | Tagged objects excluded from any cloud-bound context |
| Fast Cloud | BYOK | `prefer-cloud` | Latency-first; local as offline fallback |
| Offline Travel | Local | `local-only`, offline behaviour: queue | Cloud-bound work queues instead of failing |

Profiles attach to workspaces, skills, schedules, and workflows; a schedule can run under a stricter profile than interactive chat. This section fixes the concept and vocabulary only — the schema, resolution order, and switching semantics are specified in `ARTHA_PROVIDER_AND_RUNTIME_ARCHITECTURE.md`.

## 7. Long-term module map

Forward commitments with phase letters (sequencing and gates in `ARTHA_PHASED_ROADMAP.md`). Descriptions are scope statements, not designs.

**Chat (shipped, evolving — Phase A+).** The conversational surface: streaming, attachments, per-chat scopes, @-mentions, Context Packs, clarification and plan approval. Remains the front door, but becomes one client of the shared execution core rather than its owner.

**Workspaces (Phase A–B).** The container object: projects/folders with their own scopes, RAG indexes, default skills, memories, and profiles. Grows out of today's per-folder workspace + Project Context Hub (`src/db/scopes.ts`, `ProjectHome.tsx`) into the primary organizing unit for everything below.

**Cowork (Phase C).** A collaborative task workspace where the user and Artha work a task together with a **visible plan, live progress, approval gates, and instant takeover**. The Delegate room (plan → approve → execute → review, `packages/renderer/src/components/Delegate/`) is the seed; Cowork generalizes it beyond single-shot delegation.

**Scheduler (shipped, evolving — Phase B).** Time-based execution exists today (`src/scheduler/scheduler.ts`, node-schedule). Evolves to run any capability under a designated profile with per-run cost/permission bounds, and to report outcomes as first-class task records.

**Routines (Phase C).** User-defined recurring behaviours above raw cron: "every weekday morning, summarize X and file it in Y" — a schedule plus a capability plus a profile plus output destinations, packaged as one nameable object.

**Tags (Phase B).** Part of the object model, not cosmetic labels. Tags influence **routing, retention, access, and cloud-eligibility** (§3.4's `never-send-tagged-sensitive` depends on them). Defined normatively in `ARTHA_AUTOMATION_OBJECT_MODEL.md`.

**Workflows (Phase D).** Multi-step, multi-capability compositions with explicit data flow between steps, checkpointing, and per-step approval/budget rules. Distinct from Routines (which schedule one capability) and from ad-hoc agent plans (which are ephemeral).

**Dispatch (Phase D).** The task-control and agent-routing layer: accepts tasks from every surface (chat, CLI, scheduler, workflows, LAN), assigns them to capabilities/agents, and enforces **explicit limits on time, cost, tools, retries, and external actions**. There are **no uncontrolled autonomous loops** in Artha — every run is bounded, observable, and stoppable. Builds on the Bodhi task/capability layer (`src/bodhi/tasks.ts`, `capabilities.ts`, `executor.ts`).

**Coding environment (Phase E).** A model-independent, repository-level coding surface: repo understanding, multi-file edits, test/build execution, review flow. Quality claims must be **benchmarked before any parity claim** with incumbent coding agents — measured on real task suites, per §9.

**Artifacts (Phase B–C).** Persistent, versioned outputs — documents, decks, data files, generated code — as durable objects with provenance, not text lost in a chat scrollback. Today's artifacts store + docs generator + provenance receipts (`src/docs/generator.ts`, `ProvenancePanel.tsx`) grow versioning and lineage.

**Design (Phase F, future module).** Visual/design outputs (diagrams, mockups, styled documents). Not being built soon; called out now because the **artifact and workspace architecture must accommodate it** — binary/visual artifact types, preview surfaces, and iteration history must not assume text.

**Browser (Phase C–D).** An execution surface, not a bolt-on tool: the embedded, agent-drivable browser (`src/browser/controller.ts`) with handoff, SSRF guarding, and session objects. Roadmap decisions (hosted sessions, multi-tab agents) live in `ARTHA_PHASED_ROADMAP.md`. Honesty constraints in §10 apply.

**CLI (Phase B).** A first-class command-line client of the same core: start tasks, query status, pipe files, script Artha from the shell. Also the primary answer to "fast invocation" after the wake-word descope (§8).

## 8. Descoped

- **`ollama launch artha` — removed.** Artha invokes Ollama as one runtime among several; Artha is not a subordinate of any runtime, and no runtime's CLI is Artha's entry point. `ollamaRuntime.ts` already embodies the correct direction of control (Artha starts/stops/warms Ollama).
- **"Hey Artha" wake word — moved to distant research.** Hard preconditions before it can even be prototyped for release: fully local wake-word detection, off by default, clearly indicated when listening, formally privacy-reviewed, explicit consent. Until then, **CLI + a global shortcut + OS integrations** are the fast-invocation story.

## 9. Non-negotiable engineering principles

These are constraints on every design and review, not aspirations:

1. **One shared platform, not forks** — modes and tiers are configuration of one codebase.
2. **Provider-independent core** — no provider name in orchestration logic; adapters at the edge only.
3. **Local data ownership by default** — user data lives on the user's device unless the user moves it.
4. **Explicit cloud boundaries** — every off-device transmission is attributable to a user choice.
5. **No silent feature degradation** — if a mode/tier/policy disables something, the UI says so and says why.
6. **No misleading privacy claims** — claims are scoped to what is enforced (see §10).
7. **No plaintext credentials** — at rest, in transit through our code, anywhere.
8. **No secret exposure via logs, telemetry, renderer, exports, IPC, or diagnostics** — secrets stay in the main process, encrypted; every egress surface is a scrub point.
9. **No uncontrolled autonomous execution** — every run is bounded (time/cost/tools/retries), observable, and stoppable.
10. **User-visible permissions and action history** — the tool audit log and execution log patterns extend to every new surface.
11. **Strong rollback and migration** — additive schema migrations; profiles/objects versioned; downgrades don't destroy data.
12. **Measurable quality over parity claims** — "as good as X" requires a benchmark we can publish, or it isn't said.
13. **Modular architecture** — modules in §7 have interfaces, not entanglements.
14. **Testable capability boundaries** — the capability contract (`invoke(capability, input, context)`) stays pure enough to unit-test.
15. **Backward compatibility** — user data, skills, packs, and licenses survive upgrades.
16. **Cross-platform** — macOS, Windows, Linux; no mode is platform-exclusive without a stated reason.
17. **Accessibility** — new surfaces meet keyboard/screen-reader baselines before ship.
18. **Honest cost reporting** — measured tokens × published prices; estimates labeled as estimates.

Several already have enforcement in the codebase (safeStorage-encrypted secrets, PII-scrubbed Sentry `beforeSend` in `src/sentryScrub.ts`, tool audit log, plan approval, additive SQLite migrations). New work is expected to extend those mechanisms, not invent parallel ones.

## 10. Honesty boundaries

Two places where precise language is mandatory because the honest claim is narrower than the tempting one:

**Browser.** The browser may be described as **local** — the engine, orchestration, and session state are on-device. It must **never** be described as private or offline browsing: websites receive the user's requests, IP, and inputs like any browser. "Artha's browser runs locally" is true; "browsing with Artha is private" is not a claim we make.

**Tags and sensitivity.** Enforcement is at **object boundaries** — workspace, project, file, folder, conversation, browser session, task, artifact, pack, memory — applied at **context assembly, before provider transmission** (the `gatherContext` / scope layer is where the gate lives). Derived content (summaries, extracted memories, task results) needs its **own or inherited classification**; a summary of a sensitive document is itself sensitive unless explicitly reclassified. We do **not** claim Artha prevents every derived fact from ever crossing a cloud boundary — a model that saw sensitive context locally may echo facts into an output the user later sends to the cloud. The enforceable guarantee, its limits, and the residual risks are specified in `ARTHA_SECURITY_THREAT_MODEL.md`.

## 11. Decisions recorded

For quick reference in reviews, the normative decisions this document fixes:

| # | Decision | Section |
|---|---|---|
| D1 | Artha is a user-controlled execution platform; user control is the differentiator | §1 |
| D2 | Local-first is defined by the seven properties in §2; local-only is one mode, not the definition | §2 |
| D3 | One shared core with selectable execution modes; forks are prohibited | §2, §9.1 |
| D4 | Four modes: Local, BYOK, Cloud (managed), Hybrid | §3 |
| D5 | Artha Cloud is deferred to Phase H; Phase A ships a reserved enum (+ optional disabled onboarding card) and no backend | §3.3 |
| D6 | Hybrid routing policies use the named vocabulary in §3.4; restrictive rules win; sensitivity exclusions are absolute | §3.4 |
| D7 | BYOK and BYOC are distinct terms and never interchangeable | §4 |
| D8 | Exactly three external-provider paths; direct BYOK must never gain an Artha-side dependency; the BYOK proxy is opt-in with plain disclosure | §5 |
| D9 | Execution profiles are the user-facing bundle of mode/models/policies/budget; details in `ARTHA_PROVIDER_AND_RUNTIME_ARCHITECTURE.md` | §6 |
| D10 | Module map and phase letters in §7 are commitments; sequencing gates in `ARTHA_PHASED_ROADMAP.md` | §7 |
| D11 | `ollama launch artha` is removed; wake word is distant research behind hard preconditions | §8 |
| D12 | The 18 engineering principles in §9 are review-blocking constraints | §9 |
| D13 | Browser is described as local, never as private/offline browsing | §10 |
| D14 | Tag enforcement is at object boundaries during context assembly; no claim about derived facts beyond that | §10 |

---

*Changes to this document require founder approval. Implementation details belong in the companion Phase 0 documents, not here.*
