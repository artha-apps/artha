# Phase B — Pluggable Embeddings: Design + Commit Plan

**Status:** design for approval. Roadmap requires "the architecture is approved"
before Phase B builds. Slice 1 (below) is a **behavior-preserving refactor that
crosses no privacy boundary** and is built alongside this doc; **Slice 2 (cloud
embedders) is NOT built and awaits the decisions in §4.**

---

## 1. What exists today (reuse map — verified against the code)

| Fact | Location |
|---|---|
| Single embed function for memories | `contextGather.ts:55` `embedText()` → Ollama `/api/embeddings`, model `nomic-embed-text` |
| **Duplicate** inline embed for RAG docs | `rag/indexer.ts:247` — its own hardwired Ollama call |
| Dimension assumed system-wide | `rag/vectorIntegrity.ts` `EMBED_DIM = 768` |
| Per-index model is stored but unused for routing | `rag_indexes.embedding_model` (default `nomic-embed-text`); **no `dim` column** |
| Invalid-vector invariant already enforced | `vectorIntegrity.isValidVector` (rejects zero/NaN/wrong-dim) |

So embeddings are hardwired to local Ollama nomic-768 in **two** places, and the
whole retrieval path assumes 768 dims.

## 2. The port

```ts
export interface EmbeddingResult { vector: number[]; model: string; dim: number }
export type EmbedOutcome =
  | { ok: true; result: EmbeddingResult }
  | { ok: false; reason: 'unavailable' | 'invalid' | 'error'; detail?: string };

export interface EmbeddingProvider {
  readonly id: string;        // 'ollama:nomic-embed-text'
  readonly model: string;
  readonly dim: number;
  readonly isLocal: boolean;  // true ⇒ on-device, no text leaves the machine
  embed(text: string): Promise<EmbedOutcome>;
}
```

`isLocal` is the privacy-critical property: a `false` provider sends the user's
memory/document text to a third party.

`unavailable` (Ollama down, key missing) is distinct from `error`/`invalid` so
the "no silent degradation" rule can surface the honest reason.

## 3. Why the embedder is a property of the INDEX, not a global setting

A store embedded with nomic (768) **cannot** be queried with OpenAI
`text-embedding-3-small` (1536) — the vectors live in different spaces. So the
query MUST use the same embedder the data was written with. Therefore each RAG
index / memory store records its embedder (`model` + `dim`), and reads route to
THAT embedder. Changing an index's embedder = a full, explicit re-index
(destructive, expensive) — never silent.

## 4. Decisions needed before Slice 2 (cloud embedders)

- **D-B1 — Privacy boundary (the checkpoint).** A cloud embedder sends indexed
  text off-device. Per Artha's principles (local-first, no silent degradation,
  user approval for consequential actions) the proposal is: **local by default;
  a cloud embedder is opt-in per scope, behind a one-time explicit consent
  ("the text in this index will be sent to <provider> to embed"), and the index
  is visibly flagged "cloud-embedded" thereafter.** Approve / amend?
- **D-B2 — Schema.** Add additive `embedding_dim INTEGER` (+ keep
  `embedding_model`) to `rag_indexes`, and record the embedder on the memory
  store. Additive-only migration (same rule as Phase A.5). Approve?
- **D-B3 — Mismatch behavior.** On query/index embedder mismatch: refuse with an
  honest message + offer re-index, never auto-embed into the wrong space. Approve?
- **D-B4 — Slice order.** Slice 1 = port + Ollama impl + dedup the two embed
  sites (no behavior change, no boundary crossed) — built now. Slice 2 = cloud
  provider + D-B1 consent + dim metadata. Slice 3 = routing/economics (usage
  ledger, budgets) — separate. Approve?

## 5. Commit plan

| Slice | Scope | Boundary crossed? | Gate |
|---|---|---|---|
| **1 (now)** | `EmbeddingProvider` port + `OllamaEmbeddingProvider`; route the **memory** embed (`contextGather.embedText`) through it | **No** — still local nomic-768 | none (behavior-preserving) |
| 2 | OpenAI-compat provider; **migrate the indexer** (its per-chunk embed is where per-index embedder routing belongs); per-index `dim`; **D-B1 consent**; mismatch guard. The indexer keeps its timeout + typed `EmbeddingUnavailableError` (pending_embedding state) — so it migrates with per-index routing, not before. | **Yes** (opt-in) | D-B1/D-B2/D-B3 |
| 3 | Hybrid routing policy; usage ledger + budgets + savings card | — | separate design |

Slice 1 establishes the seam so Slice 2 is a small, well-gated addition rather
than another hardwiring to unpick.
