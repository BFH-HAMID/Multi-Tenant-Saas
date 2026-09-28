import type { FastifyInstance } from 'fastify';
import type { Database } from '@saas/db';
import type { AppConfig } from '../config/index.js';
import type { AppMetrics, ReadinessReport } from '../plugins/metrics.js';
import { createQueueDepthProbe } from './queueDepth.js';

export interface CollectorDeps {
  app: FastifyInstance;
  cfg: AppConfig;
  metrics: AppMetrics;
  db: Database;
}

export interface Collectors {
  stop(): void;
  readiness(): Promise<ReadinessReport>;
  probe(): Promise<void>;
}

const PROBE_INTERVAL_MS = 15_000;

/**
 * Gauges that only make sense when *pulled*, on one interval so their cost is
 * fixed and independent of request rate:
 *
 *   - `pg.Pool` state — `waiting > 0` sustained means the pool (or Postgres) is
 *     the bottleneck, not the query;
 *   - Redis liveness for cache and queue (a Redis that is slow is a different
 *     incident from a Redis that is gone, and the two have different runbooks);
 *   - BullMQ depth per queue/state plus the age of the oldest waiting job, which
 *     is the only queue metric users can actually feel;
 *   - Postgres-side outbox depth and lag — the gap between "queued" and
 *     "published", i.e. whether the relay is alive.
 *
 * Every collector is best-effort and swallows its own errors: a failing
 * collector must not break a scrape, because a failed scrape silently blinds
 * the alert that would have caught the incident.
 */
export function registerCollectors(deps: CollectorDeps): Collectors {
  const { app, cfg, metrics, db } = deps;
  const log = app.log;
  const cacheMode = cfg.env.REDIS_CACHE_URL.startsWith('memory://') ? 'memory' : 'redis';

  const state = {
    dbUp: true,
    cacheUp: cacheMode === 'redis',
    lastProbeMs: 0,
    lastProbeError: null as string | null,
    /** Consecutive probe failures — used to log once, not every 15s. */
    failures: 0,
  };

  const publishGauges = (): void => {
    metrics.dependencyUp.set({ dependency: 'postgres' }, state.dbUp ? 1 : 0);
    metrics.dependencyUp.set(
      { dependency: 'cache_redis' },
      cacheMode === 'memory' ? 1 : state.cacheUp ? 1 : 0,
    );
  };
  publishGauges();

  const depthProbe =
    cfg.env.QUEUE_DRIVER === 'bullmq' ? createQueueDepthProbe(cfg, log as never) : null;

  const probe = async (): Promise<void> => {
    const health = await db.healthcheck();
    state.dbUp = health.ok;
    state.lastProbeMs = Date.now();
    state.lastProbeError = health.error ?? null;
    if (health.ok) {
      state.failures = 0;
    } else if (state.failures++ % 4 === 0) {
      log.warn({ err: health.error, consecutive: state.failures }, 'postgres health probe failed');
    }

    if (cacheMode === 'redis') {
      state.cacheUp = await app.redisHandles.kv.ping();
    }
    publishGauges();
  };

  const tick = async (): Promise<void> => {
    const pool = db.stats();
    metrics.dbPool.set({ state: 'total' }, pool.total);
    metrics.dbPool.set({ state: 'idle' }, pool.idle);
    metrics.dbPool.set({ state: 'waiting' }, pool.waiting);

    await probe();

    if (depthProbe) {
      try {
        const { counts, oldest } = await depthProbe();
        for (const [queue, byState] of Object.entries(counts)) {
          for (const [jobState, n] of Object.entries(byState)) {
            metrics.queueJobs.set({ queue, state: jobState }, n);
          }
        }
        for (const [queue, seconds] of Object.entries(oldest)) {
          metrics.queueOldestPending.set({ queue }, seconds);
        }
      } catch (err) {
        log.debug({ err: String(err) }, 'queue depth probe failed');
      }
    }

    try {
      const { rows } = await db.query<{ pending: string; oldest_pending_seconds: string }>(
        'SELECT pending, oldest_pending_seconds FROM app.outbox_depth',
      );
      const row = rows[0] ?? { pending: '0', oldest_pending_seconds: '0' };
      metrics.outboxPending.set(Number(row.pending));
      metrics.outboxLag.set(Number(row.oldest_pending_seconds));
    } catch (err) {
      log.debug({ err: String(err) }, 'outbox depth probe failed');
    }
  };

  const timer = setInterval(() => {
    void tick().catch((err: unknown) => log.debug({ err: String(err) }, 'collector tick failed'));
  }, PROBE_INTERVAL_MS);
  timer.unref?.();

  return {
    stop: () => clearInterval(timer),
    probe,
    async readiness(): Promise<ReadinessReport> {
      // Readiness is narrower than liveness on purpose: stop routing traffic
      // only when requests would be *wrong or hopeless* (no Postgres). A dead
      // cache or queue must not evict a pod — it must degrade, because a pod
      // that cannot serve from Postgres is worse than one that cannot cache.
      if (Date.now() - state.lastProbeMs > PROBE_INTERVAL_MS) {
        await probe();
      }
      return {
        ok: state.dbUp,
        checks: {
          postgres: {
            ok: state.dbUp,
            statementTimeoutMs: cfg.env.PG_STATEMENT_TIMEOUT_MS,
            pool: db.stats(),
          },
          cache: { mode: cacheMode, up: state.cacheUp, decisive: false },
          limiter: {
            backend: app.limiter.kind,
            degraded: app.limiterState.degraded,
            decisive: false,
          },
          queue: { driver: cfg.env.QUEUE_DRIVER, decisive: false },
          probedAt: new Date(state.lastProbeMs).toISOString(),
          lastError: state.lastProbeError,
        },
      };
    },
  };
}
