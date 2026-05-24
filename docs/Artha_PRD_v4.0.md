# Artha — Product Requirements Document (PRD)

| | |
|---|---|
| **Document** | Artha Master PRD |
| **Version** | v4.0 |
| **Status** | Draft for owner approval |
| **Owner** | Noopur Trivedi |
| **Business Analyst** | Claude (BA engagement) |
| **Date** | 2026-05-24 |
| **Supersedes** | `Artha_PRD_v3.0.docx`, and complements `REQUIREMENTS.md` (launch infra) |
| **Related docs** | `docs/architecture.md`, `docs/PROGRESS.md`, `REQUIREMENTS.md` |
| **Current product version** | v0.1.1 (Electron desktop, shipped & public) |

> **How to read this document.** §1–§6 define *what* Artha is and *why*. §7 defines the **two-plane architecture** that is the backbone of the whole strategy. §8 is the **three-phase roadmap**. §9–§16 are the supporting detail (features, model strategy, enterprise/multi-tenancy, security, monetization, risks). §17 closes every open decision so there are no gaps. A glossary is in §19.

---

## 1. Executive Summary

**Artha** (Sanskrit *अर्थ* — purpose, livelihood, work) is a **local-first AI agent desktop application** that lets a person describe any task in plain English and have it planned, executed, and delivered **entirely on their own machine** — with no data leaving the device by default. It produces real, editable work artifacts (DOCX, PPTX, XLSX, PDF), automates workflows through **MCP tools and IDE integration**, and runs on **local LLMs (Ollama)** out of the box.

Artha's defining promise is **data sovereignty**: *"Your work, done. Locally. Nothing leaves your machine. Ever."* Its second promise is **optionality**: when a user *needs* the cloud — a stronger model, cross-device sync, team features — they can connect to it **from inside Artha**, without abandoning the product or its privacy guarantees for everything else.

This PRD formalises that vision into a **two-plane architecture** (a default-offline **Local Plane** and an opt-in **Cloud Plane**) and a **three-phase roadmap** spanning today's shipped desktop app, near-term polish + cloud connectivity, and a future enterprise / multi-tenant edition that scales to organisations — including **air-gapped, on-premise** deployments.

**The strategic thesis:** Artha does not try to out-feature ChatGPT, Claude, DeepSeek or Genspark on raw model intelligence. It wins where those cloud products *structurally cannot* compete — privacy, cost, ownership, offline capability, and real document output — and serves the large, underserved market of users and organisations that **cannot or will not send their data to a public cloud**.

---

## 2. Vision & Mission

### 2.1 Vision (owner's words, formalised)
> A **local-first** application that can handle **every task on your machine** and **automate anything** — through MCP tools and IDEs — **without sending your data anywhere**, while retaining the **ability to connect to the cloud when a task genuinely requires it**, so users never have to leave Artha to get the job done.

### 2.2 Mission
Give individuals and organisations a **private, ownable AI co-worker** that is powerful enough to replace cloud AI tools for most knowledge work, and honest about the trade-offs (model quality vs. privacy vs. cost) when the cloud is the right call.

### 2.3 Design principles (non-negotiable guardrails)
1. **Local-first is always the default.** Every core capability must work fully offline.
2. **Cloud is always opt-in, never required** for local features, and always behind a feature flag.
3. **Zero telemetry by default.** Any analytics/crash reporting is opt-in and clearly labelled.
4. **No vendor lock-in.** The LLM layer stays a single OpenAI-compatible abstraction; users can point Artha at any model/endpoint.
5. **No mandatory accounts** for local functionality.
6. **Open-core.** The local-first core stays MIT/open-source; commercial value accrues in a separately-licensed Cloud/Enterprise module.

---

## 3. Problem Statement & Market Context

