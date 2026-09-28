/**
 * Metric names and label policy.
 *
 * Cardinality budget (the thing that kills Prometheus at 10k tenants):
 *   - NEVER label by tenantId/userId on a histogram. A 6-bucket histogram ×
 *     10k tenants × 30 routes is 1.8M series and melts the TSDB.
 *   - Per-tenant observability therefore uses *counters* on the two axes that
 *     matter for noisy-neighbour triage (requests + rejections), which we
 *     expose as `tenant_requests_total{tenant,route_class}` — bounded by
 *     tenants × 4 classes — and cap the rest behind `TENANT_METRIC_TENANTS`
 *     top-N allow-lists computed at scrape time.
 *   - `route` labels use the Fastify *route template* (`/v1/projects/:id`), not
 *     the URL, so ids never enter a label.
 *
 * `METRICS` is the complete list of names this system exposes, and `METRIC_OWNERSHIP`
 * says which process exposes each one. Both are enforced by tests
 * (`packages/shared/tests/metricNames.unit.test.ts`, `apps/<app>/tests/metricsContract.unit.test.ts`)
 * because a metric name that nothing registers is worse than no metric at all: it
 * appears in a dashboard panel and an alert rule, quietly returns nothing, and the
 * reader concludes the system is healthy. The same tests are why the alert rules in
 * `infra/prometheus/alerts.yml` and the queries in
 * `infra/grafana/dashboards/build.mjs` can be trusted without opening Prometheus.
 */
export const METRICS = {
  httpRequestDuration: 'http_request_duration_seconds',
  httpRequests: 'http_requests_total',
  httpErrors: 'http_errors_total',
  httpInFlight: 'http_requests_in_flight',
  rateLimitDecisions: 'ratelimit_decisions_total',
  cacheLookups: 'cache_lookups_total',
  cachePayloadBytes: 'cache_payload_bytes',
  cacheOpDuration: 'cache_operation_duration_seconds',
  dbPool: 'pg_pool_connections',
  dbQueryDuration: 'db_query_duration_seconds',
  dbSlowQueries: 'db_slow_queries_total',
  redisUp: 'redis_up',
  idempotencyKeys: 'idempotency_keys_total',
  metricsScrapes: 'metrics_scrapes_total',
  queueJobs: 'queue_jobs',
  queueJobDuration: 'queue_job_duration_seconds',
  queueJobResults: 'queue_job_results_total',
  queueDeadLetterDepth: 'queue_dead_letter_depth',
  queueDLQ: 'queue_dead_letters_total',
  queueOldestPending: 'queue_oldest_pending_job_seconds',
  outboxPending: 'outbox_pending_messages',
  outboxLag: 'outbox_oldest_lag_seconds',
  outboxPublished: 'outbox_published_total',
  authEvents: 'auth_events_total',
  tenantRequests: 'tenant_requests_total',
  workerActiveJobs: 'worker_active_jobs',
  workerRelayTicks: 'worker_relay_ticks_total',
  workerSlowJobs: 'worker_slow_jobs_total',
  workerErrors: 'worker_errors_total',
  workerEmailsSent: 'worker_emails_sent_total',
  appInfo: 'app_info',
  ready: 'app_ready',
} as const;

/**
 * Names that were considered and deliberately not implemented, and what replaced them.
 * Recorded here rather than deleted silently, because "we do not measure that" is an
 * answer a reviewer is entitled to:
 *
 *   ratelimit_bucket_utilization — a per-tenant gauge for "how close is this tenant to
 *     its ceiling". Rejected on cardinality: it is tenants × route classes of *gauges*,
 *     and the same question is one `rate()` over `ratelimit_decisions_total{plan}` away.
 *   redis_commands_total — per-command Redis RED metrics. Instrumenting it means wrapping
 *     every call, i.e. adding work to the request path for a layer that is an optimisation.
 *     Its failure is already loud: `redis_up`, the limiter's `outcome="fallback"`, and the
 *     cache's `outcome="error"` all say the same thing at the place it matters.
 *   queue_failed_total — replaced by `queue_job_results_total{outcome="retrying"}`, which
 *     distinguishes "will be retried" from "is dead" instead of merging them into one count.
 *   tenant_rejected_requests_total — replaced by `tenant_requests_total{outcome="throttled"}`:
 *     one counter with an outcome label, rather than two that can disagree.
 */

export const LABELS = {
  routeClass: 'route_class',
  method: 'method',
  route: 'route',
  status: 'status',
  outcome: 'outcome',
  plan: 'plan',
  queue: 'queue',
  state: 'state',
  tenant: 'tenant',
  cache: 'cache',
  result: 'result',
} as const;

/** Latency histogram buckets in seconds: tuned for a 1–300ms API. */
export const HTTP_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.2, 0.35, 0.5, 1, 2.5, 5, 10];
export const DB_BUCKETS = [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 5];
export const JOB_BUCKETS = [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 120, 300];

export type CacheOutcome = 'hit' | 'miss' | 'error' | 'bypass' | 'coalesced';
export type RateLimitOutcome = 'allow' | 'throttle' | 'disabled' | 'fallback';

/** Which process exposes a name. `both` means the same series appears on both
 * scrapes and must be summed across jobs — the alternative is a metric that only
 * exists in one environment, which is how an alert is discovered to be broken during
 * the incident it was written for. */
export const METRIC_OWNERSHIP: Record<MetricName, readonly MetricOwner[]> = {
  httpRequestDuration: ['api'],
  httpRequests: ['api'],
  httpErrors: ['api'],
  httpInFlight: ['api'],
  rateLimitDecisions: ['api'],
  cacheLookups: ['api'],
  cachePayloadBytes: ['api'],
  cacheOpDuration: ['api'],
  dbPool: ['api'],
  dbQueryDuration: ['api', 'worker'],
  dbSlowQueries: ['api', 'worker'],
  redisUp: ['api'],
  authEvents: ['api'],
  idempotencyKeys: ['api'],
  metricsScrapes: ['api'],
  tenantRequests: ['api'],
  appInfo: ['api', 'worker'],
  queueJobs: ['api', 'worker'],
  queueOldestPending: ['api', 'worker'],
  outboxPending: ['api', 'worker'],
  outboxLag: ['api', 'worker'],
  outboxPublished: ['api', 'worker'],
  queueJobDuration: ['worker'],
  queueJobResults: ['worker'],
  queueDeadLetterDepth: ['worker'],
  queueDLQ: ['worker'],
  ready: ['worker'],
  workerActiveJobs: ['worker'],
  workerRelayTicks: ['worker'],
  workerSlowJobs: ['worker'],
  workerErrors: ['worker'],
  workerEmailsSent: ['worker'],
} as const;

export type MetricOwner = 'api' | 'worker';
export type MetricName = keyof typeof METRICS;
