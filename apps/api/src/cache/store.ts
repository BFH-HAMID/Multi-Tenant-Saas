import {
  bumpVersion,
  cacheAside,
  cacheKey,
  cacheVersionKey,
  readVersion,
  type CacheOutcome,
  type KvClient,
  type PlanLimits,
} from '@saas/shared';
import type { AppMetrics } from '../plugins/metrics.js';

export type CacheEntity = 'projects' | 'project' | 'tenant' | 'members' | 'plans';

export interface FetchOptions<T> {
  tenantId: string;
  entity: CacheEntity;
  /** Page/identity parts, e.g. ['page', cursor] or [projectId]. */
  parts: string[];
  /** Base TTL; scaled by the tenant's plan (enterprise caches live longer). */
  ttlMs: number;
  limits: PlanLimits;
  load: () => Promise<T>;
  /** Explicit kill-switch from config or a per-route `noCache` flag. */
  enabled?: boolean;
  /** Reports the final outcome for response headers (`x-cache: hit|miss|…`). */
  observe?: (outcome: CacheOutcome) => void;
  /** Set for `If-None-Match`-style callers that must see fresh data. */
  bypass?: boolean;
}

/**
 * The API's cache layer: tenant-namespaced keys, version-tagged invalidation,
 * plan-scaled TTLs, in-process stampede coalescing, and hit/miss accounting.
 *
 * Three properties worth defending:
 *  1. **Keys are `t:{tenant}:…` always.** A missing prefix is a cross-tenant
 *     leak, so the only way to build a key is through here (see keys.ts for the
 *     scheme), and `tests/cacheIsolation.int.test.ts` proves it.
 *  2. **Invalidation is a version bump, not a delete-many.** Reads embed the
 *     entity version (`…:projects:v7:page:abc`); a write INCRs the counter and
 *     every previous generation becomes unreachable, expiring on TTL. O(1) on
 *     the write path, and no `SCAN`/`KEYS` in production at all.
 *  3. **The cache is allowed to be wrong and must never be fatal.** Every Kv
 *     failure is swallowed into a miss (see RedisKv.guard) and the loader still
 *     answers; that is what makes a Redis outage a latency event instead of an
 *     outage.
 */
export class CacheStore {
  private readonly singleflight = new Map<string, Promise<unknown>>();
  /** Version counters are read on every cached GET; cache them briefly. */
  private readonly versionMemo = new Map<string, { value: number; until: number }>();
  readonly enabled: boolean;

  constructor(
    private readonly kv: KvClient,
    private readonly metrics: AppMetrics,
    enabled: boolean,
    private readonly versionMemoMs = 250,
  ) {
    this.enabled = enabled;
  }

  private versionKey(tenantId: string, entity: CacheEntity): string {
    return cacheVersionKey(tenantId, entity);
  }

  private async version(tenantId: string, entity: CacheEntity): Promise<number> {
    const memoKey = `${tenantId}:${entity}`;
    const memo = this.versionMemo.get(memoKey);
    if (memo && memo.until > Date.now()) {
      return memo.value;
    }
    const value = await readVersion(this.kv, this.versionKey(tenantId, entity));
    this.versionMemo.set(memoKey, { value, until: Date.now() + this.versionMemoMs });
    return value;
  }