### 3.1 The problem
Knowledge workers increasingly rely on cloud AI (ChatGPT, Claude, DeepSeek, Genspark) for drafting, analysis, and automation. But a large segment **cannot use these tools** for their real work because:
- **Regulatory / contractual constraints** — legal, healthcare, finance, government, defence, and any NDA-bound work prohibit sending data to third-party clouds.
- **Privacy & IP concerns** — sending proprietary documents, source code, or client data to an external model is unacceptable.
- **Cost** — per-seat + per-token cloud pricing is unpredictable and recurring.
- **Connectivity** — field, secure, or air-gapped environments have no public internet.
- **Lack of real artifacts** — cloud chat tools mostly emit text; users still hand-build the DOCX/PPTX/XLSX deliverable.

### 3.2 The opportunity
A desktop AI agent that runs locally, produces finished documents, automates via MCP/IDE, and *optionally* reaches the cloud — directly serving the "can't use the cloud" segment that the incumbents cannot address without violating their own architecture.

### 3.3 Market timing
- Local open models (Llama 3.x, Qwen 2.5, DeepSeek, Mistral) are now strong enough for real work on commodity/enterprise hardware.
- MCP has emerged as a standard tool protocol, making "automate anything" tractable.
- Enterprise demand for **private / on-prem / sovereign AI** is rising sharply.

---

## 4. Target Users & Personas

| # | Persona | Plane | Need | Why Artha |
|---|---|---|---|---|
| P1 | **Privacy-conscious individual** (consultant, lawyer, writer) | Local | Draft & produce documents without leaking client data | Fully local, free, real DOCX/PDF output |
| P2 | **Developer / power user** | Local | Automate file/IDE/MCP workflows on their machine | MCP-native, IDE integration, scriptable skills |
| P3 | **SMB / small team** | Local + light Cloud | Shared skills/templates, occasional stronger model | Local default + BYOK cloud + (later) light sync |
| P4 | **Regulated enterprise** (legal/health/finance) | Cloud Plane (self-hosted / air-gapped) | Org-wide private AI, compliance, central control | On-prem control plane + private model endpoint |
| P5 | **Defence / air-gapped org** | Cloud Plane (air-gapped LAN) | AI with zero public-internet exposure | Air-gapped multi-department deployment |
| P6 | **Platform/IT admin** | Cloud Plane | Deploy, govern, audit Artha across many users | SSO/RBAC, policy, audit, MDM-friendly installers |

---

## 5. Product Overview & Value Proposition

**One-line:** *Artha is a local-first AI co-worker — Claude's Skills + ChatGPT's agent mode + a Microsoft-Office generator — running entirely on your own machine, with optional cloud when you need it.*

**Value proposition by axis:**
- **Privacy / sovereignty** — nothing leaves the device by default; works offline/air-gapped.
- **Cost** — $0 to run on local models; no subscription required.
- **Real output** — editable DOCX/PPTX/XLSX/PDF with provenance and citations.
- **Automation** — MCP tools + IDE integration + embedded browser automate real tasks.
- **Ownership** — open-source core, bring-your-own-model, no lock-in.
- **Optionality** — connect to cloud models/services from inside Artha when a task demands it.

---

## 6. Competitive Analysis

### 6.1 Where Artha wins (the moat)

| Dimension | Artha | ChatGPT / Claude (incl. Cowork) / DeepSeek / Genspark |
|---|---|---|
| Data privacy / sovereignty | Nothing leaves the machine; offline/air-gapped capable | Cloud SaaS; DeepSeek routes data offshore |
| Cost | $0 on local models, no subscription | $20+/seat/mo + usage |
| Output artifacts | Editable DOCX/PPTX/XLSX/PDF, locally | Mostly text/canvas; Genspark cloud-only |
| Ownership / lock-in | MIT core, swap your own model | Closed, account-bound |
| Extensibility | MCP-native + portable skills + IDE | Walled or limited plugin stores |
| Offline | Full functionality offline | None |

### 6.2 Where competitors are ahead (gaps Artha must manage honestly)

