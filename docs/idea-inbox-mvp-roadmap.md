# Idea Inbox · MVP Scope · Roadmap

The single place for **what we're building, what's in/out of scope, and what's
next**. For the full product narrative see [`Artha_PRD_v4.0.md`](./Artha_PRD_v4.0.md)
(§8 Roadmap, §9 Feature Inventory) and the launch-infra plan in
[`../REQUIREMENTS.md`](../REQUIREMENTS.md). For what currently *works*, see
[`feature-deep-dive.md`](./feature-deep-dive.md) and [`DEVELOPMENT_LOG.md`](./DEVELOPMENT_LOG.md).

---

## Vision (one line)

> A **local-first AI agent** that does real knowledge work on your machine —
> document workflows, file tasks, and tool automation — with your data never
> leaving the device.

The defensible bet (see `gtm/` + the competitive analysis): **data sovereignty +
model-agnosticism + audit/provenance** — the category Claude Cowork structurally
can't serve (regulated/privacy-conscious users).

---

## MVP scope

### In scope (the core loop)
- Natural-language task → **ReAct agent** (plan → execute → self-correct) running locally via Ollama.
- **Document generation** (DOCX / PPTX / XLSX / PDF) from a brief, with provenance.
- **Local RAG** over the user's files (Ollama embeddings) + **per-chat folder/file scopes** with a hard filesystem sandbox.
- **MCP tools** (any MCP server = a new capability) + a curated marketplace.
- **Built-in file / web / browser tools.**
- **Privacy by default** — zero telemetry, no account, fully offline after model pull.
- Cross-platform installers + auto-update; a marketing landing page.

### Explicitly out of scope (for now)
- Cloud-hosted inference or a required subscription (cloud models are **opt-in BYOK** only).
- Mobile app (desktop only; LAN companion is a future idea).
- Team SSO / admin console / RBAC beyond the basic LAN team mode.
- Compliance certifications (SOC 2 / HIPAA) — tracked as a business milestone, not code.

---

## Current status (snapshot)

| Area | State |
|---|---|
| Released | **v0.1.1** (public, GitHub Releases). **v0.2.0** prepped (bump + CHANGELOG), tag pending. |
| Core agent, skills, doc gen, RAG, MCP, web/browser, scheduler, memory | ✅ Working |
| Per-chat folder/file scopes + hard sandbox + folder-scoped RAG | ✅ Shipped to `main` |
| Team mode, cloud integrations (Gmail/Cal/Drive), LAN server, parallel subagents | ✅ Working |
| Desktop control (mouse/keyboard/screenshot) | ✅ Opt-in (optional native dep) |
| Tests | 73 passing · typecheck + lint clean |

> Maturity is **early dev** — feature-rich, but not yet exercised at scale or signed/notarized.

---

## Roadmap

### Now (in-flight / next session)
- Ship **v0.2.0** (merge release PR, push tag → installers build).
- Smoke-test per-chat scopes end-to-end on real hardware; `ollama pull nomic-embed-text`.
- UX: **"indexing…" indicator** on folder chips until the RAG index is ready.

### Next (weeks)
- **Code signing / notarization** (macOS Developer ID + Windows) — removes install warnings.
- **Vertical skill bundles** (Legal / Finance / Developer) — curated starter packs.
- **Voice output (TTS)** to complete dictate → act → read-back loops.
- Opt-in **crash reporting** (default OFF) + custom domain for the landing site.

### Later (months)
- **Team tier**: shared memory, roles, LAN server auth hardening, admin console.
- **Cloud sync (opt-in, E2E-encrypted, user-supplied bucket)** for cross-machine continuity.
- **Compliance** (SOC 2 Type II) as a product feature for regulated buyers.
- **Skills marketplace** with creator revenue share.
- **On-prem / Docker** enterprise tier.

---

## Idea Inbox (unsorted backlog)

Raw ideas — not yet committed. Promote to the roadmap when prioritized.

- "Indexing…" / "ready" status badge per folder scope (close the last RAG-readiness gap).
- Scope **rag_search** ranking improvements; show which folder a hit came from in the chat UI.
- Fine-tuning / LoRA on local conversation history ("personalize your model").
- Metrics / eval dashboard (task success rate, per-model quality) from local SQLite.
- Image generation skill; Jupyter notebook read/execute; richer multimodal.
- Mobile companion (connect to desktop over the existing LAN server).
- Desktop control: add an image-matching provider so `desktop_find_on_screen` works.
- Replace the dead `requirement.md` / consolidate older planning docs into this set.
