/**
 * Capability registry v1 (Phase A commit 9) — what each provider CAN do.
 *
 * Two layers, merged by `getEffectiveCapabilities`:
 *   1. STATIC provider-level defaults (data below, keyed by the preset's
 *      `capabilityKey`) — coarse, honest values: 'yes' | 'no' | 'varies'
 *      (model-dependent) | 'unknown' (custom endpoints).
 *   2. RUNTIME PROBES — facts learned from real responses (e.g. a model
 *      400-ing on `think: true`). This absorbs the old ad-hoc
 *      `LLMClient.thinkingUnsupported` set; new probe kinds fold in here
 *      instead of growing new scattered caches.
 *
 * Consumers: ModelsPanel capability chips, degraded-state notices ("this
 * model can't call tools — Delegate unavailable"), and the Phase B router.
 * Capability logic NEVER mixes with entitlement logic (license/entitlements
 * describes what a TIER may do; this describes what a PROVIDER can do).
 */

export type CapTri = 'yes' | 'no' | 'varies' | 'unknown';

export interface ProviderCapabilities {
  chat: CapTri;
  streaming: CapTri;
  toolCalling: CapTri;
  structuredOutput: CapTri;
  /** Separate reasoning/thinking channel (o-series, R1, Claude thinking…). */
  reasoning: CapTri;
  /** Embeddings endpoint available on the same base URL/key. */
  embeddings: CapTri;
  vision: CapTri;
  audio: CapTri;
  /** Computer/browser-use style agentic control models. */
  computerUse: CapTri;
  /** Does the API report token usage on responses? (Phase B ledger source.) */
  usageReporting: CapTri;
  promptCaching: CapTri;
  batchProcessing: CapTri;
  /** Honest one-liner about data retention / training defaults. */
  dataRetentionNote: string;
}

const BASE: ProviderCapabilities = {
  chat: 'yes', streaming: 'yes', toolCalling: 'varies', structuredOutput: 'varies',
  reasoning: 'varies', embeddings: 'no', vision: 'varies', audio: 'no',
  computerUse: 'no', usageReporting: 'yes', promptCaching: 'no', batchProcessing: 'no',
  dataRetentionNote: 'Check the provider’s current data-use policy.',
};

/** Static registry keyed by ProviderPreset.capabilityKey. DATA — reviewed,
 *  not guessed at runtime. 'varies' means: depends on which model you pick. */
export const PROVIDER_CAPABILITIES: Record<string, ProviderCapabilities> = {
  openai: {
    ...BASE, toolCalling: 'yes', structuredOutput: 'yes', reasoning: 'varies',
    embeddings: 'yes', vision: 'varies', audio: 'varies', computerUse: 'varies',
    promptCaching: 'yes', batchProcessing: 'yes',
    dataRetentionNote: 'API data is not used for training by default; retention per OpenAI policy.',
  },
  anthropic: {
    ...BASE, toolCalling: 'yes', structuredOutput: 'yes', reasoning: 'varies',
    vision: 'yes', computerUse: 'varies', promptCaching: 'yes', batchProcessing: 'yes',
    dataRetentionNote: 'API data is not used for training by default; retention per Anthropic policy.',
  },
  gemini: {
    ...BASE, toolCalling: 'yes', structuredOutput: 'yes', reasoning: 'varies',
    embeddings: 'yes', vision: 'yes', audio: 'varies', promptCaching: 'yes', batchProcessing: 'yes',
    dataRetentionNote: 'Paid-tier API data is not used to improve models; free tier differs — check Google’s policy.',
  },
  openrouter: {
    ...BASE, toolCalling: 'varies', structuredOutput: 'varies', reasoning: 'varies',
    vision: 'varies', usageReporting: 'yes',
    dataRetentionNote: 'A gateway: retention depends on OpenRouter AND the underlying provider you route to.',
  },
  groq: {
    ...BASE, toolCalling: 'yes', structuredOutput: 'varies', vision: 'varies',
    dataRetentionNote: 'Check Groq’s current data-use policy.',
  },
  moonshot: {
    ...BASE, toolCalling: 'yes', structuredOutput: 'varies', reasoning: 'varies', vision: 'varies',
    dataRetentionNote: 'Check Moonshot’s current data-use policy.',
  },
  deepseek: {
    ...BASE, toolCalling: 'yes', structuredOutput: 'varies', reasoning: 'varies',
    promptCaching: 'yes',
    dataRetentionNote: 'Check DeepSeek’s current data-use policy.',
  },
  mistral: {
    ...BASE, toolCalling: 'yes', structuredOutput: 'yes', embeddings: 'yes', vision: 'varies',
    batchProcessing: 'yes',
    dataRetentionNote: 'Check Mistral’s current data-use policy.',
  },
  together: {
    ...BASE, toolCalling: 'varies', structuredOutput: 'varies', embeddings: 'yes', vision: 'varies',
    batchProcessing: 'yes',
    dataRetentionNote: 'Check Together’s current data-use policy.',
  },
  'azure-openai': {
    ...BASE, toolCalling: 'yes', structuredOutput: 'yes', embeddings: 'yes', vision: 'varies',
    promptCaching: 'yes', batchProcessing: 'yes',
    dataRetentionNote: 'Runs in YOUR Azure tenancy — retention is governed by your Azure configuration.',
  },
  ollama: {
    ...BASE, toolCalling: 'varies', structuredOutput: 'varies', reasoning: 'varies',
    embeddings: 'yes', vision: 'varies', usageReporting: 'yes',
    dataRetentionNote: 'Local: prompts and outputs never leave this machine.',
  },
  custom: {
    ...BASE, chat: 'yes', streaming: 'varies', toolCalling: 'unknown', structuredOutput: 'unknown',
    reasoning: 'unknown', embeddings: 'unknown', vision: 'unknown', usageReporting: 'unknown',
    dataRetentionNote: 'Unknown endpoint — retention depends on whoever operates it.',
  },
};

// ── Runtime probes ─────────────────────────────────────────────────────────
// Facts learned per MODEL from live responses. Process-lifetime (same
// semantics as the old thinkingUnsupported set); persisting to model_profiles
// is a Phase B follow-up alongside router integration.

export type ProbeKind = 'thinking' | 'toolCalling';

const unsupported = new Map<ProbeKind, Set<string>>();

export function markUnsupported(kind: ProbeKind, model: string): void {
  if (!unsupported.has(kind)) unsupported.set(kind, new Set());
  unsupported.get(kind)!.add(model);
}

export function isUnsupported(kind: ProbeKind, model: string): boolean {
  return unsupported.get(kind)?.has(model) ?? false;
}

/** Test hook. */
export function clearProbes(): void {
  unsupported.clear();
}

/** Static provider defaults overlaid with per-model probe facts. */
export function getEffectiveCapabilities(capabilityKey: string, model?: string): ProviderCapabilities {
  const base = PROVIDER_CAPABILITIES[capabilityKey] ?? PROVIDER_CAPABILITIES.custom;
  if (!model) return base;
  const out: ProviderCapabilities = { ...base };
  if (isUnsupported('thinking', model)) out.reasoning = 'no';
  if (isUnsupported('toolCalling', model)) out.toolCalling = 'no';
  return out;
}
