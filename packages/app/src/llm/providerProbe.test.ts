/**
 * Provider probe tests (Phase A commit 6) — discovery + connection testing
 * against the mock provider fixture. No SDK retry loops: probes answer fast,
 * with normalized user-safe errors.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { discoverModels, testConnection } from './providerProbe';
import { startMockProvider, type MockProvider } from '../../test/mockProvider';

let mock: MockProvider;
beforeAll(async () => { mock = await startMockProvider(); });
afterAll(async () => { await mock.close(); });
beforeEach(() => { mock.requests.length = 0; });

describe('discoverModels', () => {
  it('lists, de-duplicates, and sorts the catalogue', async () => {
    mock.setScenario({ apiKey: 'sk-mock', models: ['zeta', 'alpha'], duplicateModels: true });
    const res = await discoverModels(mock.url, 'sk-mock');
    expect(res).toEqual({ ok: true, models: ['alpha', 'zeta'] });
  });

  it('an empty catalogue is a SUCCESS (UI falls back to manual entry)', async () => {
    mock.setScenario({ apiKey: 'sk-mock', emptyCatalogue: true });
    expect(await discoverModels(mock.url, 'sk-mock')).toEqual({ ok: true, models: [] });
  });

  it('bad key → normalized auth error, not retryable', async () => {
    mock.setScenario({ apiKey: 'sk-mock' });
    const res = await discoverModels(mock.url, 'sk-WRONG');
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.kind).toBe('auth');
      expect(res.error.retryable).toBe(false);
      expect(res.error.message).not.toContain('sk-WRONG'); // never echo keys
    }
  });

  it('rate limit → normalized rate_limit, retryable, immediate (no SDK backoff)', async () => {
    mock.setScenario({ apiKey: 'sk-mock', failure: 'rate_limit' });
    const started = Date.now();
    const res = await discoverModels(mock.url, 'sk-mock');
    expect(Date.now() - started).toBeLessThan(2_000);
    if (!res.ok) expect(res.error).toMatchObject({ kind: 'rate_limit', retryable: true });
    expect(res.ok).toBe(false);
  });

  it('slow endpoint → timeout error', async () => {
    mock.setScenario({ apiKey: 'sk-mock', delayMs: 500 });
    const res = await discoverModels(mock.url, 'sk-mock', 100);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.kind).toBe('timeout');
  });

  it('unreachable host → network error', async () => {
    const res = await discoverModels('http://127.0.0.1:1/v1', 'sk-mock', 2_000);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.kind).toBe('network');
  });

  it('non-OpenAI-shaped response → malformed', async () => {
    mock.setScenario({ apiKey: 'sk-mock', failure: 'malformed' });
    const res = await discoverModels(mock.url, 'sk-mock');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.kind).toBe('malformed');
  });
});

describe('testConnection', () => {
  it('succeeds with latency for a valid config', async () => {
    mock.setScenario({ apiKey: 'sk-mock', replyText: 'ok' });
    const res = await testConnection(mock.url, 'sk-mock', 'mock-large');
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.latencyMs).toBeGreaterThanOrEqual(0);
      expect(res.model).toBe('mock-large');
    }
  });

  it('auth failure normalizes cleanly', async () => {
    mock.setScenario({ apiKey: 'sk-mock' });
    const res = await testConnection(mock.url, 'sk-WRONG', 'mock-large');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.kind).toBe('auth');
  });

  it('503 → unavailable, retryable', async () => {
    mock.setScenario({ apiKey: 'sk-mock', failure: 'unavailable' });
    const res = await testConnection(mock.url, 'sk-mock', 'mock-large');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatchObject({ kind: 'unavailable', retryable: true });
  });

  it('unsupported parameter → bad_request with the provider message', async () => {
    mock.setScenario({ apiKey: 'sk-mock', unsupportedParams: ['max_tokens'] });
    const res = await testConnection(mock.url, 'sk-mock', 'mock-large');
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.kind).toBe('bad_request');
      expect(res.error.message).toMatch(/max_tokens/);
    }
  });

  it('malformed completion body → malformed', async () => {
    mock.setScenario({ apiKey: 'sk-mock', failure: 'malformed' });
    const res = await testConnection(mock.url, 'sk-mock', 'mock-large');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.kind).toBe('malformed');
  });

  it('bare-string provider error shapes still normalize', async () => {
    mock.setScenario({ apiKey: 'sk-mock', failure: 'rate_limit', errorShape: 'bare' });
    const res = await testConnection(mock.url, 'sk-mock', 'mock-large');
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.kind).toBe('rate_limit');
      expect(res.error.message.length).toBeGreaterThan(0);
    }
  });
});
