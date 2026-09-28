/**
 * Plan catalogue — the single source of truth for entitlements.
 *
 * Everything that varies by paid tier (rate limits, member seats, project
 * quota, queue concurrency, cache TTL) is declared here once and then:
 *   - seeded into `plans` (db/seed.ts) for reporting / future self-serve billing,
 *   - read by the API rate limiter (per-tenant bucket geometry),
 *   - read by the API to reject quota violations with a typed 402/403,
 *   - referenced by the load tests so thresholds match reality.
 *
 * Deliberately NOT stored in Postgres as the authoritative copy for the hot
 * path: a plan lookup per request would add a DB round trip to every request,
 * and limits change ~monthly. The `tenants.plan` column stores the tier id;
 * limits are resolved from this module (and cached per tenant on the request
 * object). See docs/adr/0004-rate-limiting-token-bucket.md.
 */

export const PLAN_IDS = ['free', 'pro', 'enterprise'] as const;
export type PlanId = (typeof PLAN_IDS)[number];

/** Bucket geometry for one route class. `refillPerSec` tokens are added
 *  continuously; `capacity` is the max burst. Both are per tenant. */
export interface BucketSpec {
  capacity: number;
  refillPerSec: number;
}

export interface RouteClass {
  /** Identifier used in Redis keys and metric labels. */
  id: string;
  /** Human description for /plans and docs. */
  description: string;
}

export interface PlanLimits {
  plan: PlanId;
  /** Default bucket when a route is not explicitly mapped to a class. */
  default: BucketSpec;
  /** Per-route-class overrides. */
  routes: Record<string, BucketSpec>;
  maxMembers: number;
  maxProjects: number;
  /** Reports the tenant may have in flight (queued or processing) at once. */
  maxConcurrentJobs: number;
  /** Cache TTL multiplier: enterprise data is cached longer because their
   *  read:write ratio is higher and staleness matters less to them. */
  cacheTtlScale: number;
  /** Worker concurrency granted to this tenant inside a shared worker pool. */
  workerConcurrency: number;
}

export const READ_CLASS = 'read';
export const WRITE_CLASS = 'write';
export const AUTH_CLASS = 'auth';
export const BULK_CLASS = 'bulk';

export const ROUTE_CLASSES: Record<string, RouteClass> = {
  [READ_CLASS]: { id: READ_CLASS, description: 'GET/HEAD collection and item reads' },
  [WRITE_CLASS]: { id: WRITE_CLASS, description: 'POST/PATCH/PUT/DELETE mutations' },
  [AUTH_CLASS]: { id: AUTH_CLASS, description: 'credential endpoints (login, refresh, register)' },
  [BULK_CLASS]: { id: BULK_CLASS, description: 'exports and report generation' },
};

const bucket = (capacity: number, perMinute: number): BucketSpec => ({
  capacity,
  // refillPerSec so the bucket math is time-based, not window-based.
  refillPerSec: Number((perMinute / 60).toFixed(4)),
});

export const PLANS: Record<PlanId, PlanLimits> = {
  free: {
    plan: 'free',
    default: bucket(60, 120),
    routes: {
      [READ_CLASS]: bucket(120, 300),
      [WRITE_CLASS]: bucket(30, 60),
      [AUTH_CLASS]: bucket(10, 20),
      [BULK_CLASS]: bucket(2, 2),
    },
    maxMembers: 5,
    maxProjects: 10,
    maxConcurrentJobs: 1,
    cacheTtlScale: 1,
    workerConcurrency: 1,
  },
  pro: {
    plan: 'pro',
    default: bucket(600, 1200),
    routes: {
      [READ_CLASS]: bucket(1200, 6000),
      [WRITE_CLASS]: bucket(300, 1200),
      [AUTH_CLASS]: bucket(60, 120),
      [BULK_CLASS]: bucket(20, 30),
    },
    maxMembers: 50,
    maxProjects: 250,
    maxConcurrentJobs: 5,
    cacheTtlScale: 2,
    workerConcurrency: 4,
  },
  enterprise: {
    plan: 'enterprise',
    default: bucket(6000, 12000),
    routes: {
      [READ_CLASS]: bucket(12000, 60000),
      [WRITE_CLASS]: bucket(3000, 12000),
      [AUTH_CLASS]: bucket(600, 1200),
      [BULK_CLASS]: bucket(200, 300),
    },
    maxMembers: 5000,
    maxProjects: 100000,
    maxConcurrentJobs: 50,
    cacheTtlScale: 4,
    workerConcurrency: 16,
  },
};

export function isPlanId(value: string): value is PlanId {
  return (PLAN_IDS as readonly string[]).includes(value);
}

export function planLimits(plan: string | null | undefined): PlanLimits {
  const id: PlanId = typeof plan === 'string' && isPlanId(plan) ? plan : 'free';
  return PLANS[id];
}

/** Resolve the bucket geometry that applies to (plan, routeClass). */
export function bucketFor(plan: PlanId, routeClass: string): BucketSpec {
  const limits = PLANS[plan];
  return limits.routes[routeClass] ?? limits.default;
}
