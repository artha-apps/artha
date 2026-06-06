/**
 * rateLimiter — a tiny in-memory token-bucket limiter.
 *
 * Used to cap how fast a single LAN client can hit the expensive /chat endpoint
 * (each request spins up a full agent run). Without it, one peer — or a script
 * that obtained a key — could exhaust CPU/model resources or run up cloud-model
 * spend. In-memory is sufficient: the LAN server is a single process and limits
 * naturally reset on restart.
 */

interface Bucket {
  tokens: number;
  /** epoch ms of the last refill, for lazy (no-timer) replenishment. */
  updated: number;
}

export interface RateLimiter {
  /** Consume one token for `key`. Returns true if allowed, false if throttled. */
  take(key: string, now?: number): boolean;
}

/**
 * @param capacity   max burst (tokens available at once)
 * @param refillPerSec tokens added per second (the sustained rate)
 */
export function createRateLimiter(capacity: number, refillPerSec: number): RateLimiter {
  const buckets = new Map<string, Bucket>();
  // Above this many distinct keys, opportunistically evict buckets that have
  // fully refilled — they're indistinguishable from a never-seen client, so
  // dropping them is free and bounds memory under a flood of distinct IPs.
  const GC_THRESHOLD = 1024;
  return {
    take(key: string, now = Date.now()): boolean {
      if (buckets.size > GC_THRESHOLD) {
        for (const [k, bk] of buckets) {
          if (k === key) continue;
          const refilled = Math.min(capacity, bk.tokens + ((now - bk.updated) / 1000) * refillPerSec);
          if (refilled >= capacity) buckets.delete(k);
        }
      }
      let b = buckets.get(key);
      if (!b) {
        b = { tokens: capacity, updated: now };
        buckets.set(key, b);
      }
      // Lazily refill based on elapsed time since the last touch.
      const elapsedSec = (now - b.updated) / 1000;
      if (elapsedSec > 0) {
        b.tokens = Math.min(capacity, b.tokens + elapsedSec * refillPerSec);
        b.updated = now;
      }
      if (b.tokens >= 1) {
        b.tokens -= 1;
        return true;
      }
      return false;
    },
  };
}
