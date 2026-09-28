import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';
import { DB_BUCKETS, HTTP_BUCKETS, LABELS, METRICS } from '@saas/shared';
import type { AppConfig } from '../config/index.js';
import { printableConfig } from '../config/index.js';
import { TENANT_METRIC_TOP_N } from '../config/constants.js';

/**
 * The label set of `tenant_requests_total`, spelled once. The registration, the
 * interface and every `inc()` call reference this, so they cannot drift — the first
 * `inc()` with a key that is not in `labelNames()` throws inside `onResponse`, Fastify
 * swallows an onResponse error, and the series simply never appears. The symptom is a
 * dashboard that says "that tenant sent no traffic", which reads as a healthy system
 * and is actually a broken metric.
 */
export const TENANT_REQUEST_LABELS = [LABELS.tenant, LABELS.routeClass, LABELS.outcome] as const;
export type TenantRequestLabel = (typeof TENANT_REQUEST_LABELS)[number];

export interface AppMetrics {
  registry: Registry;
  httpDuration: Histogram<'method' | 'route' | 'status' | 'status_class'>;
  httpRequests: Counter<'method' | 'route' | 'status'>;
  httpErrors: Counter<'route' | 'class' | 'code'>;
  httpInFlight: Gauge<string>;
  // Label generics are label *names* (prom-client's convention), so the values
  // stay `string` everywhere: a tenant slug in a latency histogram is the classic
  // cardinality mistake this API refuses to make (see TenantAllowList below).
  cacheLookups: Counter<'outcome' | 'entity'>;
  cachePayloadBytes: Histogram<'entity'>;
  cacheOpDuration: Histogram<'entity'>;
  rateLimitDecisions: Counter<'outcome' | 'plan'>;
  tenantRequests: Counter<TenantRequestLabel>;
  dbQueryDuration: Histogram<string>;
  dbSlowQueries: Counter<'kind'>;
  dbPool: Gauge<'state'>;
  dependencyUp: Gauge<'dependency'>;
  authEvents: Counter<'event'>;
  idempotency: Counter<'outcome'>;
  outbox: Counter<'topic'>;
  queueJobs: Gauge<'queue' | 'state'>;
  queueOldestPending: Gauge<'queue'>;
  outboxPending: Gauge<string>;
  outboxLag: Gauge<string>;
  tenantAllowList: TenantAllowList;
  scrapeCount: Counter<string>;
}

/**
 * Bounded per-tenant labelling. We count per-tenant traffic (needed for the
 * noisy-neighbour panel and for a "who is being throttled" alert) but never per
 * *user*, and we freeze to the top-N tenants after the first 2N distinct ones.
 *
 * The alternative — a tenant label on a latency histogram — is 10k tenants ×
 * 30 routes × 12 buckets of series, which is how a Prometheus installation dies
 * in a shared-DB multi-tenant system. If per-tenant latency is genuinely
 * needed, it belongs in a trace (tail-sampled), not in the metric label set.
 */
export class TenantAllowList {
  private readonly counts = new Map<string, number>();
  private frozen: Set<string> | null = null;

  constructor(private readonly max: number) {}

  observe(slug: string): void {
    if (this.frozen) {
      return;
    }
    this.counts.set(slug, (this.counts.get(slug) ?? 0) + 1);
    if (this.counts.size >= this.max * 2) {
      this.freeze();
    }
  }

  private freeze(): void {
    this.frozen = new Set(
      [...this.counts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, this.max)
        .map(([slug]) => slug),
    );
    this.counts.clear();
  }

  isTracked(slug: string): boolean {
    return this.frozen === null || this.frozen.has(slug);
  }
}

export interface InternalServer {
  instance: FastifyInstance;
  close: () => Promise<void>;
  /** Set by app.ts once readiness checks exist. */
  readinessProbe?: () => Promise<ReadinessReport>;
}

export interface ReadinessReport {
  ok: boolean;
  checks: Record<string, unknown>;
}

/**
 * Creates the Prometheus registry, the request-lifecycle instrumentation, and
 * the *internal* listener (metrics + health). Returns the metric handles; the
 * dependency gauges (pg pool, Redis, queue depth, outbox lag) are attached in
 * `metrics/collectors.ts` once those plugins exist.
 *
 * Why a second port for /metrics: it is unauthenticated (every scraper in the
 * cluster would otherwise need a token) and it leaks route shape. On 9464 the
 * only way to reach it is to be inside the pod network, which is also exactly
 * where ServiceMonitor/podTargets live.
 */
