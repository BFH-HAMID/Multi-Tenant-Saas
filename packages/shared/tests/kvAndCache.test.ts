import { describe, expect, it, vi } from 'vitest';
import { MemoryKv } from '../src/kv/memoryKv.js';
import { bumpVersion, cacheAside, readVersion } from '../src/cache/aside.js';
import { cacheKey, cacheVersionKey, jitteredTtl } from '../src/keys.js';

let now = 1_000;
const kvWith = () => new MemoryKv({ now: () => now });

describe('MemoryKv', () => {
  it('honours TTL against the injected clock', async () => {
    const kv = kvWith();
    await kv.set('a', '1', { ttlMs: 500 });
    expect(await kv.get('a')).toBe('1');
    now += 499;
    expect(await kv.get('a')).toBe('1');
    now += 2;
    expect(await kv.get('a')).toBeUndefined();
    expect(await kv.pTtl('a')).toBe(-2);
  });

  it('SET NX only wins once', async () => {
    const kv = kvWith();
    expect(await kv.set('lock', 'me', { ttlMs: 1000, nx: true })).toBe(true);
    expect(await kv.set('lock', 'other', { ttlMs: 1000, nx: true })).toBe(false);
    expect(await kv.get('lock')).toBe('me');
  });

  it('incr creates then increments, and refuses non-integers', async () => {
    const kv = kvWith();
    expect(await kv.incr('v')).toBe(1);
    expect(await kv.incr('v')).toBe(2);
    await kv.set('bad', 'nope');
    await expect(kv.incr('bad')).rejects.toThrow(/not an integer/);
  });

  it('evicts oldest keys past maxEntries (dev double of allkeys-lru)', async () => {
    const kv = new MemoryKv({ maxEntries: 3, now: () => now });
    for (const k of ['k1', 'k2', 'k3']) {
      await kv.set(k, k);
    }
    await kv.set('k4', 'k4');
    expect(await kv.get('k1')).toBeUndefined();
    expect(await kv.get('k4')).toBe('k4');
    expect(kv.size).toBe(3);
  });

  it('scan is prefix-scoped and bounded', async () => {
    const kv = kvWith();
    await kv.set('t:a:c:p:v1:1', '1');
    await kv.set('t:a:c:p:v1:2', '2');
    await kv.set('t:b:c:p:v1:1', 'other tenant');
    const found = await kv.scan('t:a:c:p:', 10);
    expect(found).toHaveLength(2);
    expect(found.every((k) => k.startsWith('t:a:'))).toBe(true);
  });
});

