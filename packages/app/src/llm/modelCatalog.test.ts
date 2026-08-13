/**
 * modelCatalog tests — the remote-with-bundled-fallback contract:
 * a well-formed remote list wins, everything else (HTTP error, timeout,
 * schema mismatch, hostile entries) falls back to BUNDLED_CATALOG, and a
 * successful fetch is cached while failures are retried.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { getModelCatalog, resetCatalogCache, BUNDLED_CATALOG } from './modelCatalog';

/** Minimal valid remote entry factory. */
const entry = (over: Record<string, unknown> = {}) => ({
  tag: 'muse-glimmer:30b',
  label: 'Muse Glimmer 30B',
  family: 'Muse',
  size: '~19 GB',
  ramRequired: 32,
  speed: 'Medium',
  description: 'Agentic local model.',
  badge: 'New',
  ...over,
});

const okResponse = (body: unknown) =>
  ({ ok: true, json: async () => body }) as unknown as Response;

beforeEach(() => resetCatalogCache());

describe('getModelCatalog', () => {
  it('returns the remote list when the fetch succeeds and validates', async () => {
    const fetchFn = vi.fn(async () => okResponse({ schemaVersion: 1, models: [entry()] }));
    const cat = await getModelCatalog(fetchFn as unknown as typeof fetch);
    expect(cat.source).toBe('remote');
    expect(cat.entries).toHaveLength(1);
    expect(cat.entries[0].tag).toBe('muse-glimmer:30b');
  });

  it('falls back to the bundled list on HTTP error', async () => {
    const fetchFn = vi.fn(async () => ({ ok: false, status: 500 }) as unknown as Response);
    const cat = await getModelCatalog(fetchFn as unknown as typeof fetch);
    expect(cat.source).toBe('bundled');
    expect(cat.entries).toEqual(BUNDLED_CATALOG);
  });

  it('falls back when fetch throws (offline / timeout)', async () => {
    const fetchFn = vi.fn(async () => { throw new Error('network down'); });
    const cat = await getModelCatalog(fetchFn as unknown as typeof fetch);
    expect(cat.source).toBe('bundled');
  });

  it('falls back on schema mismatch', async () => {
    const fetchFn = vi.fn(async () => okResponse({ schemaVersion: 2, models: [entry()] }));
    expect((await getModelCatalog(fetchFn as unknown as typeof fetch)).source).toBe('bundled');
  });

  it('filters invalid entries and falls back when none survive', async () => {
    const bad = [
      entry({ tag: 'rm -rf /; evil' }),          // charset-invalid tag
      entry({ ramRequired: 'lots' }),            // wrong type
      entry({ description: 'x'.repeat(500) }),   // over length cap
      { tag: 'orphan' },                         // missing fields
    ];
    const fetchFn = vi.fn(async () => okResponse({ schemaVersion: 1, models: bad }));
    expect((await getModelCatalog(fetchFn as unknown as typeof fetch)).source).toBe('bundled');
  });

  it('keeps valid entries while dropping invalid ones', async () => {
    const fetchFn = vi.fn(async () =>
      okResponse({ schemaVersion: 1, models: [entry(), entry({ tag: '!!bad!!' })] }));
    const cat = await getModelCatalog(fetchFn as unknown as typeof fetch);
    expect(cat.source).toBe('remote');
    expect(cat.entries).toHaveLength(1);
  });

  it('strips unknown keys from remote entries', async () => {
    const fetchFn = vi.fn(async () =>
      okResponse({ schemaVersion: 1, models: [entry({ sneaky: '<img onerror=x>' })] }));
    const cat = await getModelCatalog(fetchFn as unknown as typeof fetch);
    expect('sneaky' in cat.entries[0]).toBe(false);
  });

  it('caches a successful remote fetch (no second network call)', async () => {
    const fetchFn = vi.fn(async () => okResponse({ schemaVersion: 1, models: [entry()] }));
    await getModelCatalog(fetchFn as unknown as typeof fetch);
    await getModelCatalog(fetchFn as unknown as typeof fetch);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('does NOT cache a fallback — failures retry on the next call', async () => {
    const fetchFn = vi.fn(async () => { throw new Error('down'); });
    await getModelCatalog(fetchFn as unknown as typeof fetch);
    await getModelCatalog(fetchFn as unknown as typeof fetch);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it('bundled catalog includes Muse Glimmer and stays internally valid', () => {
    expect(BUNDLED_CATALOG.some(e => e.tag === 'muse-glimmer:30b')).toBe(true);
    // Every bundled entry must pass the same bar we hold remote entries to.
    for (const e of BUNDLED_CATALOG) {
      expect(e.tag).toMatch(/^[A-Za-z0-9][A-Za-z0-9._-]*(\/[A-Za-z0-9][A-Za-z0-9._-]*)?(:[A-Za-z0-9._-]+)?$/);
      expect(e.ramRequired).toBeGreaterThanOrEqual(1);
    }
  });
});