export async function registerMetrics(
  app: FastifyInstance,
  cfg: AppConfig,
): Promise<{ metrics: AppMetrics; internal: InternalServer }> {
  const register = new Registry();
  collectDefaultMetrics({ register, prefix: 'nodejs_' });

  const metrics: AppMetrics = {
    registry: register,
    httpDuration: new Histogram({
      name: METRICS.httpRequestDuration,
      help: 'HTTP request duration in seconds by route template and status.',
      labelNames: [LABELS.method, LABELS.route, LABELS.status, 'status_class'] as const,
      buckets: HTTP_BUCKETS,
      registers: [register],
    }),
    httpRequests: new Counter({
      name: METRICS.httpRequests,
      help: 'Total HTTP requests by route, method and status.',
      labelNames: [LABELS.method, LABELS.route, LABELS.status] as const,
      registers: [register],
    }),
    httpErrors: new Counter({
      name: METRICS.httpErrors,
      help: 'HTTP responses with status >= 400, split by client/server class.',
      labelNames: ['route', 'class', 'code'] as const,
      registers: [register],
    }),
    httpInFlight: new Gauge({
      name: METRICS.httpInFlight,
      help: 'Requests currently in flight (saturation).',
      registers: [register],
    }),
    cacheLookups: new Counter({
      name: METRICS.cacheLookups,
      help: 'Cache lookups by outcome; hit/(hit+miss) is the hit-ratio panel.',
      labelNames: [LABELS.outcome, 'entity'] as const,
      registers: [register],
    }),
    cachePayloadBytes: new Histogram({
      name: METRICS.cachePayloadBytes,
      help: 'Serialized size of cached payloads, by entity.',
      labelNames: ['entity'] as const,
      buckets: [256, 1024, 4096, 16384, 65536, 262144],
      registers: [register],
    }),
    cacheOpDuration: new Histogram({
      name: METRICS.cacheOpDuration,
      help: 'Time spent in the cache layer (lookup + fill), by entity. Compare with request latency to see the cache paying for itself.',
      labelNames: ['entity'] as const,
      buckets: [0.0002, 0.0005, 0.001, 0.0025, 0.005, 0.01, 0.025, 0.1],
      registers: [register],
    }),
    rateLimitDecisions: new Counter({
      name: METRICS.rateLimitDecisions,
      help: 'Token bucket decisions by outcome and plan.',
      labelNames: [LABELS.outcome, LABELS.plan] as const,
      registers: [register],
    }),
    tenantRequests: new Counter({
      name: METRICS.tenantRequests,
      help: `Per-tenant request/rejection counter for the top ${TENANT_METRIC_TOP_N} tenants.`,
      labelNames: TENANT_REQUEST_LABELS,
      registers: [register],
    }),
    dbSlowQueries: new Counter({
      name: METRICS.dbSlowQueries,
      help: 'Statements slower than PG_SLOW_QUERY_MS, by kind. Same threshold as the "slow query" log line, so the metric and the server log reconcile during an incident instead of each having its own idea of slow.',
      labelNames: ['kind'] as const,
      registers: [register],
    }),
    dbQueryDuration: new Histogram({
      name: METRICS.dbQueryDuration,
      help: 'Postgres query/transaction duration in seconds.',
      labelNames: ['kind'] as const,
      // DB_BUCKETS, not HTTP_BUCKETS: 1ms and 5ms are the interesting resolutions for a
      // query, and a histogram whose first bucket is 5ms cannot answer "was the DB or the
      // app slow" for any of the requests that matter.
      buckets: DB_BUCKETS,
      registers: [register],
    }),
    dbPool: new Gauge({
      name: METRICS.dbPool,
      help: 'pg.Pool state. Sustained waiting>0 means the pool (or Postgres) is the bottleneck.',
      labelNames: ['state'] as const,
      registers: [register],
    }),
    dependencyUp: new Gauge({
      name: METRICS.redisUp,
      help: '1 when a dependency answered the last probe (dependency label: cache_redis, queue_redis).',
      labelNames: ['dependency'] as const,
      registers: [register],
    }),
    authEvents: new Counter({
      name: METRICS.authEvents,
      help: 'Auth lifecycle events: login_success, login_failure, refresh, reuse_detected, …',
      labelNames: ['event'] as const,
      registers: [register],
    }),
    idempotency: new Counter({
      name: METRICS.idempotencyKeys,
      help: 'Idempotency-Key outcomes: stored, replayed, conflict.',
      labelNames: [LABELS.outcome] as const,
      registers: [register],
    }),
    outbox: new Counter({
      name: METRICS.outboxPublished,
      help: 'Outbox rows enqueued by this pod, by topic.',
      labelNames: ['topic'] as const,
      registers: [register],
    }),
    queueJobs: new Gauge({
      name: METRICS.queueJobs,
      help: 'BullMQ job counts by queue and state (waiting/active/delayed/failed/completed).',
      labelNames: [LABELS.queue, 'state'] as const,
      registers: [register],
    }),
    queueOldestPending: new Gauge({
      name: METRICS.queueOldestPending,
      help: 'Age in seconds of the oldest waiting job — the user-visible queue delay metric.',
      labelNames: [LABELS.queue] as const,
      registers: [register],
    }),
    outboxPending: new Gauge({
      name: METRICS.outboxPending,
      help: 'Rows awaiting publish in the transactional outbox.',
      registers: [register],
    }),
    outboxLag: new Gauge({
      name: METRICS.outboxLag,
      help: 'Seconds between now and the oldest pending outbox row.',
      registers: [register],
    }),
    tenantAllowList: new TenantAllowList(TENANT_METRIC_TOP_N),
    scrapeCount: new Counter({
      name: METRICS.metricsScrapes,
      help: 'Scrapes served by this pod (tells you a scrape is actually landing).',
      registers: [register],
    }),
  };

  new Gauge({
    name: METRICS.appInfo,
    help: 'Build/runtime metadata as label values.',
    labelNames: ['version', 'sha', 'env', 'queue_driver', 'cache'] as const,
    registers: [register],
  }).set(
    {
      version: cfg.env.BUILD_VERSION,
      sha: cfg.env.BUILD_SHA,
      env: cfg.env.NODE_ENV,
      queue_driver: cfg.env.QUEUE_DRIVER,
      cache: cfg.env.REDIS_CACHE_URL.startsWith('memory') ? 'memory' : 'redis',
    },
    1,
  );

  // Decoration lives here (not in app.ts) so nothing can use the metrics object
  // without the instance having been wired: `app.metrics` is the only handle the
  // hooks and services need, and a missing decoration then fails at boot, not as
  // a 500 on the first request.
  app.decorate('metrics', metrics);

  // ------------------------------- request instrumentation -------------------
  app.addHook('onRequest', (req: FastifyRequest, _reply: FastifyReply, done) => {
    metrics.httpInFlight.inc();
    req.auditStartMs = performance.now();
    done();
  });

  app.addHook('onResponse', (req: FastifyRequest, reply: FastifyReply, done) => {
    metrics.httpInFlight.dec();
    const route = routeTemplate(req);
    const status = reply.statusCode;
    const seconds = (performance.now() - (req.auditStartMs ?? performance.now())) / 1000;

    metrics.httpDuration.observe(
      { method: req.method, route, status: String(status), status_class: statusClass(status) },
      seconds,
    );
    metrics.httpRequests.inc({ method: req.method, route, status: String(status) });
    if (status >= 400) {
      metrics.httpErrors.inc({ route, class: status >= 500 ? '5xx' : '4xx', code: String(status) });
    }

    const slug = req.tenant?.slug;
    if (slug) {
      metrics.tenantAllowList.observe(slug);
      if (metrics.tenantAllowList.isTracked(slug)) {
        metrics.tenantRequests.inc({
          // Both sides of a metric's label contract go through LABELS on purpose: the
          // first `inc()` with a key missing from `labelNames()` throws inside
          // `onResponse`, Fastify swallows it, and the series silently never appears —
          // a dashboard that reads as "no traffic from that tenant" rather than as a bug.
          [LABELS.tenant]: slug,
          [LABELS.routeClass]: req.routeClass ?? 'read',
          [LABELS.outcome]: status === 429 ? 'throttled' : status >= 500 ? 'error' : 'ok',
        });
      }
    }

    if (seconds > 1) {
      // A slow response is an SLI event: keep a tail sample in the log stream
      // next to the metric so `p99 spikes at 03:12` is answerable.
      req.log.warn({ route, ms: Math.round(seconds * 1000), status }, 'slow response');
    }
    done();
  });

  // --------------------------------- internal listener ----------------------
  const internal = Fastify({ logger: false, disableRequestLogging: true, bodyLimit: 4096 });

  internal.get('/metrics', async (_req, reply) => {
    metrics.scrapeCount.inc();
    reply.header('content-type', register.contentType);
    return reply.send(await register.metrics());
  });

  // Cardinality tripwire: alerts on this before the TSDB does.
  internal.get('/metrics/summary', async () => ({
    textBytes: (await register.metrics()).length,
    metrics: (await register.getMetricsAsArray()).length,
    series: (await register.getMetricsAsArray()).reduce(
      (acc, m) =>
        acc + ((m as unknown as { getMetrics?: () => unknown[] }).getMetrics?.() ?? []).length,
      0,
    ),
  }));

  internal.get('/healthz', async () => ({ status: 'ok' }));
  internal.get('/livez', async () => ({ alive: true }));
  internal.get('/readyz', async (_req, reply) => {
    const report = (await internal.readinessProbe?.()) ?? { ok: true, checks: {} };
    reply.code(report.ok ? 200 : 503);
    return report;
  });
  internal.get('/debug/config', async (_req, reply) => {
    if (cfg.isProd) {
      return reply.code(404).send({ error: 'not found' });
    }
    return printableConfig(cfg);
  });

  let closed = false;
  const server = internal;
  const close = async (): Promise<void> => {
    if (closed) {
      return;
    }
    closed = true;
    await server.close();
  };

  return { metrics, internal: { instance: internal, close } };
}

export function routeTemplate(req: FastifyRequest): string {
  const tpl = req.routeOptions?.url;
  if (tpl) {
    return tpl;
  }
  // Unmatched routes must collapse to a constant: otherwise a path-spraying
  // client mints unbounded label values and grows Prometheus forever.
  return 'unmatched';
}

function statusClass(status: number): '2xx' | '3xx' | '4xx' | '5xx' {
  if (status >= 500) {
    return '5xx';
  }
  if (status >= 400) {
    return '4xx';
  }
  if (status >= 300) {
    return '3xx';
  }
  return '2xx';
}
