/**
 * Key naming scheme — one place, because a key layout bug in a shared cache is
 * a cross-tenant data leak, not a bug.
 *
 * Rules:
 *   1. Every tenant-scoped key starts with `t:{tenantId}:` — so `MEMORY USAGE`
 *      sampling, `SCAN MATCH`, and a per-tenant flush all work, and a reviewer
 *      can grep any code path and prove the prefix is there.
 *   2. `{}`-free keys (no hash tags) because we run single-node Redis per
 *      purpose; if we move to cluster mode, tenantId becomes the hash tag.
 *   3. Version-suffixed list keys mean invalidation is O(1) writes instead of
 *      a scan: bump the version and the old keys fall out on TTL.
 */

export const CACHE_PREFIX = 'c';
export const RL_PREFIX = 'rl';
export const LOCK_PREFIX = 'lk';
export const IDEM_PREFIX = 'idm';

export function tenantPrefix(tenantId: string): string {
  return `t:${tenantId}:`;
}

/** `t:{tenant}:c:projects:v12:page:abc` */
export function cacheKey(
  tenantId: string,
  entity: string,
  version: number,
  ...parts: string[]
): string {
  const tail = parts.filter(Boolean).join(':');
  return `${tenantPrefix(tenantId)}${CACHE_PREFIX}:${entity}:v${version}${tail ? `:${tail}` : ''}`;
}

/** Monotonic per-tenant, per-entity version used for O(1) invalidation. */
export function cacheVersionKey(tenantId: string, entity: string): string {
  return `${tenantPrefix(tenantId)}${CACHE_PREFIX}:${entity}:ver`;
}

export function lockKey(tenantId: string, what: string): string {
  return `${tenantPrefix(tenantId)}${LOCK_PREFIX}:${what}`;
}

export function idempotencyKey(tenantId: string, key: string): string {
  return `${tenantPrefix(tenantId)}${IDEM_PREFIX}:${key}`;
}

/** Negative-cache marker: a string we can distinguish from a real payload. */
export const CACHE_MISS_SENTINEL = '__miss__';

/**
 * TTL with jitter. Without jitter, a warm cache that was populated in one
 * burst expires in one burst (thundering herd on Postgres). ±10% by default.
 */
export function jitteredTtl(
  ttlMs: number,
  jitterRatio = 0.1,
  rand: () => number = Math.random,
): number {
  const spread = ttlMs * jitterRatio;
  return Math.max(1, Math.round(ttlMs - spread / 2 + rand() * spread));
}