| Gap | Impact | Artha's mitigation |
|---|---|---|
| **Frontier model intelligence** | A local 7B model is far weaker than GPT/Claude/DeepSeek-V3 at reasoning/long-context/tool use | Scale to 70B-class on better hardware; BYOK / in-VPC frontier when quality is required |
| **Hardware burden** | Needs Ollama + capable machine; rough first-run if absent | First-run detection, RAM-aware model recommendation, clear install guidance |
| **Multimodal & live web** | No native image/voice/real-time web research | Roadmap item; MCP web tools partially close the gap |
| **Polish / ecosystem / mobile** | Single-dev, desktop-only, no mobile/sync | Focus the moat; phased investment; community + open-core contributors |
| **Collaboration** | Single-user/local today | Cloud Plane (Phase 2/3) adds teams, sharing, sync |
| **Install trust** | Unsigned installers trigger OS warnings | Code signing in Phase 2 |

### 6.3 Strategic posture
**Do not chase feature parity with cloud incumbents.** Win the segment they cannot serve. Treat model-quality gaps as a *configuration* problem (point Artha at a bigger/private model) rather than a product weakness.

---

## 7. Product Architecture — The Two-Plane Model

This is the backbone of the entire strategy. Artha is **two decoupled planes** that communicate only over well-defined interfaces (OpenAI-compatible REST + a thin control-plane API). Either plane can exist without the other.

```
┌─ LOCAL PLANE — offline, default, the moat ───────────────────────┐
│  Electron desktop app (TypeScript: main process + React renderer) │
│   • Ollama (local LLM)     • MCP tools      • IDE integration     │
│   • File/workflow automation • Embedded browser (BrowserView)     │
│   • Local RAG + vector store • Document generation (DOCX/…)       │
│   • SQLite (chat, skills, indexes)   • Zero telemetry             │
│  → Runs with the network cable unplugged. No backend required.    │
└───────────────────────────────────────────────────────────────────┘
                  │  OPT-IN ONLY (feature-flagged)
                  ▼
┌─ CLOUD PLANE — optional; hosted OR self-hosted/air-gapped ───────┐
│  (a) BYOK direct  — app → OpenAI/Anthropic/any OpenAI-compat API │
│  (b) Control plane (Django + Postgres):                           │
│        accounts/SSO · teams/RBAC · per-tenant config · skill/MCP  │
│        catalog · policy · audit · usage metering · billing        │
│  (c) Private model endpoint — vLLM/TGI on org GPU, or in-VPC      │
│        frontier (Azure OpenAI / AWS Bedrock / Google Vertex)      │
│  → Deployable to Railway (cloud) OR the org's own network (LAN).  │
└───────────────────────────────────────────────────────────────────┘
```

### 7.1 Local Plane (always present)
- The shipped desktop app. Self-contained; all sensitive data (documents, chat history, RAG indexes) **stays on the device**.
- **No server is deployed for the Local Plane.** It installs on the user's machine. Django/Railway have **no role here**.

### 7.2 Cloud Plane (optional, three escalating tiers)
- **(a) BYOK (already built).** The app talks **directly** to a cloud model provider using the *user's own* key, stored locally. **Zero infrastructure and zero cost to Artha** — the user pays the provider. This is the cheapest realisation of "connect to cloud when needed."
- **(b) Control plane (new build, Phase 2/3).** A hosted/self-hosted service (recommended stack: **Django + DRF + Postgres**) that owns org-level concerns. Sensitive user data can still stay on-device; the control plane holds config, identity, policy, audit, billing.
- **(c) Private model endpoint.** For stronger/enterprise inference, point the same OpenAI-compatible client at **vLLM/TGI on the org's GPU server**, or an in-VPC frontier model. Changing the model backend is a **base-URL change** — no app rewrite.

### 7.3 Critical clarification — "deploy to Railway offline" is two separate things
- **Railway = cloud** (reachable over the internet). You **cannot** deploy to Railway and be offline.
- **Offline / air-gapped** = the same control-plane code **self-hosted on the org's own network**, never touching the public internet.
- **Resolution:** one Django artifact, two deployment targets — **Railway for hosted users**, **self-hosted on-prem for air-gapped enterprises**. Neither is needed for the default offline desktop experience.

