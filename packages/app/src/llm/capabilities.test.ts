/**
 * Capability registry tests (Phase A commit 9) — static coverage of the
 * preset roster, probe fold-in, and the entitlement-separation invariant.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  PROVIDER_CAPABILITIES,
  getEffectiveCapabilities,
  markUnsupported,
  isUnsupported,
  clearProbes,
} from './capabilities';
import { PROVIDER_PRESETS } from './providerPresets';

beforeEach(() => clearProbes());

describe('static registry', () => {
  it('covers every preset capabilityKey plus the local ollama runtime', () => {
    for (const p of PROVIDER_PRESETS) {
      // ollama-remote maps onto the shared 'ollama' capability row.
      expect(PROVIDER_CAPABILITIES[p.capabilityKey], `missing capabilities for ${p.capabilityKey}`).toBeTruthy();
    }
    expect(PROVIDER_CAPABILITIES.ollama).toBeTruthy();
  });

  it('every row carries an honest data-retention note', () => {
    for (const [key, caps] of Object.entries(PROVIDER_CAPABILITIES)) {
      expect(caps.dataRetentionNote.length, `${key} retention note`).toBeGreaterThan(10);
    }
    // The local row must state the local guarantee; the gateway row must
    // disclose the pass-through; custom must admit it doesn't know.
    expect(PROVIDER_CAPABILITIES.ollama.dataRetentionNote).toMatch(/never leave/i);
    expect(PROVIDER_CAPABILITIES.openrouter.dataRetentionNote).toMatch(/underlying provider/i);
    expect(PROVIDER_CAPABILITIES.custom.dataRetentionNote).toMatch(/unknown/i);
  });

  it('unknown capability keys fall back to the custom (all-unknown) row', () => {
    expect(getEffectiveCapabilities('some-future-provider')).toEqual(PROVIDER_CAPABILITIES.custom);
  });
});

describe('runtime probe fold-in (absorbs the old thinkingUnsupported cache)', () => {
  it('a thinking-rejected model reports reasoning:no through the same registry', () => {
    expect(getEffectiveCapabilities('ollama', 'llama3.2:3b').reasoning).toBe('varies');
    markUnsupported('thinking', 'llama3.2:3b');
    expect(isUnsupported('thinking', 'llama3.2:3b')).toBe(true);
    expect(getEffectiveCapabilities('ollama', 'llama3.2:3b').reasoning).toBe('no');
    // Other models are untouched.
    expect(getEffectiveCapabilities('ollama', 'deepseek-r1:7b').reasoning).toBe('varies');
  });

  it('tool-calling probe facts overlay the same way', () => {
    markUnsupported('toolCalling', 'tinyllama:1b');
    expect(getEffectiveCapabilities('ollama', 'tinyllama:1b').toolCalling).toBe('no');
  });

  it('probes never mutate the static registry', () => {
    const before = { ...PROVIDER_CAPABILITIES.ollama };
    markUnsupported('thinking', 'llama3.2:3b');
    getEffectiveCapabilities('ollama', 'llama3.2:3b');
    expect(PROVIDER_CAPABILITIES.ollama).toEqual(before);
  });
});

describe('separation of concerns', () => {
  it('the registry knows nothing about tiers/entitlements (no such fields)', () => {
    for (const caps of Object.values(PROVIDER_CAPABILITIES)) {
      const keys = Object.keys(caps).join(' ');
      expect(keys).not.toMatch(/tier|entitle|license|seat|price/i);
    }
  });
});
