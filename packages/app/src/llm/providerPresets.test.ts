/**
 * Provider preset registry invariants (Phase A commit 5).
 *
 * The registry is data the whole BYOK flow trusts — these tests pin the
 * invariants the UI, providerKind classification, and capability registry
 * rely on, so a careless preset edit fails CI instead of shipping.
 */
import { describe, it, expect } from 'vitest';
import { PROVIDER_PRESETS, getPreset } from './providerPresets';
import { isOllamaManaged, normalizeProvider } from './providerKind';

describe('provider preset registry', () => {
  it('ids are unique, kebab-case, and non-empty', () => {
    const ids = PROVIDER_PRESETS.map(p => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[a-z][a-z0-9-]*$/);
  });

  it('covers the founder-approved roster', () => {
    const ids = new Set(PROVIDER_PRESETS.map(p => p.id));
    for (const required of [
      'openai', 'anthropic', 'gemini', 'openrouter', 'groq', 'moonshot',
      'deepseek', 'mistral', 'together', 'azure-openai', 'ollama-remote', 'custom',
    ]) {
      expect(ids.has(required), `missing preset: ${required}`).toBe(true);
    }
  });

  it('every fixed base URL is https and OpenAI-compatible in shape', () => {
    for (const p of PROVIDER_PRESETS) {
      if (!p.baseUrl) {
        // User-supplied URL → must provide a template to guide them.
        expect(p.baseUrlTemplate, `${p.id} needs baseUrlTemplate`).toBeTruthy();
        continue;
      }
      expect(p.baseUrl.startsWith('https://'), `${p.id} must be https`).toBe(true);
      expect(p.baseUrl.endsWith('/')).toBe(false); // no trailing slash — SDK appends paths
    }
  });

  it('no preset is classified as locally-Ollama-managed (lifecycle stays local-only)', () => {
    for (const p of PROVIDER_PRESETS) {
      if (!p.baseUrl) continue; // templates resolve at save time; ollama-remote note covers it
      expect(isOllamaManaged(p.id, p.baseUrl), `${p.id} must not trigger local lifecycle`).toBe(false);
    }
  });

  it('preset ids survive normalizeProvider round-trip (stored id == canonical id)', () => {
    for (const p of PROVIDER_PRESETS) {
      const url = p.baseUrl || (p.baseUrlTemplate ?? '').replace(/\{[^}]+\}/g, 'example');
      expect(normalizeProvider(p.id, url)).toBe(p.id);
    }
  });

  it('every preset carries the fields the UI renders', () => {
    for (const p of PROVIDER_PRESETS) {
      expect(p.label.length).toBeGreaterThan(1);
      expect(p.modelHint.length).toBeGreaterThan(1);
      expect(p.docsUrl.startsWith('https://')).toBe(true);
      expect(p.capabilityKey.length).toBeGreaterThan(1);
      expect(['cloud', 'gateway', 'runtime-remote', 'custom']).toContain(p.kind);
    }
  });

  it('gateways are labeled as such (routing disclosure is a UI requirement)', () => {
    expect(getPreset('openrouter')!.kind).toBe('gateway');
    expect(getPreset('openrouter')!.note).toMatch(/gateway|route/i);
  });

  it('getPreset returns undefined for unknown ids', () => {
    expect(getPreset('nonexistent')).toBeUndefined();
  });
});