### 7.4 Why Django is *not* in the Local Plane
The Local Plane is TypeScript/Electron with "one runtime, zero cross-language IPC" (`docs/architecture.md`). Adding Python/Django to the desktop app would break that and add complexity. **Django belongs only in the Cloud Plane**, where the desktop app talks to it over REST — so the language boundary never leaks into the client. (Django is a pragmatic choice given existing team familiarity; a Node/TS backend is an acceptable alternative.)

---

## 8. Roadmap — The Three Phases

### Phase 1 — Local-First Desktop (CURRENT, largely shipped)

**Goal:** A free, private, fully-local desktop AI agent, distributed at $0/month.

**Status:** v0.1.0 shipped & public; v0.1.1 polish on `main`. Landing page live on Vercel. 51 tests passing, typecheck clean.

| Item | Status |
|---|---|
| Agentic ReAct loop (plan → execute → self-correct) + streaming | ✅ |
| Document generation (DOCX/PPTX/XLSX/PDF) with provenance | ✅ |
| Local RAG (index folders, real PDF/DOCX/XLSX extraction, incremental, `/ask`, `/report`, citations) | ✅ |
| Skills system (built-ins + `/slug` + auto-match + import/export) | ✅ |
| MCP-native tool system | ✅ |
| Ollama first-class (detect, RAM-aware pull, switch, onboarding) | ✅ |
| BYOK cloud fallback (OpenAI/Anthropic/OpenAI-compat, opt-in) | ✅ |
| Embedded browser + crash recovery | ✅ |
| Docker-sandboxed tool execution | 🚧 |
| Cross-platform installers (mac/win/linux) + auto-update (notify-only) | ✅ |
| Free distribution: GitHub Releases + Vercel landing | ✅ |

**Phase 1 closeout (remaining, free):**
- [ ] Manual smoke test on real hardware (Ollama running) — streaming flicker, skills, RAG citations.
- [ ] Manual confirmation of BrowserView crash-recovery overlay (`chrome://crash`).
- [ ] Finalise IDE integration scope (see §17 D-09).

**Phase 1 cost: $0/month.**

---

### Phase 2 — Polish, Trust & Cloud Connectivity (NEXT, ~4–8 weeks of work)

**Goal:** Remove install friction, add trust signals, and deliver the first real Cloud-Plane connectivity beyond BYOK — without compromising local-first.

**2A — Trust & distribution polish**
- **Code signing & notarization:** Apple Developer Program ($99/yr) + notarization; Windows code signing (Azure Trusted Signing ~$10/mo or OV cert). Removes Gatekeeper/SmartScreen warnings. *(Owner decision pending — see §17 D-01.)*
- **Custom domain** (optional; owner chose to defer — keep `artha-zeta-five.vercel.app` for now).
- **Distribution channels:** Homebrew Cask + winget (free, high power-user reach); Flathub/Snap later.
- **Opt-in telemetry/crash reporting** (Sentry free tier, default OFF, Settings toggle).

**2B — Cloud connectivity (Cloud Plane tier a → light b)**
- Harden **BYOK**: better model picker UX, provider presets, AI-gateway option for failover/cost-tracking.
- **Cloud-Plane MVP (Django on Railway):** optional account, **encrypted cross-device sync** of settings/skills/templates (NOT raw documents by default), and a thin **gateway** for managed model access. All opt-in, feature-flagged.
- Define the **opt-in data contract**: exactly what (if anything) syncs to the cloud, encrypted, user-controlled.

**Phase 2 indicative cost:** ~$229/yr signing+domain + minimal Railway/Postgres (~$5–20/mo only if the hosted Cloud-Plane MVP is enabled).

---

### Phase 3 — Enterprise & Multi-Tenant (FUTURE, demand-gated)

**Goal:** Scale Artha to organisations — including **air-gapped/on-prem** — with central governance, while the data plane stays local-first.

