import { bucketFor, LABELS, type PlanId } from '@saas/shared';
import type { FastifyInstance } from 'fastify';
import type { RouteClass } from '../config/constants.js';
import type { ResolvedTenant } from '../types.js';

export interface UsageSnapshot {
  window: string;
  note: string;
  requests: Record<RouteClass, { total: number; rejected: number }>;
  throttled: number;
  cache: { hitRatio: number | null };
  bucketGeometry: Record<RouteClass, { capacity: number; refillPerSec: number }>;
  membership: { projects: number; archived: number };
}

/**
 * "What is my traffic doing right now?" — a tenant-facing read of the *same*
 * counters Prometheus scrapes, so the number in this endpoint and the number on
 * the Grafana panel cannot disagree.
 *
 * Honest limitation, stated in the response body: this is this pod's in-process
 * counter, not the cluster total. Cross-pod totals belong in PromQL
 * (`sum by (tenant) (rate(tenant_requests_total[5m]))`); an API endpoint that
 * pretended to have them would need a shared counter — a Redis INCR per request,
 * which is exactly the write amplification the limiter design refuses.
 *
 * The route-class totals double as the noisy-neighbour evidence: `rejected` is
 * the number of requests this tenant was *not* served, and it is derived from the
 * same label set the alert `TenantThrottledRateHigh` queries.
 */
export async function usageSummary(
  app: FastifyInstance,
  tenant: ResolvedTenant,
  days: number,
): Promise<UsageSnapshot> {
  const classes: RouteClass[] = ['read', 'write', 'auth', 'bulk'];
  const requests = {} as UsageSnapshot['requests'];
  for (const c of classes) {
    requests[c] = { total: 0, rejected: 0 };
  }

  const tenantCounter = await app.metrics.tenantRequests.get();
  for (const value of tenantCounter.values) {
    // Read with the same constants the hook writes with. This function is the only
    // consumer of the per-tenant counter outside the metrics plugin, and a renamed label
    // here degrades silently into "everything was a read request" rather than failing.
    if (value.labels?.[LABELS.tenant] !== tenant.slug) {
      continue;
    }
    const cls = (value.labels?.[LABELS.routeClass] ?? 'read') as RouteClass;
    if (!requests[cls]) {
      requests[cls] = { total: 0, rejected: 0 };
    }
    requests[cls].total += value.value;
    // `ok | throttled | error` — the exact set the onResponse hook writes (see
    // plugins/metrics.ts). 'rejected' used to be listed here, for a counter that
    // never wrote it: a quota 402 is an error outcome of the *route*, not a rejection.
    const outcome = value.labels?.[LABELS.outcome] ?? 'ok';
    if (outcome === 'throttled') {
      requests[cls].rejected += value.value;
    }
  }

  const lookups = { hit: 0, miss: 0, error: 0, coalesced: 0, bypass: 0 };
  const cacheCounter = await app.metrics.cacheLookups.get();
  for (const value of cacheCounter.values) {
    const outcome = (value.labels?.['outcome'] ?? 'miss') as keyof typeof lookups;
    lookups[outcome] = (lookups[outcome] ?? 0) + value.value;
  }
  // Only hit/(hit+miss) counts: a `bypass` (cache disabled for this request) or
  // an `error` (Redis unreachable) must not be scored as a miss, or the number
  // means "cache usefulness during an outage" instead of "hit ratio".
  const answerable = lookups.hit + lookups.miss;

  const plan: PlanId = tenant.plan;
  const bucketGeometry = {} as UsageSnapshot['bucketGeometry'];
  for (const c of classes) {
    const spec = bucketFor(plan, c);
    bucketGeometry[c] = { capacity: spec.capacity, refillPerSec: spec.refillPerSec };
  }

  return {
    window: `${days}d (per-pod counters)`,
    note: 'Cluster-wide rates belong in PromQL; these are this replica’s counters.',
    requests,
    throttled: Object.values(requests).reduce((a, b) => a + b.rejected, 0),
    cache: { hitRatio: answerable > 0 ? Number((lookups.hit / answerable).toFixed(4)) : null },
    bucketGeometry,
    membership: await app.projects.counts(tenant.id),
  };
}
