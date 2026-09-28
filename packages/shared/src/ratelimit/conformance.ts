import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bucketFor, type PlanId } from '../plans.js';
import type { RateLimiterBackend } from './types.js';

/**
 * The behaviour any limiter backend must satisfy. Run from:
 *   - packages/shared/tests/memoryLimiter.test.ts    (in-memory, fake clock)
 *   - apps/api/tests/redisLimiter.int.test.ts        (real Redis + real Lua)
 *
 * One definition for both backends is what lets the in-process fallback and the
 * production Lua path coexist without either of them rotting.
 */
export interface ConformanceHarness {
  name: string;
  create(): Promise<RateLimiterBackend>;
  /** Optional per-test cleanup (FLUSHDB for Redis, clock reset for memory). */
  beforeEachTest?(): Promise<void>;
}

const TENANT_A = '00000000-0000-4000-8000-00000000000a';
const TENANT_B = '00000000-0000-4000-8000-00000000000b';

export function runRateLimiterConformance(h: ConformanceHarness): void {
  describe(`rate limiter conformance: ${h.name}`, () => {
    let limiter: RateLimiterBackend;

    beforeEach(async () => {
      await h.beforeEachTest?.();
      limiter = await h.create();
    });

    afterEach(async () => {
      await limiter?.close();
    });

    const take = (
      tenantId: string,
      plan: PlanId,
      routeClass: string,
      cost = 1,
    ): Promise<{ allowed: boolean; remaining: number; limit: number; retryAfterMs: number }> =>
      limiter.consume({ tenantId, plan, routeClass, cost });

    it('allows a burst exactly up to capacity, then rejects with a retry hint', async () => {
      const plan: PlanId = 'free';
      const routeClass = 'write';
      const { capacity } = bucketFor(plan, routeClass);

      let allowed = 0;
      for (let i = 0; i < capacity + 5; i++) {
        if ((await take(TENANT_A, plan, routeClass)).allowed) {
          allowed++;
        }
      }
      expect(allowed).toBe(capacity);

      const denied = await take(TENANT_A, plan, routeClass);
      expect(denied).toMatchObject({ allowed: false, remaining: 0, limit: capacity });
      expect(denied.retryAfterMs).toBeGreaterThan(0);
    });

    it('decrements remaining by one per request', async () => {
      const remaining: number[] = [];
      for (let i = 0; i < 5; i++) {
        const d = await take(TENANT_A, 'free', 'auth');
        expect(d.allowed).toBe(true);
        remaining.push(d.remaining);
      }
      const { capacity } = bucketFor('free', 'auth');
      expect(remaining).toEqual(Array.from({ length: 5 }, (_, i) => capacity - 1 - i));
    });

    it('never throttles a neighbour tenant', async () => {
      const { capacity } = bucketFor('free', 'auth');
      for (let i = 0; i < capacity; i++) {
        await take(TENANT_A, 'free', 'auth');
      }
      expect((await take(TENANT_A, 'free', 'auth')).allowed).toBe(false);
      expect((await take(TENANT_B, 'free', 'auth')).allowed).toBe(true);
    });

    it('never throttles a different route class', async () => {
      const { capacity } = bucketFor('free', 'auth');
      for (let i = 0; i < capacity; i++) {
        await take(TENANT_A, 'free', 'auth');
      }
      expect((await take(TENANT_A, 'free', 'auth')).allowed).toBe(false);
      expect((await take(TENANT_A, 'free', 'read')).allowed).toBe(true);
    });

    it('scales geometry with the plan', async () => {
      const freeCapacity = bucketFor('free', 'read').capacity;
      const proCapacity = bucketFor('pro', 'read').capacity;
      expect(proCapacity).toBeGreaterThan(freeCapacity);

      let proAllowed = 0;
      for (let i = 0; i < freeCapacity + 1; i++) {
        if ((await take(TENANT_A, 'pro', 'read')).allowed) {
          proAllowed++;
        }
      }
      expect(proAllowed).toBe(freeCapacity + 1); // pro bucket is not yet exhausted
    });

    it('supports cost > 1 for expensive endpoints', async () => {
      const d = await take(TENANT_A, 'free', 'auth', 4);
      expect(d.allowed).toBe(true);
      expect(d.remaining).toBe(bucketFor('free', 'auth').capacity - 4);
    });

    it('rejects when cost exceeds the whole capacity', async () => {
      const d = await take(TENANT_A, 'free', 'auth', bucketFor('free', 'auth').capacity + 1);
      expect(d.allowed).toBe(false);
    });
  });
}
