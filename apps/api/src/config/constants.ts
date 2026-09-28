import type { PlanId } from '@saas/shared';

/** Header/claim names, route classes and the unauthenticated bucket. */

export const API_PREFIX = '/v1';
export const HEALTH_PATH = '/healthz';
export const READY_PATH = '/readyz';
export const LIVE_PATH = '/livez';

/** Response header we always echo so a client (or a load test) can correlate a
 *  429/500 with a server log line without reading the log format. */
export const REQUEST_ID_HEADER = 'x-request-id';
export const TENANT_HEADER = 'x-tenant-id';
export const TENANT_SLUG_HEADER = 'x-tenant-slug';
export const IDEMPOTENCY_HEADER = 'idempotency-key';
export const RATE_LIMIT_SOURCE_HEADER = 'x-ratelimit-source';

/** Per-IP budget for credential endpoints, applied *before* tenant resolution.
 *  Deliberately plan-independent: it protects the login path from attackers who
 *  have no tenant at all (credential stuffing). */
/** @deprecated anon/credential routes reuse the plan `auth` bucket plus an
 * IP-scoped mirror; the edge applies a coarse per-IP limit. See ADR-0003. */
export const ANON_BUCKET = {
  capacity: 20,
  refillPerSec: 1 / 3, // 20/min sustained per client IP per route class
};

export const AUTH_ROUTES = [
  '/v1/auth/login',
  '/v1/auth/register',
  '/v1/auth/refresh',
  '/v1/auth/password',
];

/** Route class assignment rules (docs/ARCHITECTURE.md "Rate limiting"). */
export type RouteClass = 'read' | 'write' | 'auth' | 'bulk';

export function routeClassFor(method: string, url: string, declared?: RouteClass): RouteClass {
  if (declared) {
    return declared;
  }
  const path = url.split('?')[0] ?? url;
  if (AUTH_ROUTES.some((p) => path.startsWith(p))) {
    return 'auth';
  }
  if (path.endsWith('/reports') || path.includes('/export')) {
    return 'bulk';
  }
  return method === 'GET' || method === 'HEAD' ? 'read' : 'write';
}

/** Which plan limits apply to which verb — kept declarative so the docs table
 *  and the code cannot disagree. */
export const ROUTE_CLASS_BY_METHOD: Record<string, RouteClass> = {
  GET: 'read',
  HEAD: 'read',
  OPTIONS: 'read',
  POST: 'write',
  PATCH: 'write',
  PUT: 'write',
  DELETE: 'write',
};

export const TENANT_CACHE_TTL_MS = 60_000;

/** Cache TTLs by entity, before plan scaling. */
export const CACHE_TTL_MS = {
  projectItem: 30_000,
  projectList: 10_000,
  tenant: 60_000,
  members: 20_000,
  plan: 300_000,
} as const;

export const MAX_LIST_LIMIT = 100;

/** Ids we hand to clients in errors; never an internal uuid of another tenant. */
export const GENERIC_NOT_FOUND = 'Resource not found';

/** Metrics: top-N tenants to label individually (cardinality budget). */
export const TENANT_METRIC_TOP_N = 20;

export const PLAN_ORDER: PlanId[] = ['free', 'pro', 'enterprise'];
