import { z } from 'zod';
import { bool, parseEnv, postgresUrl, redisUrl } from '@saas/shared';

/**
 * Worker configuration. One schema, no `process.env` reads anywhere else, and a
 * `describe()` line at boot — the same discipline as the API, because a queue
 * consumer is the component people debug at 03:00 from a pod restart loop.
 *
 * The two knobs that actually matter operationally are CONCURRENCY and
 * RELAY_BATCH_INTERVAL_MS: throughput scales with the first, tail latency of
 * *other* tenants degrades with it if it is raised past what Postgres can serve
 * concurrently, which is exactly the noisy-neighbour trade-off the load test
 * measures.
 */
const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  SERVICE_NAME: z.string().default('worker'),
  BUILD_VERSION: z.string().default('dev'),
  BUILD_SHA: z.string().default('unknown'),

  DATABASE_URL: postgresUrl,
  PG_POOL_MAX: z.coerce.number().int().min(1).max(200).default(10),
  PG_POOL_MIN: z.coerce.number().int().min(0).max(50).default(1),
  PG_STATEMENT_TIMEOUT_MS: z.coerce.number().int().min(100).max(600_000).default(120_000),
  PG_SLOW_QUERY_MS: z.coerce.number().int().min(10).default(1_000),

  REDIS_QUEUE_URL: redisUrl.default('memory://'),
  QUEUE_DRIVER: z.enum(['bullmq', 'outbox']).default('outbox'),
  QUEUE_NAME_PREFIX: z.string().max(24).default('saas'),

  /** BullMQ `concurrency`: jobs in flight per pod. */
  CONCURRENCY: z.coerce.number().int().min(1).max(64).default(4),
  /** Outbox relay cadence when BullMQ is not the transport. */
  RELAY_INTERVAL_MS: z.coerce.number().int().min(50).max(60_000).default(250),
  RELAY_BATCH_SIZE: z.coerce.number().int().min(1).max(1000).default(50),
  /** A claimed outbox row whose handler has not settled in this long is re-claimable. */
  LEASE_SECONDS: z.coerce.number().int().min(5).max(3600).default(120),
  /** How long a permanently-failed job is kept in the DLQ before we forget it. */
  DLQ_RETENTION_HOURS: z.coerce
    .number()
    .int()
    .min(1)
    .max(24 * 30)
    .default(24 * 7),

  /** Optional: without SMTP the email handler records the send instead of delivering it. */
  SMTP_URL: z.string().optional(),
  SMTP_FROM: z.string().default('no-reply@saas.test'),
  /** A grey-listing relay must not hold a BullMQ lock: cap every SMTP op. */
  SMTP_TIMEOUT_MS: z.coerce.number().int().min(500).max(60_000).default(10_000),
  /** Base URL used to build invitation links in emails. */
  ACCEPT_BASE_URL: z.string().default('http://localhost:3000'),

  /** Report generation bounds. The row cap is a product limit *and* a fuse. */
  REPORT_MAX_ROWS: z.coerce.number().int().min(1).max(500_000).default(50_000),
  /** Results up to this size are stored inline in `report_jobs.result`. */
  REPORT_INLINE_MAX_BYTES: z.coerce.number().int().min(1024).max(4_194_304).default(65_536),
  /**
   * Load-test knob: deliberate per-row CPU cost (microseconds) so a report is
   * expensive enough to observe head-of-line blocking between tenants. 1× means
   * "the rendering cost only"; 50× is what the noisy-neighbour scenario uses.
   * Production keeps this at 1; it exists because a queue that finishes every
   * job in 200ms cannot demonstrate saturation behaviour.
   */
  REPORT_WORK_MULTIPLIER: z.coerce.number().min(1).max(1000).default(1),

  /** Internal listener: /metrics, /healthz, /livez, /readyz, /dlq. */
  HOST: z.string().default('0.0.0.0'),
  METRICS_PORT: z.coerce.number().int().min(1).max(65535).default(9465),
  READINESS_STALE_MS: z.coerce.number().int().min(1000).default(30_000),

  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  LOG_PRETTY: bool.default(false),
  SHUTDOWN_GRACE_MS: z.coerce.number().int().min(0).max(300_000).default(30_000),
  /** Job idempotency reservations expire after this; a crashed handler retries then. */
  JOB_CLAIM_TTL_SECONDS: z.coerce.number().int().min(60).max(86_400).default(3600),
});

export type WorkerEnv = z.infer<typeof envSchema>;

export interface WorkerConfig {
  env: WorkerEnv;
  isProd: boolean;
  isTest: boolean;
  /** True when a real Redis backs BullMQ; otherwise the outbox relay is the only transport. */
  bullmqEnabled: boolean;
  describe(): Record<string, unknown>;
}

export function loadConfig(input: NodeJS.ProcessEnv = process.env): WorkerConfig {
  const env = parseEnv(envSchema, input);
  const isProd = env.NODE_ENV === 'production';
  const isTest = env.NODE_ENV === 'test';
  return {
    env,
    isProd,
    isTest,
    bullmqEnabled: env.QUEUE_DRIVER === 'bullmq' && env.REDIS_QUEUE_URL !== 'memory://',
    describe() {
      return {
        driver: env.QUEUE_DRIVER,
        bullmq: this.bullmqEnabled,
        queues: [
          `${env.QUEUE_NAME_PREFIX}:email`,
          `${env.QUEUE_NAME_PREFIX}:reports`,
          `${env.QUEUE_NAME_PREFIX}:dead-letter`,
        ],
        concurrency: env.CONCURRENCY,
        relay: {
          intervalMs: env.RELAY_INTERVAL_MS,
          batch: env.RELAY_BATCH_SIZE,
          leaseSeconds: env.LEASE_SECONDS,
        },
        smtp: env.SMTP_URL ? 'configured' : 'dry-run (recorded, not delivered)',
        report: { maxRows: env.REPORT_MAX_ROWS, workMultiplier: env.REPORT_WORK_MULTIPLIER },
        metricsPort: env.METRICS_PORT,
        shutdownGraceMs: env.SHUTDOWN_GRACE_MS,
        pool: {
          max: env.PG_POOL_MAX,
          min: env.PG_POOL_MIN,
          statementTimeoutMs: env.PG_STATEMENT_TIMEOUT_MS,
        },
      };
    },
  };
}
