# Development Log

> **The running, chronological session log lives in [`PROGRESS.md`](./PROGRESS.md).**
> Read that first to see exactly where the last session left off and what's pending.
> This file is the durable index: current snapshot + the key decisions, so they
> don't get buried in the journal.

## Current snapshot

| | |
|---|---|
| Released | **v0.1.1** (public). **v0.2.0** prepped (version bump + `CHANGELOG.md`), tag not yet pushed. |
| Tests | 73 passing · typecheck + lint clean |
| Default agent model | `qwen2.5:7b` (Ollama) · embeddings `nomic-embed-text` |
| Maturity | Early dev — feature-rich, unsigned builds, not yet exercised at scale |

For per-version change history see [`../CHANGELOG.md`](../CHANGELOG.md). For what
each feature does see [`feature-deep-dive.md`](./feature-deep-dive.md).

## Key decisions (durable)

| Decision | Why |
|---|---|
| **Local-first, TypeScript-first** Electron app; no backend | Data sovereignty is the core bet; one runtime, zero cross-language IPC for v1. |
| **Ollama-first**, cloud models opt-in (BYOK) | Privacy by default; model-agnosticism is a moat as open models improve. |
| **Electron pinned to 41.x** | Newest Electron whose V8 `better-sqlite3` compiles against (42 unsupported). Don't bump blindly. |
| **Folders attached per chat** (not a global project switcher) | Matches how users actually scope work; enables a hard per-chat filesystem sandbox. |
| **Per-chat scopes reuse the `projects` table** (deduped by path) | One shared RAG index + cross-session memory per folder, without a parallel schema. |
| **`rag_search` confined to the chat's folders when scoped** | Cowork-style "stay in the approved folder," but keeps semantic vector search. |
| **`@nut-tree-fork/nut-js` as an *optional* dependency** | Original `@nut-tree/nut-js` went private (404) and broke installs; desktop control must never block the core app. |
| **No telemetry by default** | Brand promise; any future reporting must be opt-in with a Settings toggle. |
| **Stay on personal GitHub org for now** | Deferred org migration past launch (note the auto-update-URL caveat). |

## Conventions

- Update [`PROGRESS.md`](./PROGRESS.md) at the end of a working session (it's the resume point).
- Update [`../SITEMAP.md`](../SITEMAP.md) whenever a source file is added/moved/repurposed.
- Add user-facing changes to [`../CHANGELOG.md`](../CHANGELOG.md) under the unreleased/next version.
- Branch off `main`; one PR per cohesive change; tag (`vX.Y.Z`) only when ready to ship.
