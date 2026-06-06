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
  // Soft threshold: above this many distinct keys, sweep out fully-refilled
  // buckets (indistinguishable from a never-seen client, so free to drop).
  const GC_SOFT = 1024;
  // Hard ceiling: a flood of DISTINCT keys can't refill mid-burst, so a sweep
  // alone wouldn't bound memory. Above this, evict the least-recently-touched
  // entries down to the soft threshold.
  const GC_HARD = 50_000;
  // The sweep is O(n); run it at most once every GC_SOFT calls so the amortized
  // per-request cost stays ~O(1) — otherwise a distinct-key flood would make the
  // limiter itself O(n)/request and amplify the very DoS it defends against.
  let opsSinceSweep = 0;

  const sweep = (now: number, keepKey: string): void => {
    for (const [k, bk] of buckets) {
      if (k === keepKey) continue;
      const refilled = Math.min(capacity, bk.tokens + ((now - bk.updated) / 1000) * refillPerSec);
      if (refilled >= capacity) buckets.delete(k);
    }
    if (buckets.size > GC_HARD) {
      // Still over the ceiling → active flood, nothing refilled. Drop the
      // oldest-touched keys (cheapest to lose) down to the soft threshold.
      const byAge = [...buckets.entries()].sort((a, b) => a[1].updated - b[1].updated);
      for (let i = 0; i < byAge.length && buckets.size > GC_SOFT; i++) {
        if (byAge[i][0] !== keepKey) buckets.delete(byAge[i][0]);
      }
    }
  };

  return {
    take(key: string, now = Date.now()): boolean {
      if (buckets.size > GC_SOFT && ++opsSinceSweep >= GC_SOFT) {
        opsSinceSweep = 0;
        sweep(now, key);
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
