import { describe, it, expect } from 'vitest';
import path from 'path';
import { augmentedPath, spawnEnv } from './nodePath';

describe('augmentedPath', () => {
  it('preserves every inherited PATH entry', () => {
    const out = augmentedPath().split(path.delimiter);
    for (const p of (process.env.PATH ?? '').split(path.delimiter).filter(Boolean)) {
      expect(out).toContain(p);
    }
  });

  it('has no duplicate entries', () => {
    const out = augmentedPath().split(path.delimiter);
    expect(new Set(out).size).toBe(out.length);
  });
});

describe('spawnEnv', () => {
  it('overrides PATH with the augmented one and merges extra vars', () => {
    const env = spawnEnv({ GITHUB_PERSONAL_ACCESS_TOKEN: 'ghp_x' });
    expect(env.PATH).toBe(augmentedPath());
    expect(env.GITHUB_PERSONAL_ACCESS_TOKEN).toBe('ghp_x');
    // Inherited vars still present (HOME exists in any real shell/runner).
    if (process.env.HOME) expect(env.HOME).toBe(process.env.HOME);
  });
});
