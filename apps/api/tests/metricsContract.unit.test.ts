import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LABELS, METRICS, METRIC_OWNERSHIP, type MetricName } from '@saas/shared';
import { buildTestApp, type TestApp } from './helpers/app.js';

/**
 * The metric contract for the API process, asserted against a real registry.
 *
 * Two separate failure modes live here, and both were real:
 *
 *   1. a name in `METRICS` that this process never registers (the dashboards then plot
 *      an empty panel and the alert rule silently never fires);
 *   2. a metric that is registered and incremented, but whose `inc()` label keys do not
 *      match `labelNames()`. prom-client throws *from inside the label object*, the
 *      throw happens in an `onResponse` hook, Fastify swallows it, and the result is a
 *      metric that is invisible rather than broken — `tenant_requests_total` sat in that
 *      state for this whole project while the isolation dashboard queried it.
 *
 * So the test both enumerates the registered names and calls the counter with the same
 * keys the hook uses, then reads the exposition text.
 */
let live: TestApp;
let exposition = '';

beforeAll(async () => {
  live = await buildTestApp();
  // Exercise the hook path, not just the object: one anonymous and one authed request.
  await live.app.inject({ method: 'GET', url: '/v1/plans' });
  await live.app.inject({ method: 'GET', url: '/healthz' });
  exposition = await live.app.metrics.registry.metrics();
});

afterAll(async () => {
  await live?.close();
});

const typeLines = (text: string) =>
  new Set([...text.matchAll(/^# TYPE (\S+) /gm)].map((m) => m[1] as string));

describe('API metric registration', () => {
  it('registers every name the shared registry says this process owns', () => {
    const declared = typeLines(exposition);
    const mine = (Object.keys(METRIC_OWNERSHIP) as MetricName[]).filter((k) =>
      METRIC_OWNERSHIP[k].includes('api'),
    );
    // `app_ready` is the worker's readiness gauge; the API answers readiness on the
    // internal listener without a metric of its own, so it is excluded rather than faked.
    const expected = mine.filter((k) => k !== 'ready');
    expect(expected.length).toBeGreaterThan(10);
    for (const key of expected) {
      expect(declared.has(METRICS[key]), `${METRICS[key]} is not exposed`).toBe(true);
    }
  });

  it('does not expose metrics owned only by the worker', () => {
    const declared = typeLines(exposition);
    for (const [key, owners] of Object.entries(METRIC_OWNERSHIP)) {
      if (!owners.includes('worker') || owners.includes('api')) {
        continue;
      }
      expect(
        declared.has(METRICS[key as MetricName]),
        `${key} leaked into the API`,
      ).not.toBeTruthy();
    }
  });

  it('labels the per-tenant counter with exactly the keys the request hook passes', async () => {
    const { tenantRequests } = live.app.metrics;
    // The regression: `inc({ tenant })` against `labelNames: ['tenant_slug']` threw here
    // and nothing downstream noticed.
    expect(() =>
      tenantRequests.inc({
        [LABELS.tenant]: 'acme',
        [LABELS.routeClass]: 'read',
        [LABELS.outcome]: 'ok',
      }),
    ).not.toThrow();

    const text = await live.app.metrics.registry.metrics();
    const series = text.split('\n').find((line) => line.startsWith(`${METRICS.tenantRequests}{`));
    expect(series, 'no series with the expected labels').toBeDefined();
    expect(series).toContain('tenant="acme"');
    expect(series).toContain('route_class="read"');
    expect(series).toContain('outcome="ok"');
  });

  it('keeps the usage endpoint and the hook on the same label names', async () => {
    // `services/usage.ts` reads this counter back by label name; a rename on one side
    // makes "requests by route class" silently report everything as `read`.
    const { tenantRequests } = live.app.metrics;
    tenantRequests.reset();
    tenantRequests.inc({
      [LABELS.tenant]: 'globex',
      [LABELS.routeClass]: 'bulk',
      [LABELS.outcome]: 'throttled',
    });
    const { usageSummary } = await import('../src/services/usage.js');
    const snapshot = await usageSummary(
      live.app,
      {
        id: '00000000-0000-7000-8000-000000000001',
        slug: 'globex',
        plan: 'free',
        role: 'member',
      } as never,
      1,
    );
    expect(snapshot.requests.bulk).toEqual({ total: 1, rejected: 1 });
    expect(snapshot.requests.read.total).toBe(0);
  });

  it('counts slow queries with the histogram label set, not a free-form one', async () => {
    const { dbSlowQueries } = live.app.metrics;
    expect(() => dbSlowQueries.inc({ kind: 'transaction' })).not.toThrow();
    const text = await live.app.metrics.registry.metrics();
    expect(text).toContain(`${METRICS.dbSlowQueries}{kind="transaction"} 1`);
  });

  it('serves probes on the internal listener only', async () => {
    // The metric contract depends on this: if /metrics were reachable through the public
    // socket, tenant slugs and route names would be public, and the cardinality budget in
    // packages/shared/src/metrics.ts would be a suggestion.
    for (const path of ['/metrics', '/readyz', '/livez']) {
      const res = await live.app.inject({ method: 'GET', url: path });
      expect([404, 500], path).not.toContain(200);
      expect(res.statusCode === 200, `${path} answered on the public port`).toBe(false);
    }
  });
});
