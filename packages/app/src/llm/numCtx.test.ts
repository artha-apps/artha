import { describe, it, expect } from 'vitest';
import { pickNumCtx, estimateTokens } from './numCtx';

describe('pickNumCtx', () => {
  it('reproduces the truncation case and fixes it: 8.7k prompt + 2k reply → 16384, not 8192', () => {
    expect(pickNumCtx(4096, 8734, 2048)).toBe(16384);
  });
  it('keeps small prompts at the floor', () => {
    expect(pickNumCtx(undefined, 1200, 2048)).toBe(8192);
    expect(pickNumCtx(4096, 500, 512)).toBe(8192);
  });
  it('never goes below a larger configured window', () => {
    expect(pickNumCtx(32768, 1000, 1000)).toBe(32768);
  });
  it('steps up through buckets with headroom and tops out at the largest bucket', () => {
    expect(pickNumCtx(undefined, 20000, 2048)).toBe(32768);
    expect(pickNumCtx(undefined, 200000, 2048)).toBe(131072);
  });
  it('estimates tokens conservatively from characters', () => {
    expect(estimateTokens('a'.repeat(3200))).toBe(1000);
  });
});
