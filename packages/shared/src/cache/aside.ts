import { jitteredTtl } from '../keys.js';
import type { KvClient } from '../kv/types.js';

export interface CacheStats {
  hits: number;
  misses: number;
  errors: number;
  /** Requests that skipped the cache entirely (disabled flag, no client, …). */
  bypass: number;
  /** Requests that joined an in-flight fill instead of issuing their own DB read. */
  stampedesCoalesced: number;
}

export interface CacheAsideOptions<T> {
  kv: KvClient;
  /** Pre-namespaced key, e.g. from `cacheKey()`. */
  key: string;
  ttlMs: number;
  load: () => Promise<T>;
  /** Serialized size guard: oversized values hurt Redis more than they help. */
  maxBytes?: number;
  enabled?: boolean;
  onStats?: (s: CacheStats) => void;
  /**
   * In-flight dedupe map. When N requests miss the same key, one reads from
   * Postgres and the rest await the same promise (stampede protection). Within
   * a pod this is exact; across pods the `SET NX` lock in the API layer adds a
   * second, weaker layer — see apps/api/src/cache/lock.ts.
   */
  singleflight?: Map<string, Promise<T | undefined>>;
}

const DEFAULT_MAX_BYTES = 256 * 1024;

/**
 * Cache-aside read-through: try the cache, miss to the loader, fill, return.
 *
 * Invariants we rely on and test:
 *   - a cache read/write failure never becomes a user-visible error,
 *   - only JSON-safe values are stored (so the payload is rebuildable from any
 *     replica),
 *   - `undefined` and `null` are *not* cached as misses unless the caller opts
 *     in via `cacheNegative()` — avoids poisoning a key after one bad read.
 */
export async function cacheAside<T>(opts: CacheAsideOptions<T>): Promise<T> {
  const {
    kv,
    key,
    ttlMs,
    load,
    maxBytes = DEFAULT_MAX_BYTES,
    enabled = true,
    onStats,
    singleflight,
  } = opts;

  const stats: CacheStats = {
    hits: 0,
    misses: 0,
    errors: 0,
    bypass: 0,
    stampedesCoalesced: 0,
  };
  const report = (): void => onStats?.(stats);

  if (!enabled) {
    stats.bypass++;
    report();
    return load();
  }

  let raw: string | undefined;
  try {
    raw = await kv.get(key);
  } catch {
    // RedisKv already guards; this is the belt so a foreign KvClient cannot
    // turn a cache outage into a 500.
    stats.errors++;
  }
  if (raw !== undefined) {
    stats.hits++;
    try {
      const parsed = JSON.parse(raw) as T;
      report();
      return parsed;
    } catch {
      // Corrupt/foreign payload: count it, then fall through and overwrite.
      stats.errors++;
    }
  } else {
    stats.misses++;
  }

  const inflight = singleflight?.get(key);
  if (inflight) {
    stats.stampedesCoalesced++;
    report();
    const shared = await inflight;
    return (shared === undefined ? await load() : shared) as T;
  }

  const run = (async (): Promise<T | undefined> => {
    const fresh = await load();
    const serialized = JSON.stringify(fresh);
    if (serialized !== undefined && Buffer.byteLength(serialized, 'utf8') <= maxBytes) {
      try {
        await kv.set(key, serialized, { ttlMs: jitteredTtl(ttlMs) });
      } catch {
        stats.errors++; // a failed fill costs a little latency next time, nothing more
      }
    }
    return fresh;
  })();

  if (singleflight) {
    singleflight.set(key, run);
    void run
      .catch(() => undefined)
      .finally(() => {
        if (singleflight.get(key) === run) {
          singleflight.delete(key);
        }
      });
  }

  try {
    const value = await run;
    report();
    return value as T;
  } catch (err) {
    stats.errors++;
    report();
    throw err;
  }
}

/**
 * Invalidate a whole family of keys in O(1): callers embed the version returned
 * here in the cache key, so a bump orphans every cached page at once and the old
 * generations age out on TTL. The alternative (delete by SCAN pattern) is
 * O(keys) and blocks Redis — exactly what you do not want on a write path.
 *
 * Version numbering starts at 0 ("never invalidated"), so the first bump to 1 is
 * observably different from an absent counter; if the counter expired we fall
 * back to 0 and the *payload* TTL is the real safety net (see `versionTtlMs`).
 */
export async function bumpVersion(
  kv: KvClient,
  versionKey: string,
  opts: { ttlMs?: number } = {},
): Promise<number> {
  const next = await kv.incr(versionKey);
  // A counter that outlives the longest key in its family guarantees that no
  // reachable payload is ever re-served under a stale version.
  if (opts.ttlMs && next === 1) {
    await kv.set(versionKey, String(next), { ttlMs: opts.ttlMs });
  }
  return next;
}

export async function readVersion(kv: KvClient, versionKey: string): Promise<number> {
  const raw = await kv.get(versionKey);
  if (raw === undefined) {
    return 0;
  }
  const n = Number(raw);
  return Number.isSafeInteger(n) && n > 0 ? n : 0;
}
