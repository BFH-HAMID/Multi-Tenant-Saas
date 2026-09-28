import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';
import { JOB_BUCKETS, METRICS } from '@saas/shared';

/**
 * Worker metrics.
 *
 * The API's /metrics answers "are users being served"; this one answers "is the
 * backlog moving", which is a different question with different alert shapes:
 *
 *   - depth per queue *and* the age of the oldest pending item: a depth of 5 000
 *     is fine at 10k jobs/sec and fatal at 1 job/min, so only the age can be the
 *     SLO;
 *   - `queue_job_results_total{outcome}` splits retrying/failed/skipped, so
 *     "the queue is growing" can be told apart from "the queue is being drained
 *     slowly" and "a poisoned job is looping";
 *   - `queue_dead_letters_total` is the only signal that a job exhausted its
 *     retries — the alert that means a human must look;
 *   - the outbox gauges come from Postgres (`app.outbox_depth`), not from the
 *     broker, because Postgres is where the truth about *durability* lives:
 *     pending > 0 with published == 0 means the relay is dead, not that the
 *     system is busy.
 *
 * Cardinality rule: no tenant labels on counters here. Tenant ids are high
 * cardinality and the worker handles thousands of them; per-tenant attribution
 * for the noisy-neighbour test comes from the API's allow-listed
 * `tenant_requests_total`, and the worker's own breakdown is per queue/job.
 */
export interface WorkerMetrics {
  registry: Registry;
  jobResults: Counter<'queue' | 'job' | 'outcome'>;
  jobDuration: Histogram<'queue' | 'job'>;
  activeJobs: Gauge<'queue'>;
  queueDepth: Gauge<'queue' | 'state'>;
  oldestPending: Gauge<'queue'>;
  deadLetters: Counter<'queue' | 'reason'>;
  outboxPublished: Counter<'topic'>;
  outboxPending: Gauge<'kind'>;
  outboxLag: Gauge;
  relayTicks: Counter<'outcome'>;
  dbQueryDuration: Histogram;
  dbSlowQueries: Counter<'kind'>;
  slowJobs: Counter<'job'>;
  errors: Counter<'where'>;
  emailsSent: Counter<'transport' | 'kind'>;
  dlqDepth: Gauge;
  ready: Gauge;
  appInfo: Gauge<'version' | 'sha' | 'env' | 'driver'>;
}