**3A — Enterprise control plane (Django + Postgres)**
- **Identity:** SSO/SAML/OIDC; org → teams → users → roles (**RBAC**).
- **Governance:** centralized model-endpoint config + model allowlists, policy/DLP, **audit logging**, compliance reports.
- **Shared assets:** org skill/MCP catalog, team templates.
- **Deployment:** **MDM-friendly signed installers**, silent install, central config push.
- **Two deployment targets:** Railway (hosted) **or** self-hosted on the org's LAN (**air-gapped**).

**3B — Enterprise model scaling (Ollama → production inference)**
- Swap the **runtime** from Ollama (single-user) to **vLLM / TGI / SGLang / NVIDIA NIM** (high-concurrency, batching) on the org's GPU server, **or** in-VPC frontier (Azure OpenAI / Bedrock / Vertex). Same OpenAI-compatible client → **base-URL change only**.
- Run **70B-class** open models for near-frontier quality on-prem.

**3C — Tenancy model**
- **Single-tenant / dedicated** (one isolated instance per org) — the default and best fit for regulated/air-gapped buyers; lowest build lift; ship **first**.
- **Multi-tenant control plane** (one service, many orgs, isolated by `tenant_id` + Postgres Row-Level Security) — added later for operational leverage and a self-serve tier.
- **Within a single org**, department isolation (Legal/HR/Finance) is delivered via **RBAC + workspaces**, not full multi-tenancy.

**Phase 3 cost:** project/sales-led; infra is per-deployment (customer-hosted for on-prem) — Artha's hosted multi-tenant infra cost scales with adoption.

---

## 9. Feature Inventory & Functional Requirements

### 9.1 Current capabilities (Local Plane)
- **FR-1 Agent loop:** plan → execute → self-correct; streaming token output; plan-approval UI.
- **FR-2 Document generation:** DOCX, PPTX, XLSX, PDF from natural language; provenance engine; `use_rag` grounds reports in indexed files with filename citations.
- **FR-3 Local RAG:** create/rebuild/delete indexes (native folder picker); real PDF/DOCX/XLSX text extraction; boundary-aware chunking; incremental re-index via per-file MD5 manifest; `/ask` Q&A; index-status badge.
- **FR-4 Skills:** `skills` registry; explicit `/slug` or LLM auto-match; instruction injection; optional tool allowlist; built-ins (research, organize, summarize, report, ask); import/export `.artha-skill.json`.
- **FR-5 MCP tools:** any MCP server registered as a tool/skill.
- **FR-6 LLM layer:** single OpenAI-compatible client; Ollama default; switch models; streaming.
- **FR-7 BYOK cloud:** cloud models as `llm_models` rows (OpenAI/Anthropic/custom); opt-in; keys stored locally.
- **FR-8 Onboarding:** detect Ollama; recommend + pull model by RAM with progress; pick installed model.
- **FR-9 Embedded browser:** BrowserView with crash recovery (silent reload → overlay → `browser:recover` IPC).
- **FR-10 Storage:** SQLite (chat history, skills, indexes, models); idempotent migrations/seeds.
- **FR-11 Updates:** `electron-updater` notification-only against GitHub Releases.

### 9.2 Vision capabilities to confirm/expand (gap-closing)
- **FR-12 IDE integration** (vision item): define supported IDEs (e.g., VS Code) and mechanism (MCP server / extension / local socket). **Scope decision required — §17 D-09.**
- **FR-13 "Automate anything" via MCP/IDE:** curated catalog of first-party MCP integrations (filesystem, git/GitHub, calendar, browser, shell-in-sandbox). **Prioritisation required — §17 D-10.**
- **FR-14 Multimodal** (image/voice) — backlog; not committed.

### 9.3 Cloud-Plane functional requirements (Phase 2/3)
- **FR-15 Account & SSO** (opt-in): email/OIDC/SAML; never required for local features.
- **FR-16 Encrypted sync:** settings/skills/templates; raw documents excluded by default; user-controlled scope.
- **FR-17 Org/RBAC:** org → team → user; roles; per-tenant config.
- **FR-18 Central model config:** endpoint URL + allowlist pushed to clients.
- **FR-19 Audit log:** record agent actions/tool calls per policy; exportable.
- **FR-20 Policy/DLP:** restrict tools, models, data egress per org policy.
- **FR-21 Billing/metering:** usage tracking for paid tiers.

