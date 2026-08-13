/**
 * Embedding provider port (Phase B, Slice 1).
 *
 * Embeddings were hardwired to local Ollama `nomic-embed-text` in two places
 * (contextGather.embedText for memories, indexer for RAG docs). This introduces
 * the seam so a second embedder (a cloud OpenAI-compat one) can be added later
 * as a small, policy-gated addition instead of unpicking hardwiring again.
 *
 * Slice 1 is behavior-preserving: the ONLY provider is the local Ollama one, so
 * nothing crosses the privacy boundary. `isLocal` is the property Slice 2's
 * consent gate will read — a `false` provider sends the user's indexed text
 * off-device, which must be explicit (see ARTHA_PHASE_B_EMBEDDINGS_DESIGN.md).
 */
import { isValidVector } from './vectorIntegrity';

export interface EmbeddingResult {
  vector: number[];
  model: string;
  dim: number;
}

export type EmbedOutcome =
  | { ok: true; result: EmbeddingResult }
  /** unavailable: the embedder can't be reached (Ollama down, key missing) —
   *  distinct from a real error so degraded states stay honest. */
  | { ok: false; reason: 'unavailable' | 'invalid' | 'error'; detail?: string };

export interface EmbeddingProvider {
  /** Stable id, e.g. 'ollama:nomic-embed-text'. */
  readonly id: string;
  readonly model: string;
  readonly dim: number;
  /** true ⇒ runs on-device, no text leaves the machine. The privacy-critical
   *  flag Slice 2's consent gate keys on. */
  readonly isLocal: boolean;
  embed(text: string): Promise<EmbedOutcome>;
}

const OLLAMA_EMBED_URL = 'http://localhost:11434/api/embeddings';

/** The local Ollama embedder — Artha's default, entirely on-device. */
export class OllamaEmbeddingProvider implements EmbeddingProvider {
  readonly isLocal = true;
  readonly id: string;
  constructor(
    readonly model: string = 'nomic-embed-text',
    readonly dim: number = 768,
    private readonly url: string = OLLAMA_EMBED_URL,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.id = `ollama:${model}`;
  }

  async embed(text: string): Promise<EmbedOutcome> {
    let json: { embedding?: number[] };
    try {
      const res = await this.fetchImpl(this.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: this.model, prompt: text }),
      });
      if (!res.ok) return { ok: false, reason: 'unavailable', detail: `HTTP ${res.status}` };
      json = (await res.json()) as { embedding?: number[] };
    } catch (e) {
      // Connection refused / DNS / offline ⇒ the embedder is unavailable, not a
      // logic error. Callers surface a degraded state rather than a crash.
      return { ok: false, reason: 'unavailable', detail: e instanceof Error ? e.message : String(e) };
    }
    // Never accept a knowingly-bad vector (empty / all-zero / NaN / wrong dim).
    if (!isValidVector(json.embedding, this.dim)) return { ok: false, reason: 'invalid' };
    return { ok: true, result: { vector: json.embedding, model: this.model, dim: this.dim } };
  }
}

/**
 * A cloud OpenAI-compatible embedder (OpenAI, Together, Groq, … — anything that
 * speaks the `/embeddings` endpoint). `isLocal = false`: calling it SENDS the
 * given text to a third party. It therefore must only ever be reached through
 * the consent-gated resolver (see resolveEmbeddingProvider / D-B1) — never made
 * the default. The API key is passed in already-resolved (the caller opens the
 * sealed BYOK key via usableApiKey); this class never touches storage.
 */
export class OpenAiEmbeddingProvider implements EmbeddingProvider {
  readonly isLocal = false;
  readonly id: string;
  constructor(
    readonly model: string,
    readonly dim: number,
    private readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.id = `cloud:${model}`;
  }

  async embed(text: string): Promise<EmbedOutcome> {
    let json: { data?: { embedding?: number[] }[] };
    try {
      const res = await this.fetchImpl(`${this.baseUrl.replace(/\/$/, '')}/embeddings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.apiKey}` },
        body: JSON.stringify({ model: this.model, input: text }),
      });
      if (res.status === 401 || res.status === 403) return { ok: false, reason: 'unavailable', detail: 'auth rejected' };
      if (!res.ok) return { ok: false, reason: 'unavailable', detail: `HTTP ${res.status}` };
      json = (await res.json()) as { data?: { embedding?: number[] }[] };
    } catch (e) {
      return { ok: false, reason: 'unavailable', detail: e instanceof Error ? e.message : String(e) };
    }
    const vec = json.data?.[0]?.embedding;
    if (!isValidVector(vec, this.dim)) return { ok: false, reason: 'invalid' };
    return { ok: true, result: { vector: vec, model: this.model, dim: this.dim } };
  }
}