export function createMetrics(input: {
  version: string;
  sha: string;
  env: string;
  driver: string;
  nodeEnv: string;
}): WorkerMetrics {
  const registry = new Registry();
  registry.setDefaultLabels({ service: 'worker' });
  collectDefaultMetrics({
    // prom-client spells this `register`; passing `registry` silently collects
    // into the *default* registry, where the scrape endpoint never looks at it.
    register: registry,
    prefix: 'nodejs_',
    // `nodejs_eventloop_lag_*` (collected by default) is the cheapest early
    // warning that a worker pod is CPU-throttled — which is what an HPA on `cpu`
    // alone misreads as "add replicas" for a pod that is already idle-waiting on
    // Postgres. No extra monitor instance is configured on purpose: prom-client's
    // default sampler is enough and every option here is one more thing to keep
    // in sync with the library.
  });

  const jobResults = new Counter({
    name: METRICS.queueJobResults,
    help: 'Terminal outcome of a job attempt (completed, retrying, failed, skipped).',
    labelNames: ['queue', 'job', 'outcome'] as const,
    registers: [registry],
  });
  const jobDuration = new Histogram({
    name: METRICS.queueJobDuration,
    help: 'Handler wall time per job attempt.',
    labelNames: ['queue', 'job'] as const,
    buckets: JOB_BUCKETS,
    registers: [registry],
  });
  const activeJobs = new Gauge({
    name: METRICS.workerActiveJobs,
    help: 'Jobs currently being processed by this pod.',
    labelNames: ['queue'] as const,
    registers: [registry],
  });
  const queueDepth = new Gauge({
    name: METRICS.queueJobs,
    help: 'Broker/outbox depth per queue and state.',
    labelNames: ['queue', 'state'] as const,
    registers: [registry],
  });
  const oldestPending = new Gauge({
    name: METRICS.queueOldestPending,
    help: 'Age in seconds of the oldest unclaimed job. This is the number users feel.',
    labelNames: ['queue'] as const,
    registers: [registry],
  });
  const deadLetters = new Counter({
    name: METRICS.queueDLQ,
    help: 'Jobs moved to the dead-letter queue, by reason.',
    labelNames: ['queue', 'reason'] as const,
    registers: [registry],
  });
  const outboxPublished = new Counter({
    name: METRICS.outboxPublished,
    help: 'Outbox rows relayed to the broker, by topic.',
    labelNames: ['topic'] as const,
    registers: [registry],
  });
  const outboxPending = new Gauge({
    name: METRICS.outboxPending,
    help: 'Outbox rows by state (pending/failed/discarded).',
    labelNames: ['kind'] as const,
    registers: [registry],
  });
  const outboxLag = new Gauge({
    name: METRICS.outboxLag,
    help: 'Seconds since the oldest pending outbox row was created.',
    registers: [registry],
  });
  const relayTicks = new Counter({
    name: METRICS.workerRelayTicks,
    help: 'Relay iterations, by outcome (idle, claimed, error).',
    labelNames: ['outcome'] as const,
    registers: [registry],
  });
  const dbSlowQueries = new Counter({
    name: METRICS.dbSlowQueries,
    help: 'Worker statements over PG_SLOW_QUERY_MS. Reported per process on purpose: a slow report query and a slow API query need different fixes, and one number would hide which.',
    labelNames: ['kind'] as const,
    registers: [registry],
  });
  const dbQueryDuration = new Histogram({
    name: METRICS.dbQueryDuration,
    help: 'Statements issued by the worker (its own load, not the API’s).',
    buckets: [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1, 5, 10, 30, 60],
    registers: [registry],
  });
  const slowJobs = new Counter({
    name: METRICS.workerSlowJobs,
    help: 'Jobs that exceeded the configured slow-job threshold.',
    labelNames: ['job'] as const,
    registers: [registry],
  });
  const errors = new Counter({
    name: METRICS.workerErrors,
    help: 'Unclassified worker errors by site.',
    labelNames: ['where'] as const,
    registers: [registry],
  });
  const emailsSent = new Counter({
    name: METRICS.workerEmailsSent,
    help: 'Emails handled, split by transport — a dry-run count is how a reviewer catches that SMTP was never configured.',
    labelNames: ['transport', 'kind'] as const,
    registers: [registry],
  });
  const dlqDepth = new Gauge({
    name: METRICS.queueDeadLetterDepth,
    help: 'Jobs parked in the dead-letter queue, awaiting a human or a replay run.',
    registers: [registry],
  });
  const ready = new Gauge({
    name: METRICS.ready,
    help: '1 when the worker is consuming (BullMQ connected / relay running) and Postgres answers.',
    registers: [registry],
  });
  const appInfo = new Gauge({
    name: METRICS.appInfo,
    help: 'Build identity of this worker pod.',
    labelNames: ['version', 'sha', 'env', 'driver'] as const,
    registers: [registry],
  });
  appInfo.set({ version: input.version, sha: input.sha, env: input.env, driver: input.driver }, 1);

  return {
    registry,
    jobResults,
    jobDuration,
    activeJobs,
    queueDepth,
    oldestPending,
    deadLetters,
    outboxPublished,
    outboxPending,
    outboxLag,
    relayTicks,
    dbQueryDuration,
    dbSlowQueries,
    slowJobs,
    errors,
    emailsSent,
    dlqDepth,
    ready,
    appInfo,
  };
}
