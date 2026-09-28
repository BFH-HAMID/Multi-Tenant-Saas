import { describe, expect, it } from 'vitest';
import { MemoryRateLimiterBackend } from '../src/ratelimit/memoryBackend.js';
import { runRateLimiterConformance } from '../src/ratelimit/conformance.js';
import { bucketFor } from '../src/plans.js';

/**
 * The in-process fallback backend must satisfy the same contract as the Redis
 * one. `runRateLimiterConformance` is imported by apps/api/tests/redisLimiter.int.test.ts
 * too — one spec, two implementations.
 */
runRateLimiterConformance({
  name: 'memory',
  async create() {
    return new MemoryRateLimiterBackend({ now: () => clock.now });
  },
});

let clock = { now: 1_700_000_000_000 };

describe('memory limiter clock behaviour', () => {
  it('refills against the injected clock', async () => {
    clock = { now: 0 };
    const limiter = new MemoryRateLimiterBackend({ now: () => clock.now });
    const plan = 'free' as const;
    const routeClass = 'bulk';
    const { capacity, refillPerSec } = bucketFor(plan, routeClass);

    let allowed = 0;
    for (let i = 0; i < capacity + 3; i++) {
      if ((await limiter.consume({ tenantId: 't1', plan, routeClass })).allowed) {
        allowed++;
      }
    }
    expect(allowed).toBe(capacity);

    // Wait exactly long enough for one token.
    clock.now += Math.ceil((1000 / refillPerSec) * 1.05);
    const after = await limiter.consume({ tenantId: 't1', plan, routeClass });
    expect(after.allowed).toBe(true);
  });

  it('re-adopts the geometry when a tenant changes plan', async () => {
    clock = { now: 0 };
    const limiter = new MemoryRateLimiterBackend({ now: () => clock.now });
    for (let i = 0; i < bucketFor('free', 'auth').capacity; i++) {
      await limiter.consume({ tenantId: 't2', plan: 'free', routeClass: 'auth' });
    }
    expect(
      (await limiter.consume({ tenantId: 't2', plan: 'free', routeClass: 'auth' })).allowed,
    ).toBe(false);
    // Upgrade mid-test (billing webhook path): the pro bucket is a different
    // size, so the stale free-plan state must not keep the tenant throttled.
    const upgraded = await limiter.consume({ tenantId: 't2', plan: 'pro', routeClass: 'auth' });
    expect(upgraded.allowed).toBe(true);
    expect(upgraded.limit).toBe(bucketFor('pro', 'auth').capacity);
  });

  it('evicts idle buckets instead of growing forever', async () => {
    clock = { now: 0 };
    const limiter = new MemoryRateLimiterBackend({ now: () => clock.now, idleTtlMs: 1000 });
    for (let i = 0; i < 500; i++) {
      await limiter.consume({ tenantId: `t${i}`, plan: 'free', routeClass: 'read' });
    }
    expect(limiter.size).toBe(500);
    clock.now += 40_000; // past TTL and the 30s sweep interval
    await limiter.consume({ tenantId: 'fresh', plan: 'free', routeClass: 'read' });
    expect(limiter.size).toBe(1);
  });

  it('reset() clears a tenant bucket', async () => {
    clock = { now: 0 };
    const limiter = new MemoryRateLimiterBackend({ now: () => clock.now });
    const ctx = { tenantId: 't3', plan: 'free' as const, routeClass: 'auth' };
    const { capacity } = bucketFor('free', 'auth');
    for (let i = 0; i < capacity; i++) {
      await limiter.consume(ctx);
    }
    expect((await limiter.consume(ctx)).allowed).toBe(false);
    await limiter.reset(ctx);
    expect((await limiter.consume(ctx)).allowed).toBe(true);
  });
});
