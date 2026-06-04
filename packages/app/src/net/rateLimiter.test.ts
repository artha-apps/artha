import { describe, it, expect } from 'vitest';
import { createRateLimiter } from './rateLimiter';

describe('createRateLimiter', () => {
  it('allows up to the burst capacity, then throttles', () => {
    const rl = createRateLimiter(3, 1); // capacity 3, 1 token/sec
    const t = 1_000_000;
    expect(rl.take('a', t)).toBe(true);
    expect(rl.take('a', t)).toBe(true);
    expect(rl.take('a', t)).toBe(true);
    expect(rl.take('a', t)).toBe(false); // bucket empty
  });

  it('refills over time', () => {
    const rl = createRateLimiter(2, 1); // 1 token/sec
    const t0 = 1_000_000;
    expect(rl.take('a', t0)).toBe(true);
    expect(rl.take('a', t0)).toBe(true);
    expect(rl.take('a', t0)).toBe(false);
    // 1.5s later → ~1.5 tokens refilled → one more allowed
    expect(rl.take('a', t0 + 1500)).toBe(true);
    expect(rl.take('a', t0 + 1500)).toBe(false);
  });

  it('tracks each key independently', () => {
    const rl = createRateLimiter(1, 1);
    const t = 1_000_000;
    expect(rl.take('a', t)).toBe(true);
    expect(rl.take('a', t)).toBe(false);
    expect(rl.take('b', t)).toBe(true); // different client, fresh bucket
  });

  it('never exceeds capacity even after a long idle', () => {
    const rl = createRateLimiter(2, 5);
    const t0 = 1_000_000;
    rl.take('a', t0); // 1 used
    // 100s later a huge refill is capped at capacity (2), so only 2 succeed
    expect(rl.take('a', t0 + 100_000)).toBe(true);
    expect(rl.take('a', t0 + 100_000)).toBe(true);
    expect(rl.take('a', t0 + 100_000)).toBe(false);
  });
});