  /**
   * Read-through with a 250ms version memo. The memo is *not* a correctness
   * device (it can serve a stale version for a quarter second, which can only
   * re-serve an already-cached page); it exists so a hot list endpoint does 1
   * Redis round trip for the version instead of 2.
   */
  async fetch<T>(opts: FetchOptions<T>): Promise<T> {
    const enabled = this.enabled && (opts.enabled ?? true) && !opts.bypass;
    const version = enabled ? await this.version(opts.tenantId, opts.entity) : 0;
    const key = enabled ? cacheKey(opts.tenantId, opts.entity, version, ...opts.parts) : '';

    const ttlMs = Math.round(opts.ttlMs * opts.limits.cacheTtlScale);

    if (!enabled) {
      this.metrics.cacheLookups.inc({ outcome: 'bypass', entity: opts.entity });
      opts.observe?.('bypass');
      return opts.load();
    }

    const start = performance.now();
    try {
      return await cacheAside<T>({
        kv: this.kv,
        key,
        ttlMs,
        load: opts.load,
        singleflight: this.singleflight as Map<string, Promise<T | undefined>>,
        onStats: (s) => {
          if (s.hits) {
            opts.observe?.('hit');
          } else if (s.stampedesCoalesced) {
            opts.observe?.('coalesced');
          } else if (s.errors) {
            opts.observe?.('error');
          } else if (s.misses) {
            opts.observe?.('miss');
          }
          if (s.hits) {
            this.metrics.cacheLookups.inc({ outcome: 'hit', entity: opts.entity });
          }
          if (s.misses) {
            this.metrics.cacheLookups.inc({ outcome: 'miss', entity: opts.entity });
          }
          if (s.errors) {
            this.metrics.cacheLookups.inc({ outcome: 'error', entity: opts.entity });
          }
          if (s.stampedesCoalesced) {
            this.metrics.cacheLookups.inc({ outcome: 'coalesced', entity: opts.entity });
          }
        },
      });
    } finally {
      this.metrics.cacheOpDuration.observe(
        { entity: opts.entity },
        (performance.now() - start) / 1000,
      );
    }
  }

  /** Call after any write that can change the entity set for this tenant. */
  async invalidate(tenantId: string, entity: CacheEntity): Promise<void> {
    if (!this.enabled) {
      return;
    }
    const key = this.versionKey(tenantId, entity);
    // The counter must outlive the longest key in the family, or an eviction
    // could resurrect a stale generation. 1h is comfortably > our largest TTL.
    await bumpVersion(this.kv, key, { ttlMs: 3_600_000 });
    this.versionMemo.delete(`${tenantId}:${entity}`);
  }

  /** Direct delete for single-object caches (item keys are not versioned). */
  async deleteRaw(key: string): Promise<void> {
    await this.kv.del(key);
  }

  itemKey(tenantId: string, entity: CacheEntity, id: string): string {
    return cacheKey(tenantId, entity, 0, id);
  }

  async setItem<T>(
    tenantId: string,
    entity: CacheEntity,
    id: string,
    value: T,
    ttlMs: number,
  ): Promise<void> {
    if (!this.enabled) {
      return;
    }
    await this.kv.set(this.itemKey(tenantId, entity, id), JSON.stringify(value), { ttlMs });
  }

  async getItem<T>(tenantId: string, entity: CacheEntity, id: string): Promise<T | undefined> {
    if (!this.enabled) {
      return undefined;
    }
    const raw = await this.kv.get(this.itemKey(tenantId, entity, id));
    if (raw === undefined) {
      this.metrics.cacheLookups.inc({ outcome: 'miss', entity });
      return undefined;
    }
    this.metrics.cacheLookups.inc({ outcome: 'hit', entity });
    try {
      return JSON.parse(raw) as T;
    } catch {
      this.metrics.cacheLookups.inc({ outcome: 'error', entity });
      return undefined;
    }
  }

  /** Uncached pass-throughs for non-tenant key spaces (tenant lookups). */
  async rawGet(key: string): Promise<string | undefined> {
    if (!this.enabled) {
      return undefined;
    }
    return this.kv.get(`sys:${key}`);
  }

  async rawSet(key: string, value: string, ttlMs: number): Promise<void> {
    if (!this.enabled) {
      return;
    }
    await this.kv.set(`sys:${key}`, value, { ttlMs });
  }

  async rawDel(key: string): Promise<void> {
    await this.kv.del(`sys:${key}`);
  }

  /** Debug/ops only: how many keys for a tenant (never call on the hot path). */
  async countTenantKeys(tenantId: string): Promise<number> {
    return (await this.kv.scan(`t:${tenantId}:c:`, 1000)).length;
  }
}
