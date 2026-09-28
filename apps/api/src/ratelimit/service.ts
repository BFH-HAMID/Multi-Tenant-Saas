import {
  MemoryRateLimiterBackend,
  RedisRateLimiterBackend,
  type EvalClient,
  type RateLimiterBackend,
  type RateLimitContext,
  type RateLimitDecision,
  type RateLimitInput,
} from '@saas/shared';
import type { FastifyInstance } from 'fastify';
import type { Redis } from 'ioredis';
import type { AppConfig } from '../config/index.js';
import type { AppMetrics } from '../plugins/metrics.js';

export interface LimiterBundle {
  backend: RateLimiterBackend;
  state: { degraded: boolean; sinceMs: number | null; redisErrors: number };
  close(): Promise<void>;
}

/**
 * Build the request limiter.
 *
 * `redis://` → the Lua script on the cache instance (shared across pods, which
 * is what makes a per-tenant limit mean something when there are 8 replicas).
 * `memory://` → the in-process backend (dev, tests, single-pod deployments).
 *
 * The wrapper adds the one behaviour that matters operationally: if Redis dies
 * mid-flight, keep throttling *per pod* instead of turning a cache outage into
 * an unthrottled flood into Postgres. `degraded` is exported as a gauge and a
 * response header so it is visible in dashboards, and it recovers on its own
 * after the probe interval.
 */
export function createLimiter(
  app: FastifyInstance,
  cfg: AppConfig,
  metrics: AppMetrics,
  redisHandles: { client: Redis | null },
): LimiterBundle {
  const state = { degraded: false, sinceMs: null as number | null, redisErrors: 0 };
  const memory = new MemoryRateLimiterBackend();
  const log = app.log;

  if (!redisHandles.client || cfg.env.REDIS_CACHE_URL.startsWith('memory://')) {
    if (cfg.env.REDIS_CACHE_URL.startsWith('memory://')) {
      log.warn('rate limiter using the in-process backend (memory://): limits are per pod');
    }
    metrics.rateLimitDecisions.inc({ outcome: 'fallback', plan: 'none' });
    return {
      backend: new CountingBackend(memory, metrics, false),
      state,
      close: () => memory.close(),
    };
  }

  const redis = new RedisRateLimiterBackend({
    // Documented boundary cast (see EvalClient in @saas/shared).
    client: redisHandles.client as unknown as EvalClient,
    onError: (err) => {
      state.redisErrors++;
      log.debug({ err: String(err) }, 'rate limiter redis error');
    },
  });
  void redis.preload();

  const primary: RateLimiterBackend = redis;
  const composite = cfg.env.RATE_LIMIT_FALLBACK_MEMORY
    ? new DegradingBackend(primary, new CountingBackend(memory, metrics, true), metrics, state, log)
    : new CountingBackend(primary, metrics, false);

  return {
    backend: composite,
    state,
    close: async () => {
      await redis.close();
      await memory.close();
    },
  };
}

class CountingBackend implements RateLimiterBackend {
  readonly kind: 'redis' | 'memory';
  constructor(
    private readonly inner: RateLimiterBackend,
    private readonly metrics: AppMetrics,
    isMemory: boolean,
  ) {
    this.kind = isMemory ? 'memory' : inner.kind;
  }

  async consume(input: RateLimitInput): Promise<RateLimitDecision> {
    const decision = await this.inner.consume(input);
    this.metrics.rateLimitDecisions.inc({
      outcome: decision.allowed ? 'allow' : 'throttle',
      plan: input.plan,
    });
    return decision;
  }

  reset(ctx: RateLimitContext): Promise<void> {
    return this.inner.reset(ctx);
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}

class DegradingBackend implements RateLimiterBackend {
  constructor(
    private readonly primary: RateLimiterBackend,
    private readonly fallback: RateLimiterBackend,
    private readonly metrics: AppMetrics,
    private readonly state: LimiterBundle['state'],
    private readonly log: FastifyInstance['log'],
  ) {}

  get kind(): 'redis' | 'memory' {
    return this.state.degraded ? 'memory' : 'redis';
  }

  async consume(input: RateLimitInput): Promise<RateLimitDecision> {
    if (this.state.degraded) {
      // Half-open: stop hammering a Redis that is still down, but probe it via
      // the primary every so often so recovery is automatic.
      const since = this.state.sinceMs ?? 0;
      if (Date.now() - since > 10_000) {
        this.state.degraded = false;
        this.state.sinceMs = null;
        this.log.info('rate limiter leaving degraded mode (retrying redis)');
      } else {
        return this.fallback.consume(input);
      }
    }

    try {
      return await this.primary.consume(input);
    } catch (err) {
      this.state.degraded = true;
      this.state.sinceMs = Date.now();
      this.metrics.rateLimitDecisions.inc({ outcome: 'fallback', plan: input.plan });
      this.log.warn(
        { err: String(err), tenant: input.tenantId },
        'rate limiter degraded to per-pod in-process buckets (effective cluster limit = plan limit × replicas)',
      );
      return this.fallback.consume(input);
    }
  }

  async reset(ctx: RateLimitContext): Promise<void> {
    await Promise.allSettled([this.primary.reset(ctx), this.fallback.reset(ctx)]);
  }

  async close(): Promise<void> {
    await Promise.allSettled([this.primary.close(), this.fallback.close()]);
  }
}
