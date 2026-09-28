import { createMetrics, type WorkerMetrics } from '../../src/metrics.js';
import type { JobEnvelope } from '../../src/jobs.js';

/** Shared test seams for the worker suite: metrics, logging, and a claim stub. */

export function testMetrics(): WorkerMetrics {
  // The real metric objects on their own registry, so label names are validated
  // by every test that touches them.
  return createMetrics({
    version: 'test',
    sha: 'test',
    env: 'test',
    driver: 'test',
    nodeEnv: 'test',
  });
}

export const silentLog = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  fatal: () => {},
  child: () => silentLog,
} as never;

/** Collects what a worker wrote to its logger, for assertions on log *decisions*. */
export function recordingLog() {
  const lines: Array<{ level: string; msg: string; obj: Record<string, unknown> }> = [];
  const push = (level: string) => (obj: object, msg?: string) => {
    lines.push({ level, msg: msg ?? '', obj: obj as Record<string, unknown> });
  };
  const log = {
    info: push('info'),
    warn: push('warn'),
    error: push('error'),
    debug: push('debug'),
    fatal: push('fatal'),
    child: () => log,
    lines,
  };
  return log as typeof log & { lines: typeof lines };
}

/**
 * Total of a labelled counter, read back out of prom-client.
 * `Registry.metrics()` returns the *exposition text*; `getMetricsAsJSON()` is the
 * structured view — mixing them up yields a silent 0, which is worse than an error.
 */
export type RegistryLike = {
  getMetricsAsJSON(): Promise<
    Array<{ name: string; values?: Array<{ labels?: Record<string, string>; value?: number }> }>
  >;
};

export async function counterValue(
  registry: RegistryLike,
  name: string,
  labelValue: string,
): Promise<number> {
  for (const metric of await registry.getMetricsAsJSON()) {
    if (metric.name !== name && `${metric.name}_total` !== name) {
      continue;
    }
    const hit = (metric.values ?? []).find((v) =>
      Object.values(v.labels ?? {}).includes(labelValue),
    );
    if (hit) {
      return hit.value ?? 0;
    }
  }
  return 0;
}

export function envelopeFrom(over: Partial<JobEnvelope> = {}): JobEnvelope {
  return {
    topic: 'report.generate' as JobEnvelope['topic'],
    tenantId: '11111111-1111-4111-8111-111111111111',
    payload: {},
    idempotencyKey: 'job:test:abc',
    attempts: 1,
    maxAttempts: 3,
    source: 'outbox',
    ...over,
  };
}
