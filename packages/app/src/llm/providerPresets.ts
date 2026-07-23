/**
 * Provider preset registry — DATA, not code (Phase A commit 5).
 *
 * Each preset describes how to reach one OpenAI-compatible provider: base
 * URL (or a template the user fills in), key expectations, docs link, and
 * the capability-registry key (consumed by commit 9). Adding a provider is
 * one entry here plus a capability row — no adapter code unless its wire
 * behavior genuinely differs (see ARTHA_PROVIDER_AND_RUNTIME_ARCHITECTURE.md
 * D-P1).
 *
 * The `id` is the canonical `llm_models.provider` value (see providerKind.ts
 * — anything except 'ollama' is treated as externally managed).
 */

export interface ProviderPreset {
  /** Canonical provider id stored in llm_models.provider. */
  id: string;
  label: string;
  /** 'cloud' = hosted provider · 'gateway' = hosted multi-model gateway ·
   *  'runtime-remote' = a runtime you host elsewhere · 'custom' = escape hatch. */
  kind: 'cloud' | 'gateway' | 'runtime-remote' | 'custom';
  /** Fixed OpenAI-compatible base URL; empty when the user must supply it. */
  baseUrl: string;
  /** Template shown when baseUrl is empty (placeholders in {braces}). */
  baseUrlTemplate?: string;
  /** Whether an API key is required (remote Ollama/custom often need none). */
  keyRequired: boolean;
  /** Prefix hint shown in the key field, e.g. 'sk-…'. Cosmetic only. */
  keyHint: string;
  /** Example model id shown as the input placeholder. */
  modelHint: string;
  /** Where the user creates a key / reads model docs. */
  docsUrl: string;
  /** Key into the capability registry (commit 9). */
  capabilityKey: string;
  /** One-line honesty note surfaced in the UI where warranted. */
  note?: string;
}

export const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    id: 'openai', label: 'OpenAI', kind: 'cloud',
    baseUrl: 'https://api.openai.com/v1', keyRequired: true, keyHint: 'sk-…',
    modelHint: 'gpt-4o-mini', docsUrl: 'https://platform.openai.com/api-keys',
    capabilityKey: 'openai',
  },
  {
    id: 'anthropic', label: 'Anthropic', kind: 'cloud',
    baseUrl: 'https://api.anthropic.com/v1', keyRequired: true, keyHint: 'sk-ant-…',
    modelHint: 'claude-sonnet-4-6', docsUrl: 'https://console.anthropic.com/settings/keys',
    capabilityKey: 'anthropic',
    note: '"Find models" may not work here (Anthropic’s model list uses a different auth style) — type the model name if the list stays empty.',
  },
  {
    id: 'gemini', label: 'Google Gemini', kind: 'cloud',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', keyRequired: true, keyHint: 'AIza…',
    modelHint: 'gemini-2.5-flash', docsUrl: 'https://aistudio.google.com/apikey',
    capabilityKey: 'gemini',
  },
  {
    id: 'openrouter', label: 'OpenRouter', kind: 'gateway',
    baseUrl: 'https://openrouter.ai/api/v1', keyRequired: true, keyHint: 'sk-or-…',
    modelHint: 'deepseek/deepseek-chat', docsUrl: 'https://openrouter.ai/keys',
    capabilityKey: 'openrouter',
    note: 'One key, many models — including free tiers. A hosted gateway: requests route through OpenRouter.',
  },
  {
    id: 'groq', label: 'Groq', kind: 'cloud',
    baseUrl: 'https://api.groq.com/openai/v1', keyRequired: true, keyHint: 'gsk_…',
    modelHint: 'llama-3.3-70b-versatile', docsUrl: 'https://console.groq.com/keys',
    capabilityKey: 'groq',
  },
  {
    id: 'moonshot', label: 'Moonshot (Kimi)', kind: 'cloud',
    baseUrl: 'https://api.moonshot.ai/v1', keyRequired: true, keyHint: 'sk-…',
    modelHint: 'kimi-k2-0711-preview', docsUrl: 'https://platform.moonshot.ai/console/api-keys',
    capabilityKey: 'moonshot',
  },
  {
    id: 'deepseek', label: 'DeepSeek', kind: 'cloud',
    baseUrl: 'https://api.deepseek.com/v1', keyRequired: true, keyHint: 'sk-…',
    modelHint: 'deepseek-chat', docsUrl: 'https://platform.deepseek.com/api_keys',
    capabilityKey: 'deepseek',
  },
  {
    id: 'mistral', label: 'Mistral', kind: 'cloud',
    baseUrl: 'https://api.mistral.ai/v1', keyRequired: true, keyHint: '…',
    modelHint: 'mistral-small-latest', docsUrl: 'https://console.mistral.ai/api-keys',
    capabilityKey: 'mistral',
  },
  {
    id: 'together', label: 'Together AI', kind: 'cloud',
    baseUrl: 'https://api.together.xyz/v1', keyRequired: true, keyHint: '…',
    modelHint: 'meta-llama/Llama-3.3-70B-Instruct-Turbo', docsUrl: 'https://api.together.ai/settings/api-keys',
    capabilityKey: 'together',
  },
  {
    id: 'azure-openai', label: 'Azure OpenAI', kind: 'cloud',
    baseUrl: '', baseUrlTemplate: 'https://{resource}.openai.azure.com/openai/v1',
    keyRequired: true, keyHint: 'azure key',
    modelHint: '{deployment-name}', docsUrl: 'https://learn.microsoft.com/azure/ai-services/openai/',
    capabilityKey: 'azure-openai',
    note: 'Uses your Azure deployment (BYOC-adjacent). Fill in your resource name; the model field is your deployment name.',
  },
  {
    id: 'ollama-remote', label: 'Ollama (remote)', kind: 'runtime-remote',
    baseUrl: '', baseUrlTemplate: 'http://{host}:11434/v1',
    keyRequired: false, keyHint: '(none)',
    modelHint: 'llama3.3:70b', docsUrl: 'https://docs.ollama.com',
    capabilityKey: 'ollama',
    note: 'An Ollama server on another machine you control. No Artha lifecycle management (start/warm/unload) — that applies to local Ollama only.',
  },
  {
    id: 'custom', label: 'Custom (OpenAI-compatible)', kind: 'custom',
    baseUrl: '', baseUrlTemplate: 'https://{host}/v1',
    keyRequired: false, keyHint: 'if your endpoint needs one',
    modelHint: 'model-name', docsUrl: 'https://artha.space/docs',
    capabilityKey: 'custom',
    note: 'Covers vLLM, LM Studio, LocalAI, llmster, and private endpoints.',
  },
];

/** Lookup by canonical id; undefined for unknown ids (caller falls back to custom). */
export function getPreset(id: string): ProviderPreset | undefined {
  return PROVIDER_PRESETS.find(p => p.id === id);
}
