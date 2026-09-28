import { describe, expect, it } from 'vitest';
import { METRICS, METRIC_OWNERSHIP, type MetricName } from '@saas/shared';
import { createMetrics } from '../src/metrics.js';

/**
 * Same contract as `apps/api/tests/metricsContract.unit.test.ts`, for the process that
 * owns the queue metrics. The worker is where a "the queue is empty" dashboard is most
 * likely to be a lie — it has the only view of the outbox ledger, and a relay that
 * stopped ticking produces exactly the same exposition as a queue that is genuinely
 * drained, unless `worker_relay_ticks_total` is there to tell them apart.
 */
const metrics = createMetrics({
  version: 'test',
  sha: 'abc',
  env: 'test',
  driver: 'outbox',
  nodeEnv: 'test',
});

describe('worker metric registration', () => {
  it('registers every name the shared registry says this process owns', async () => {
    const text = await metrics.registry.metrics();
    const declared = new Set([...text.matchAll(/^# TYPE (\S+) /gm)].map((m) => m[1] as string));
    const mine = (Object.keys(METRIC_OWNERSHIP) as MetricName[]).filter((k) =>
      METRIC_OWNERSHIP[k].includes('worker'),
    );
    expect(mine.length).toBeGreaterThan(8);
    for (const key of mine) {
      expect(declared.has(METRICS[key]), `${METRICS[key]} is not exposed`).toBe(true);
    }
  });

  it('names the process on every series so one Prometheus query can tell them apart', async () => {
    // `registry.setDefaultLabels({service})` is what makes `sum by (service)` work; the
    // API does not set it, because its job label comes from the scrape config.
    const text = await metrics.registry.metrics();
    expect(text).toContain('service="worker"');
  });

  it('labels the dead-letter depth with the queue label, and reports zero when idle', async () => {
    // A gauge with no observations is absent from the exposition, and `absent()` is not
    // something an operator wants to reason about at 3am — so the gauges that answer
    // "is anything stuck" must be initialised, and this test is what enforces that.
    const text = await metrics.registry.metrics();
    expect(text).toMatch(new RegExp(`${METRICS.queueDeadLetterDepth}.* 0`, 's'));
    expect(text).toMatch(new RegExp(`${METRICS.outboxPending}.* 0`, 's'));
  });

  it('counts slow queries per statement kind', async () => {
    expect(() => metrics.dbSlowQueries.inc({ kind: 'query' })).not.toThrow();
    const text = await metrics.registry.metrics();
    expect(text).toContain(`${METRICS.dbSlowQueries}{kind="query",service="worker"} 1`);
  });
});
