import { bucketFor } from '../plans.js';
import { consume, type BucketState } from './tokenBucket.js';
import {
  rateLimitKey,
  type RateLimiterBackend,
  type RateLimitContext,
  type RateLimitDecision,
  type RateLimitInput,
} from './types.js';

interface MemoryBucket {
  state: BucketState;
  /** geometry the state was created with; a plan change invalidates it */
  sig: string;
}

export interface MemoryRateLimiterOptions {
  /** Inject a clock so tests can move time forward without sleeping. */
  now?: () => number;
  /** Buckets idle longer than this are evicted (mirrors Redis PEXPIRE). */
  idleTtlMs?: number;
}

/**
 * In-process limiter. Same algorithm as the Lua script, no network, no Redis.
 *
 * Where it is used:
 *  - unit tests (deterministic clock),
 *  - `npm run dev` on a laptop with no Docker,
 *  - **degraded mode**: when Redis is down the API switches to this so that a
 *    cache outage does not become an unthrottled-DDoS-into-Postgres outage.
 *    Correctness caveat we accept deliberately: limits become *per pod*, so
 *    the effective cluster limit is `plan_limit * replica_count`. Documented in
 *    docs/ARCHITECTURE.md ("Failure modes").
 */
export class MemoryRateLimiterBackend implements RateLimiterBackend {
  readonly kind = 'memory' as const;
  private readonly buckets = new Map<string, MemoryBucket>();
  private readonly now: () => number;
  private readonly idleTtlMs: number;
  private lastSweep = 0;

  constructor(opts: MemoryRateLimiterOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.idleTtlMs = opts.idleTtlMs ?? 600_000;
  }

  async consume(input: RateLimitInput): Promise<RateLimitDecision> {
    const { tenantId, plan, routeClass } = input;
    const cost = input.cost ?? 1;
    const geom = bucketFor(plan, routeClass);
    const key = rateLimitKey(tenantId, routeClass);
    const sig = `${geom.capacity}:${geom.refillPerSec}`;
    const nowMs = this.now();

    this.sweep(nowMs);
    const existing = this.buckets.get(key);
    const prev = existing && existing.sig === sig ? existing.state : null;
    const res = consume(prev, nowMs, geom, cost);
    this.buckets.set(key, { state: res.state, sig });

    return {
      allowed: res.allowed,
      limit: res.limit,
      remaining: res.remaining,
      retryAfterMs: res.retryAfterMs,
      backend: 'memory',
      key,
    };
  }

  async reset(ctx: RateLimitContext): Promise<void> {
    this.buckets.delete(rateLimitKey(ctx.tenantId, ctx.routeClass));
  }

  async close(): Promise<void> {
    this.buckets.clear();
  }

  /** Metrics hook: number of live buckets. */
  get size(): number {
    return this.buckets.size;
  }

  private sweep(nowMs: number): void {
    if (nowMs - this.lastSweep < 30_000) {
      return;
    }
    this.lastSweep = nowMs;
    for (const [key, bucket] of this.buckets) {
      if (nowMs - bucket.state.updatedAtMs > this.idleTtlMs) {
        this.buckets.delete(key);
      }
    }
  }
}
