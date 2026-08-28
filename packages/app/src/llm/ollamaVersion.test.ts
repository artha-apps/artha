import { describe, it, expect, vi } from 'vitest';
import {
  parseVersion, compareVersions, versionSatisfies, isOutdatedPullError, getServerVersion,
} from './ollamaVersion';

describe('parseVersion', () => {
  it('parses plain, v-prefixed, and suffixed versions', () => {
    expect(parseVersion('0.33.2')).toEqual([0, 33, 2]);
    expect(parseVersion('v0.33.2')).toEqual([0, 33, 2]);
    expect(parseVersion('0.33.2-rc1')).toEqual([0, 33, 2]);
    expect(parseVersion('0.33')).toEqual([0, 33, 0]);
  });
  it('rejects garbage', () => {
    expect(parseVersion('latest')).toBeNull();
    expect(parseVersion('')).toBeNull();
    expect(parseVersion(undefined)).toBeNull();
  });
});

describe('compareVersions', () => {
  it('orders numerically, not lexically', () => {
    expect(compareVersions('0.33.0', '0.9.9')).toBe(1);
    expect(compareVersions('0.32.5', '0.33.0')).toBe(-1);
    expect(compareVersions('0.33.2', 'v0.33.2')).toBe(0);
  });
  it('sorts unparseable lowest', () => {
    expect(compareVersions('???', '0.1.0')).toBe(-1);
    expect(compareVersions('0.1.0', '???')).toBe(1);
  });
});

describe('versionSatisfies', () => {
  it('is the real gate for the Muse Glimmer case', () => {
    expect(versionSatisfies('0.32.5', '0.33.0')).toBe(false);
    expect(versionSatisfies('0.33.0', '0.33.0')).toBe(true);
    expect(versionSatisfies('0.33.2', '0.33.0')).toBe(true);
  });
  it('never blocks on a guess (unknown server version / no minimum)', () => {
    expect(versionSatisfies(null, '0.33.0')).toBe(true);
    expect(versionSatisfies('0.32.5', undefined)).toBe(true);
    expect(versionSatisfies('weird', '0.33.0')).toBe(true);
  });
});

describe('isOutdatedPullError', () => {
  it('recognises the real 412 wording from Ollama', () => {
    expect(isOutdatedPullError(
      'pull model manifest: 412: The model you are attempting to pull requires a newer version of Ollama. Please download the latest version at: https://ollama.com/download',
    )).toBe(true);
  });
  it('ignores unrelated errors', () => {
    expect(isOutdatedPullError('pull model manifest: file does not exist')).toBe(false);
    expect(isOutdatedPullError(undefined)).toBe(false);
  });
});

describe('getServerVersion', () => {
  it('returns the version string from /api/version', async () => {
    const fetchFn = vi.fn(async () => ({ ok: true, json: async () => ({ version: '0.32.5' }) }) as unknown as Response);
    expect(await getServerVersion('http://x', 100, fetchFn as unknown as typeof fetch)).toBe('0.32.5');
  });
  it('returns null when down or malformed', async () => {
    const down = vi.fn(async () => { throw new Error('ECONNREFUSED'); });
    expect(await getServerVersion('http://x', 100, down as unknown as typeof fetch)).toBeNull();
    const weird = vi.fn(async () => ({ ok: true, json: async () => ({ version: 42 }) }) as unknown as Response);
    expect(await getServerVersion('http://x', 100, weird as unknown as typeof fetch)).toBeNull();
  });
});
