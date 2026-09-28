import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  bucketIdleTtlMs,
  consume,
  TOKEN_BUCKET_LUA,
  tokenBucketSha,
  type BucketGeometry,
  type BucketState,
} from '../src/index.js';
import { createStore, runLuaScript, seedBucket, type LuaStore } from './helpers/luaRunner.js';

/**
 * Parity: the Lua script that runs inside Redis must produce the *same* decision
 * as `consume()` in `src/ratelimit/tokenBucket.ts` for the same inputs, or the
 * in-memory fallback and production disagree about who gets throttled — which
 * is exactly the class of bug that shows up as "our largest customer got 3x the
 * burst of everyone else" and nowhere else.
 */

const KEY = 'rl:test:read';

interface Step {
  nowMs: number;
  cost: number;
}

function replay(
  geom: BucketGeometry,
  steps: Step[],
  opts: { start?: BucketState; store?: LuaStore } = {},
) {
  const store = opts.store ?? createStore(steps[0]!.nowMs);
  const js: BucketState | undefined = opts.start;
  if (opts.start) {
    seedBucket(store, KEY, opts.start.tokensMilli, opts.start.updatedAtMs);
  }

  const results: Array<
    { allowed: boolean; remaining: number; retryAfterMs: number; limit: number } & {
      lua: { allowed: boolean; remaining: number; retryAfterMs: number; limit: number };
    }
  > = [];

  let jsState = js;
  for (const step of steps) {
    store.nowMs = step.nowMs;
    const jsRes = consume(jsState, step.nowMs, geom, step.cost);
    const out = runLuaScript(
      TOKEN_BUCKET_LUA,
      store,
      [KEY],
      [
        geom.capacity,
        geom.refillPerSec,
        step.cost,
        bucketIdleTtlMs(geom.capacity, geom.refillPerSec),
      ],
    );
    const [allowed, remaining, retryAfterMs, limit] = out.reply;
    jsState = jsRes.state;
    results.push({
      allowed: jsRes.allowed,
      remaining: jsRes.remaining,
      retryAfterMs: jsRes.retryAfterMs,
      limit: jsRes.limit,
      lua: {
        allowed: allowed === 1,
        remaining: remaining!,
        retryAfterMs: retryAfterMs!,
        limit: limit!,
      },
    });
  }
  return { results, store };
}

describe('Lua ⇄ JS token bucket parity', () => {
  it('agrees on a simple burst-and-recover walk', () => {
    const geom: BucketGeometry = { capacity: 3, refillPerSec: 1 };
    const steps: Step[] = [
      { nowMs: 1_000, cost: 1 },
      { nowMs: 1_001, cost: 1 },
      { nowMs: 1_002, cost: 1 },
      { nowMs: 1_003, cost: 1 }, // empty → reject
      { nowMs: 2_005, cost: 1 }, // ~1 token refilled → allow
      { nowMs: 2_006, cost: 2 }, // only 0 tokens left → reject
      { nowMs: 4_006, cost: 3 }, // 2s at 1/s → 2 tokens +? still short of 3
    ];
    const { results } = replay(geom, steps);
    for (const r of results) {
      expect(r.lua).toEqual({
        allowed: r.allowed,
        remaining: r.remaining,
        retryAfterMs: r.retryAfterMs,
        limit: r.limit,
      });
    }
    // Sanity: we actually exercised both outcomes.
    expect(results.filter((r) => r.allowed)).toHaveLength(4);
  });

  it('agrees across a randomised matrix of capacities, rates and clocks', () => {
    // Deterministic PRNG so a failure is reproducible from the seed alone.
    let seed = 0x2f6e2b1;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };

    const capacities = [1, 2, 5, 30, 120, 1200];
    const rates = [0.0333, 0.5, 1, 5, 100, 1000];
    let compared = 0;

    for (let trial = 0; trial < 250; trial++) {
      const geom: BucketGeometry = {
        capacity: capacities[Math.floor(rand() * capacities.length)]!,
        refillPerSec: rates[Math.floor(rand() * rates.length)]!,
      };
      // Small, relative timestamps — see the fidelity note in helpers/luaRunner.ts.
      let t = 1_000 + Math.floor(rand() * 5000);
      const steps: Step[] = [];
      const n = 1 + Math.floor(rand() * 8);
      for (let i = 0; i < n; i++) {
        steps.push({ nowMs: t, cost: 1 + Math.floor(rand() * 4) });
        // Mostly-forward time, with occasional skew (a pod whose clock is 50ms
        // behind the Redis server) — the clamping branch must match too.
        t += rand() < 0.12 ? -Math.floor(rand() * 200) : Math.floor(rand() * 5000);
      }
      const { results } = replay(geom, steps, {
        start:
          rand() < 0.4
            ? {
                tokensMilli: Math.floor(rand() * geom.capacity * 1000),
                updatedAtMs: steps[0]!.nowMs - Math.floor(rand() * 8000),
              }
            : undefined,
      });
      for (const r of results) {
        compared++;
        expect(r.lua).toEqual({
          allowed: r.allowed,
          remaining: r.remaining,
          retryAfterMs: r.retryAfterMs,
          limit: r.limit,
        });
      }
    }
    expect(compared).toBeGreaterThan(800);
  });

  it('persists the refilled state and arms an idle TTL', () => {
    const geom: BucketGeometry = { capacity: 2, refillPerSec: 1 };
    const store = createStore(10_000);
    runLuaScript(TOKEN_BUCKET_LUA, store, [KEY], [geom.capacity, geom.refillPerSec, 1, 60_000]);
    const hash = store.hashes.get(KEY)!;
    expect([...hash.fields.keys()].sort()).toEqual(['t', 'u']);
    expect(Number(hash.fields.get('t'))).toBe(1000); // 2 tokens - 1
    expect(hash.pexpireAt).toBe(10_000 + 60_000);
  });

  it('starts from full capacity for an unseen bucket, not from zero', () => {
    const geom: BucketGeometry = { capacity: 4, refillPerSec: 1 };
    const { results } = replay(geom, [{ nowMs: 5_000, cost: 1 }]);
    expect(results[0]!.lua.remaining).toBe(3);
  });

  it('rejects a cost larger than capacity instead of going negative', () => {
    const geom: BucketGeometry = { capacity: 2, refillPerSec: 1 };
    const { results, store } = replay(geom, [{ nowMs: 1000, cost: 3 }]);
    expect(results[0]!.lua.allowed).toBe(false);
    expect(Number(store.hashes.get(KEY)!.fields.get('t'))).toBe(2000);
  });

  it('returns the four-tuple the client parser expects', () => {
    const { results } = replay({ capacity: 5, refillPerSec: 2 }, [{ nowMs: 0, cost: 1 }]);
    expect(results[0]!.lua.limit).toBe(5);
  });

  it('is a stable script (EVALSHA cache key depends on byte-exact source)', () => {
    const sha = tokenBucketSha();
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
    // A second call must not differ, otherwise NOSCRIPT reloads on every deploy.
    expect(tokenBucketSha()).toBe(sha);
  });

  it('kept the checked-out ops copy in sync with the embedded source', () => {
    const opsCopy = fileURLToPath(
      new URL('../../../infra/redis/token-bucket.lua', import.meta.url),
    );
    const onDisk = readFileSync(opsCopy, 'utf8');
    // The generated file carries a banner; the body must be byte-identical.
    expect(onDisk).toContain(TOKEN_BUCKET_LUA.trim());
  });
});