---

## 10. Non-Functional Requirements

| ID | Category | Requirement |
|---|---|---|
| NFR-1 | **Privacy** | No data leaves the device unless the user explicitly opts into a cloud feature. Zero telemetry by default. |
| NFR-2 | **Offline** | All Local-Plane features function with no network connectivity. |
| NFR-3 | **Security** | Secure IPC (contextBridge); local key storage; no secrets in repo; signed builds (Phase 2); RBAC + audit (Phase 3). |
| NFR-4 | **Portability** | macOS (arm64+x64), Windows (x64), Linux (deb). OpenAI-compatible model layer for backend portability. |
| NFR-5 | **Performance** | Default to smallest viable model for first-run; streaming UX; high-concurrency via vLLM at enterprise. |
| NFR-6 | **Reliability** | Crash recovery for BrowserView; idempotent DB migrations; release smoke-tests on clean VMs. |
| NFR-7 | **Maintainability** | One runtime in Local Plane; decoupled Cloud Plane; open-core separation. |
| NFR-8 | **Compliance** (Phase 3) | Support air-gapped deployment; audit logs; data-residency via self-hosting; path to SOC 2 for hosted multi-tenant. |
| NFR-9 | **Accessibility/UX** | Clear first-run guidance when Ollama is absent; actionable error states. |

---

## 11. Model Strategy

| Tier | Runtime | Models | Hardware | Use |
|---|---|---|---|---|
| Default (today) | Ollama | 3B–7B (e.g., qwen2.5:7b) | Any modern machine | Individuals, drafting, light tasks, demos |
| Prosumer | Ollama / LM Studio | 14B–34B | 1× strong GPU | Most knowledge work |
| Enterprise on-prem | **vLLM / TGI / NIM** | 70B-class (Llama 3, Qwen 72B, DeepSeek) | Multi-GPU server | Org-wide, high concurrency, near-frontier |
| Enterprise in-VPC | Provider API | Frontier (Azure OpenAI / Bedrock / Vertex) | Org's cloud tenant | Frontier quality + contractual privacy |

**Key finding:** Ollama + a 7B model is **not sufficient** for demanding enterprise work — and Ollama is **not the right runtime** for many concurrent users. The fix preserves privacy: run **bigger models on the org's own hardware via vLLM**, or in-VPC frontier. Because the LLM client is OpenAI-compatible, this is a **configuration change, not a rewrite**. Ollama remains the default for individuals/SMB.

**The enterprise trade-off triangle — pick any two:** *quality · privacy · cost.* Artha supports all three combinations via the same client; the customer chooses.

---

## 12. Enterprise & Multi-Tenancy (detailed)

### 12.1 Can it be multi-tenant while offline?
- **Air-gapped on an internal LAN: YES.** Multi-tenancy needs *a* network, not *the* internet. Self-host the control plane (Django + Postgres) on a server inside the org's network.
- **Single networkless machine: no** — there is nothing central to share.

### 12.2 Reference air-gapped enterprise topology
```
[Company internal network — no public internet]
  ├─ Artha desktop apps        → each employee; documents/RAG stay local
  ├─ Self-hosted control plane  → Django + Postgres; tenants = departments
  └─ Self-hosted model endpoint → vLLM on company GPU server
```

