/**
 * Token bucket — the authoritative, dependency-free model of our rate limiter.
 *
 * Both limiter backends implement *exactly* this function:
 *   - `RedisLuaRateLimiterBackend` runs scripts/token-bucket.lua on Redis
 *     (atomic read-modify-write, shared across API replicas),
 *   - `MemoryRateLimiterBackend` runs this file in-process (unit tests, dev,
 *     and API pods that lost Redis and fell back to per-pod limiting).
 *
 * `packages/shared/tests/lua-parity.test.ts` executes the real Lua source in a
 * Lua VM (fengari) against a randomised matrix of states and asserts identical
 * decisions, so the two can never silently drift.
 *
 * Integer math note: we carry tokens in *milli-tokens* so that both JS and Lua
 * (whose numbers are IEEE doubles, and whose Redis variant truncates on write)
 * agree bit-for-bit. `refillPerSec` tokens/s == `refillPerSec` milli-tokens/ms,
 * which makes the elapsed-time term a single multiply with no division.
 */

export interface BucketState {
  /** Available tokens, in milli-tokens (1000 = 1 token). */
  readonly tokensMilli: number;
  /** Last update timestamp in epoch milliseconds. */
  readonly updatedAtMs: number;
}

export interface BucketGeometry {
  /** Burst size, in tokens. */
  capacity: number;
  /** Sustained rate, in tokens per second. */
  refillPerSec: number;
}

export interface ConsumeResult {
  allowed: boolean;
  /** Bucket capacity (for `RateLimit-Limit`). */
  limit: number;
  /** Whole tokens left after this decision (for `RateLimit-Remaining`). */
  remaining: number;
  /** 0 when allowed; otherwise how long to wait, in ms (`Retry-After`). */
  retryAfterMs: number;
  /** Post-decision state, ready to be persisted. */
  state: BucketState;
}

export const MILLI = 1000;

export function emptyBucket(geom: BucketGeometry, nowMs: number): BucketState {
  return { tokensMilli: Math.floor(geom.capacity * MILLI), updatedAtMs: nowMs };
}

/**
 * @param prev      persisted state, or null/undefined for a fresh bucket
 * @param nowMs     monotonic-ish wall clock in ms (Redis TIME on the server)
 * @param cost      tokens to spend (>= 1)
 * @returns decision + the state the caller must persist
 */
export function consume(
  prev: BucketState | null | undefined,
  nowMs: number,
  geom: BucketGeometry,
  cost = 1,
): ConsumeResult {
  const capacityMilli = Math.floor(geom.capacity * MILLI);
  const base: BucketState = prev ?? { tokensMilli: capacityMilli, updatedAtMs: nowMs };

  const elapsedMs = Math.max(0, nowMs - base.updatedAtMs);
  // Truncation is intentional and mirrored by math.floor() in the Lua script.
  const gained = Math.floor(elapsedMs * geom.refillPerSec);
  const tokens = Math.min(capacityMilli, base.tokensMilli + gained);
  const costMilli = Math.floor(cost * MILLI);

  if (tokens >= costMilli) {
    return {
      allowed: true,
      limit: geom.capacity,
      remaining: Math.floor((tokens - costMilli) / MILLI),
      retryAfterMs: 0,
      state: { tokensMilli: tokens - costMilli, updatedAtMs: nowMs },
    };
  }

  const missing = costMilli - tokens;
  const retryAfterMs =
    geom.refillPerSec > 0 ? Math.ceil(missing / geom.refillPerSec) : Number.POSITIVE_INFINITY;
  return {
    allowed: false,
    limit: geom.capacity,
    remaining: 0,
    retryAfterMs,
    // Rejected requests still persist the refilled bucket (but never a
    // negative balance, and never the timestamp-of-rejection "debt").
    state: { tokensMilli: tokens, updatedAtMs: nowMs },
  };
}

/** Reset the bucket (used by the tenant-scoped admin endpoint and tests). */
export function reset(geom: BucketGeometry, nowMs: number): BucketState {
  return emptyBucket(geom, nowMs);
}

/** Seconds to report in `Retry-After` (HTTP wants whole seconds, round up). */
export function retryAfterSeconds(retryAfterMs: number): number {
  if (!Number.isFinite(retryAfterMs)) {
    return 60;
  }
  return Math.max(1, Math.ceil(retryAfterMs / 1000));
}