describe('cache-aside', () => {
  it('misses, fills, then hits — and reports stats both times', async () => {
    const kv = kvWith();
    const load = vi.fn(async () => ({ id: 'p1', name: 'alpha' }));
    const stats: string[] = [];

    const first = await cacheAside({
      kv,
      key: cacheKey('t1', 'projects', 1, 'p1'),
      ttlMs: 1000,
      load,
      onStats: (s) => stats.push(`miss=${s.misses} hit=${s.hits}`),
    });
    const second = await cacheAside({
      kv,
      key: cacheKey('t1', 'projects', 1, 'p1'),
      ttlMs: 1000,
      load,
      onStats: (s) => stats.push(`miss=${s.misses} hit=${s.hits}`),
    });

    expect(first).toEqual(second);
    expect(load).toHaveBeenCalledTimes(1);
    expect(stats).toEqual(['miss=1 hit=0', 'miss=0 hit=1']);
  });

  it('serves the request when the cache is broken', async () => {
    // Degraded-mode contract: GET throws, SET throws, loader still answers.
    const kv = {
      get: async () => {
        throw new Error('ECONNRESET');
      },
      set: async () => {
        throw new Error('ECONNRESET');
      },
    } as unknown as MemoryKv;
    const stats: number[] = [];
    await expect(
      cacheAside({
        kv,
        key: 'k',
        ttlMs: 10,
        load: async () => ({ ok: 1 }),
        onStats: (s) => stats.push(s.errors),
      }),
    ).resolves.toEqual({ ok: 1 });
    expect(stats).toEqual([2]); // one for the failed read, one for the failed fill
  });

  it('overwrites a corrupt payload with a fresh read', async () => {
    const kv = kvWith();
    await kv.set('k', '{not json');
    const load = vi.fn(async () => ({ ok: true }));
    const res = await cacheAside({ kv, key: 'k', ttlMs: 100, load });
    expect(res).toEqual({ ok: true });
    expect(load).toHaveBeenCalledTimes(1);
    expect(JSON.parse((await kv.get('k'))!)).toEqual({ ok: true });
  });

  it('skips caching values above maxBytes', async () => {
    const kv = kvWith();
    const big = 'x'.repeat(5000);
    await cacheAside({ kv, key: 'k', ttlMs: 100, maxBytes: 1000, load: async () => ({ big }) });
    expect(await kv.get('k')).toBeUndefined();
  });

  it('coalesces concurrent misses into one loader call', async () => {
    const kv = kvWith();
    let calls = 0;
    const singleflight = new Map<string, Promise<unknown>>();
    const load = async () => {
      calls++;
      await new Promise((r) => setTimeout(r, 5));
      return { value: calls };
    };

    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        cacheAside({ kv, key: 'k', ttlMs: 100, load, singleflight: singleflight as never }),
      ),
    );
    expect(calls).toBe(1);
    expect(results.every((r) => r.value === 1)).toBe(true);
    expect(singleflight.size).toBe(0);
  });

  it('bypasses entirely when disabled', async () => {
    const kv = kvWith();
    const load = vi.fn(async () => 'v');
    await cacheAside({ kv, key: 'k', ttlMs: 100, load, enabled: false });
    await cacheAside({ kv, key: 'k', ttlMs: 100, load, enabled: false });
    expect(load).toHaveBeenCalledTimes(2);
    expect(await kv.get('k')).toBeUndefined();
  });
});

describe('version-tagged invalidation', () => {
  it('a version bump orphans every key from the old generation', async () => {
    const kv = kvWith();
    const verKey = cacheVersionKey('t1', 'projects');
    let ver = await readVersion(kv, verKey);
    expect(ver).toBe(0); // never invalidated

    await kv.set(cacheKey('t1', 'projects', ver, 'list'), '"old"');
    ver = await bumpVersion(kv, verKey);
    expect(ver).toBe(1);

    expect(await kv.get(cacheKey('t1', 'projects', ver, 'list'))).toBeUndefined();
    // The stale entry is still in Redis but unreachable → it ages out on TTL.
    expect(await kv.get(cacheKey('t1', 'projects', 0, 'list'))).toBe('"old"');
  });

  it('readVersion tolerates a missing or corrupt counter', async () => {
    const kv = kvWith();
    expect(await readVersion(kv, 'nope')).toBe(0);
    await kv.set('bad', 'abc');
    expect(await readVersion(kv, 'bad')).toBe(0);
  });
});

describe('jitteredTtl', () => {
  it('stays within ±10% and never returns 0', () => {
    const seen = new Set<number>();
    for (let i = 0; i < 500; i++) {
      const t = jitteredTtl(30_000, 0.1, () => Math.random());
      seen.add(t);
      expect(t).toBeGreaterThanOrEqual(27_000);
      expect(t).toBeLessThanOrEqual(33_000);
    }
    expect(seen.size).toBeGreaterThan(100); // actually spread, not constant
    expect(jitteredTtl(1)).toBeGreaterThan(0);
  });

  it('is deterministic given a seeded rand (used by tests)', () => {
    expect(jitteredTtl(1000, 0.2, () => 0)).toBe(900);
    expect(jitteredTtl(1000, 0.2, () => 1)).toBe(1100);
    expect(jitteredTtl(1000, 0.2, () => 0.5)).toBe(1000);
  });
});