### 12.3 Tenancy decisions
- A per-company air-gapped deployment is **single-tenant by nature** (that org's private instance).
- **Ship single-tenant / self-hosted first** (low lift, high trust, brand-aligned).
- Add **shared multi-tenant control plane** (Postgres RLS / `tenant_id`) later for operational leverage / self-serve.
- Department isolation inside one org = **RBAC + workspaces**, not full multi-tenancy.

### 12.4 Data isolation options (for the hosted multi-tenant control plane)
- **Pooled:** shared DB + `tenant_id` + Row-Level Security (cheapest, standard).
- **Bridge:** schema-per-tenant (more isolation, more ops).
- **Siloed:** DB/instance-per-tenant or fully self-hosted (max isolation; aligns with privacy brand).

---

## 13. Technical Stack & Deployment Summary

| Component | Plane | Tech | Deployment |
|---|---|---|---|
| Desktop app | Local | Electron, TypeScript, React 19, Vite, Tailwind, shadcn, SQLite | Installed per-machine (GitHub Releases) |
| Local inference | Local | Ollama / LM Studio / llama.cpp (OpenAI-compat) | User's machine |
| Landing page | Cloud | Next.js | Vercel (free) |
| Auto-update | Cloud | electron-updater | GitHub Releases |
| Control plane | Cloud | **Django + DRF + Postgres** (recommended) | **Railway** (hosted) **or** self-hosted/on-prem (air-gapped) |
| Enterprise inference | Cloud | vLLM / TGI / NIM (OpenAI-compat) or in-VPC frontier | Org GPU server / org cloud tenant |

---

## 14. Security, Privacy & Compliance

- **Default posture:** zero egress, zero telemetry, local key storage, secure IPC.
- **Distribution trust:** code signing + notarization (Phase 2) to remove OS warnings.
- **Enterprise (Phase 3):** SSO/SAML, RBAC, audit logging, policy/DLP, data residency via self-hosting, air-gapped support.
- **Hosted multi-tenant (future):** tenant isolation (RLS), encryption in transit/at rest, path to SOC 2.
- **Open-source hygiene:** secret scanning + push protection + Dependabot enabled; verify all upstream licences (open-cowork, OpenHands, Jan) remain MIT/Apache-compatible before any relicensing.

---

## 15. Business Model & Monetization (open-core)

| Tier | Audience | Price posture | Hosting cost to Artha |
|---|---|---|---|
| **Community (Local Plane)** | Individuals/devs | Free, MIT | $0 |
| **Pro (Cloud Plane light)** | Prosumers/SMB | Subscription (sync, gateway, support) | Low (Railway + Postgres) |
| **Enterprise (self-hosted)** | Regulated/air-gapped orgs | Per-seat or site licence | $0 infra (customer-hosted) |
| **Enterprise (managed multi-tenant)** | Multiple orgs | SaaS per-seat | Scales with adoption |

**Guardrails:** core stays MIT and local-first by default; commercial features live in a **separate, separately-licensed Cloud/Enterprise module** (open-core). No mandatory account for local use.

---

## 16. Risks & Mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Local model quality disappoints serious users | High | High | Model tiering (§11); BYOK / in-VPC frontier; set expectations |
| Unsigned installers deter adoption | High | Medium | Phase 2 signing; "right-click → Open" FAQ meanwhile |
| Adding Django to Local Plane creates complexity | Medium | High | **Decision: Django stays Cloud-Plane only** (§7.4) |
| Cloud features erode local-first trust | Medium | High | Strict opt-in + feature flags + explicit data contract (NFR-1) |
| Ollama wrong runtime at scale | High (enterprise) | High | Swap to vLLM/TGI; base-URL change only |
| Going repo-private breaks live auto-update/downloads | Medium | High | **Decision: stay public; use open-core** (§17 D-02) |
| Native binding (`better-sqlite3`) breaks on install | Medium | High | Clean-VM release tests; electron-rebuild guidance |
| Single-developer bandwidth | High | Medium | Phase gating; community/open-core contributors; demand-gate Phase 3 |
| Multi-tenant security/compliance burden | Medium | High | Ship single-tenant first; RLS + SOC 2 path before hosted multi-tenant |
| Upstream licence incompatibility | Low | High | Verify licences before relicensing/open-core split |

---

## 17. Decisions Log — Gaps Closed

> This section exists to make the document "spill-proof": every previously-open question is resolved or explicitly owner-pending.

| ID | Decision | Resolution |
|---|---|---|
| D-01 | Code signing | **Owner-pending.** Recommended: macOS ($99/yr) in Phase 2; Windows when adoption justifies. Mandatory for enterprise. |
| D-02 | Repo visibility | **Stay public** (free CI/Releases bandwidth; live auto-update depends on it). Protect value via **open-core**, not privatisation. |
| D-03 | Custom domain | **Deferred** (owner choice): keep `artha-zeta-five.vercel.app`. |
| D-04 | Backend framework | **Django + DRF + Postgres** for the Cloud Plane only (team familiarity). Node/TS acceptable alternative. |
| D-05 | "Railway offline" contradiction | Resolved: **Railway = hosted; air-gapped = self-hosted on-prem.** Same artifact, two targets. |
| D-06 | Does Local Plane need a server? | **No.** Desktop app runs offline; no fly.io/Railway/VPS for Local Plane. |
| D-07 | Is Ollama enough for enterprise? | **No, not as-is.** Use vLLM/TGI + 70B-class or in-VPC frontier; Ollama stays SMB default. |
| D-08 | Multi-tenant + offline | **Yes, air-gapped on LAN.** Single-tenant self-hosted first; multi-tenant hosted later. |
| D-09 | IDE integration scope | **Owner-pending.** Define target IDE(s) + mechanism (MCP/extension). Proposed: VS Code via MCP first. |
| D-10 | First-party MCP catalog priority | **Owner-pending.** Proposed order: filesystem, git/GitHub, browser, shell-in-sandbox, calendar. |
| D-11 | GitHub org migration | **Deferred** but must precede any future ownership change; auto-update URLs are baked per repo. |
| D-12 | Telemetry | **None by default**; opt-in Sentry (default OFF) in Phase 2. |
| D-13 | Sync data contract | **Phase 2 deliverable:** settings/skills/templates only by default; raw documents excluded unless explicitly enabled. |

**Owner action items before committing Phase 2/3:** resolve D-01, D-09, D-10.

---

## 18. Success Metrics (KPIs)

| Phase | Metric | Target (initial) |
|---|---|---|
| 1 | Installs / downloads | Track via GitHub Releases counts |
| 1 | Activation (first successful agent task) | ≥ 50% of first-run users |
| 1 | RAG/doc-gen usage | ≥ 30% of active users try a skill |
| 2 | Install conversion lift after signing | Measure warning-related drop-off reduction |
| 2 | Cloud opt-in rate (BYOK/sync) | Baseline + grow |
| 3 | Enterprise pilots / design partners | ≥ 1–3 signed |
| 3 | Self-hosted deployments | Track per-org |
| All | Privacy incidents (data egress without opt-in) | **0 (hard requirement)** |

---

## 19. Glossary

- **Local Plane** — the offline-by-default desktop app; the core product.
- **Cloud Plane** — the optional, opt-in cloud/server layer (BYOK, control plane, private model endpoint).
- **BYOK** — Bring Your Own Key; user supplies their own cloud model API key, stored locally.
- **Control plane** — server that manages org-level concerns (auth, config, policy, audit, billing), distinct from the data path.
- **MCP** — Model Context Protocol; standard for exposing tools to the agent.
- **ReAct** — Reason+Act agent loop (plan → act → observe → correct).
- **RAG** — Retrieval-Augmented Generation over the user's indexed files.
- **Multi-tenant** — one service instance serving multiple isolated customer orgs.
- **Single-tenant** — a dedicated, isolated instance per org (often self-hosted/air-gapped).
- **Air-gapped** — no public-internet connectivity; may still operate on an internal LAN.
- **RLS** — Row-Level Security (Postgres tenant isolation).
- **vLLM / TGI / NIM** — high-throughput inference servers for production model serving.
- **Open-core** — open-source core + separately-licensed commercial modules.

---

## 20. Approval

Approval authorises Phase 1 closeout and planning of Phase 2. Phase 2/3 spend and the open decisions (D-01, D-09, D-10) require explicit owner sign-off.

| Role | Name | Decision | Date |
|---|---|---|---|
| Owner | Noopur Trivedi | ☐ Approve  ☐ Revise | __________ |
| Business Analyst | Claude | Prepared | 2026-05-24 |

---

*End of document — Artha PRD v4.0.*
