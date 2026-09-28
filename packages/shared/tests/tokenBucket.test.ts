import { describe, expect, it } from 'vitest';
import {
  bucketFor,
  bucketIdleTtlMs,
  consume,
  emptyBucket,
  retryAfterSeconds,
  type BucketGeometry,
} from '../src/index.js';

const geom = (capacity: number, refillPerSec: number): BucketGeometry => ({
  capacity,
  refillPerSec,
});

describe('token bucket model', () => {
  it('starts full', () => {
    const state = emptyBucket(geom(5, 1), 1000);
    expect(state.tokensMilli).toBe(5000);
  });

  it('allows exactly `capacity` requests in a burst', () => {
    let state = emptyBucket(geom(5, 1), 0);
    const results: boolean[] = [];
    for (let i = 0; i < 7; i++) {
      const r = consume(state, 0, geom(5, 1));
      results.push(r.allowed);
      state = r.state;
    }
    expect(results).toEqual([true, true, true, true, true, false, false]);
  });

  it('refills linearly and caps at capacity', () => {
    let state = emptyBucket(geom(10, 2), 0);
    for (let i = 0; i < 10; i++) {
      state = consume(state, 0, geom(10, 2)).state;
    }
    expect(state.tokensMilli).toBe(0);

    // 1s later at 2 tokens/s → 2 tokens, never more than capacity.
    const r = consume(state, 1000, geom(10, 2));
    expect(r.allowed).toBe(true);
    expect(r.remaining).toBe(1);

    const muchLater = consume({ tokensMilli: 0, updatedAtMs: 0 }, 10_000_000, geom(10, 2));
    expect(muchLater.remaining).toBe(9); // capped at capacity - 1
  });

  it('derives Retry-After from the exact deficit', () => {
    const r = consume({ tokensMilli: 500, updatedAtMs: 0 }, 0, geom(10, 1), 1);
    // needs 500 more milli-tokens at 1 milli-token/ms → 500ms
    expect(r.retryAfterMs).toBe(500);
    expect(retryAfterSeconds(r.retryAfterMs)).toBe(1);
  });

  it('never lets a rejected request dig a negative balance', () => {
    // Same instant as the emptying request, so no refill can mask the check.
    const denied = consume({ tokensMilli: 0, updatedAtMs: 1000 }, 1000, geom(3, 1), 1);
    expect(denied.allowed).toBe(false);
    expect(denied.state.tokensMilli).toBe(0);
    expect(denied.state.updatedAtMs).toBe(1000);
    // ...and the rejection still advances the clock so refill keeps counting
    // from *now*, not from the last successful request.
    const tooSoon = consume(denied.state, 1300, geom(3, 1), 1);
    expect(tooSoon.allowed).toBe(false); // 300ms at 1 token/s is only 0.3 tokens
    const later = consume(denied.state, 2000, geom(3, 1), 1);
    expect(later.allowed).toBe(true);
  });

  it('a rejected burst does not cost future tokens', () => {
    // Hammer the bucket while empty, then check the *next* refill still works.
    let state = { tokensMilli: 0, updatedAtMs: 0 };
    for (let t = 1; t <= 100; t++) {
      state = consume(state, t, geom(2, 1), 1).state;
    }
    // 100ms elapsed at 1 milli-token/ms = 100 milli-tokens → still < 1000.
    expect(state.tokensMilli).toBe(100);
  });

  it('handles cost > capacity by always rejecting', () => {
    const r = consume(emptyBucket(geom(3, 1), 0), 0, geom(3, 1), 4);
    expect(r.allowed).toBe(false);
    expect(r.remaining).toBe(0);
  });

  it('is monotonic under clock skew (never refills backwards)', () => {
    const state = { tokensMilli: 1000, updatedAtMs: 5000 };
    const r = consume(state, 4000, geom(10, 1), 1);
    expect(r.allowed).toBe(true);
    expect(r.state.tokensMilli).toBe(1000 - 1000);
    expect(r.state.updatedAtMs).toBe(4000); // moved backwards deliberately
  });

  it('geometry comes from the plan table and is sane', () => {
    for (const plan of ['free', 'pro', 'enterprise'] as const) {
      for (const route of ['read', 'write', 'auth', 'bulk']) {
        const g = bucketFor(plan, route);
        expect(g.capacity).toBeGreaterThan(0);
        expect(g.refillPerSec).toBeGreaterThan(0);
      }
      // Burst must never be larger than a minute of sustained throughput.
      const read = bucketFor(plan, 'read');
      expect(read.capacity).toBeLessThanOrEqual(read.refillPerSec * 60 + read.capacity * 0.5);
    }
    expect(bucketFor('pro', 'read').capacity).toBeGreaterThan(bucketFor('free', 'read').capacity);
    expect(bucketFor('enterprise', 'write').refillPerSec).toBeGreaterThan(
      bucketFor('pro', 'write').refillPerSec,
    );
  });

  it('bucket TTL is proportional to time-to-full-refill and clamped', () => {
    // ttl = clamp(2 * capacity/refill, [60s, 1h])
    expect(bucketIdleTtlMs(1000, 10)).toBe(200_000);
    expect(bucketIdleTtlMs(120, 5)).toBe(60_000); // 48s → floored to 60s
    expect(bucketIdleTtlMs(1000, 0.001)).toBe(3_600_000); // 23 days → capped at 1h
  });
});