/**
 * The active embedder. Slice 1: always the local Ollama provider — there is no
 * cloud embedder yet, so this can never route indexed text off-device. Slice 2
 * will resolve per-index (an index is queried with the embedder it was written
 * with) behind the D-B1 consent gate.
 */
let activeProvider: EmbeddingProvider = new OllamaEmbeddingProvider();

export function getActiveEmbeddingProvider(): EmbeddingProvider {
  return activeProvider;
}

/** Test/di seam. Not used in production yet (Slice 1 has one provider). */
export function setActiveEmbeddingProvider(p: EmbeddingProvider): void {
  activeProvider = p;
}

/** What an index/store was embedded WITH. */
export interface EmbedderIdentity { model: string; dim: number }

/**
 * Thrown by the query path when an index's vector space doesn't match the
 * active embedder (D-B3). Carries the index name so multi-index search can
 * report WHICH index needs re-indexing instead of silently skipping it.
 */
export class EmbedderMismatchError extends Error {
  readonly code = 'EMBEDDER_MISMATCH';
  constructor(readonly indexName: string, reason: string) {
    super(reason);
    this.name = 'EmbedderMismatchError';
  }
}

export type MatchResult =
  | { ok: true }
  | { ok: false; reason: string };

/**
 * D-B3: may `provider` be used to query data that was embedded with `built`?
 * Only if the vector spaces match — SAME dimension AND same model. A 768-dim
 * nomic index searched with a 1536-dim cloud embedder would return garbage
 * similarities, so we refuse with an honest message rather than embed the query
 * into the wrong space. Pure — the query path calls this before embedding.
 */
/** Result of a pre-consent connectivity probe. */
export type EmbedProbeResult = { ok: true; dim: number } | { ok: false; error: string };

/**
 * One live /embeddings call made BEFORE cloud-embedding consent is recorded
 * (test-before-activate — the same pattern BYOK chat models use). Sends only a
 * fixed harmless sentence, never user content, so nothing private crosses the
 * boundary during the probe. On success returns the model's ACTUAL dimension,
 * derived from the response and never guessed — that value is what gets stored
 * on the consent record and later stamped on each index row (D-B2).
 */
export async function probeCloudEmbedding(
  baseUrl: string, apiKey: string, model: string, fetchImpl: typeof fetch = fetch,
): Promise<EmbedProbeResult> {
  let json: { data?: { embedding?: unknown }[] };
  try {
    const res = await fetchImpl(`${baseUrl.replace(/\/$/, '')}/embeddings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model, input: 'Artha embedding connectivity test.' }),
    });
    if (res.status === 401 || res.status === 403) return { ok: false, error: 'The provider rejected the API key.' };
    if (res.status === 404) return { ok: false, error: `The provider does not offer an embedding model named "${model}".` };
    if (!res.ok) return { ok: false, error: `The embedding endpoint returned HTTP ${res.status}.` };
    json = await res.json() as { data?: { embedding?: unknown }[] };
  } catch {
    return { ok: false, error: 'Could not reach the embedding endpoint.' };
  }
  const vec = json.data?.[0]?.embedding;
  if (!Array.isArray(vec) || vec.length === 0 ||
      !vec.every(x => typeof x === 'number' && Number.isFinite(x)) ||
      vec.every(x => x === 0)) {
    return { ok: false, error: 'The embedding response was empty or invalid.' };
  }
  return { ok: true, dim: vec.length };
}

export function embedderMatchesIndex(built: EmbedderIdentity, provider: EmbeddingProvider): MatchResult {
  if (built.dim !== provider.dim) {
    return { ok: false, reason:
      `This index was built with ${built.model} (${built.dim}-dim) but the active embedder is ` +
      `${provider.model} (${provider.dim}-dim). Searching across different embedders returns ` +
      `meaningless results — re-index this folder with the current embedder to search it.` };
  }
  if (built.model !== provider.model) {
    return { ok: false, reason:
      `This index was built with ${built.model}, but the active embedder is ${provider.model}. ` +
      `Re-index with the current embedder to search it reliably.` };
  }
  return { ok: true };
}
