import type { FastifyInstance } from 'fastify';
import type { RateLimiterBackend } from '@saas/shared';
import { createLimiter } from '../ratelimit/service.js';
import type { AppConfig } from '../config/index.js';
import type { AppMetrics } from './metrics.js';
import type { RedisHandles } from './redis.js';

export interface LimiterHandle {
  backend: RateLimiterBackend;
  close(): Promise<void>;
}

/**
 * Decorates `app.limiter` (+ `limiterState`, `limiterConfig`) and owns the
 * backend's lifecycle. Split from `ratelimit/service.ts` (which builds the
 * backend) for the same reason the Redis plugin is separate: the *policy* is
 * testable without a Fastify instance, and the wiring is where the singleton
 * behaviour lives.
 */
export function registerLimiter(
  app: FastifyInstance,
  cfg: AppConfig,
  metrics: AppMetrics,
  handles: RedisHandles,
): LimiterHandle {
  const bundle = createLimiter(app, cfg, metrics, { client: handles.client });
  app.decorate('limiter', bundle.backend);
  app.decorate('limiterState', { degraded: bundle.state.degraded, sinceMs: bundle.state.sinceMs });
  app.decorate('limiterConfig', { enabled: cfg.env.RATE_LIMIT_ENABLED });

  // The state object is shared by reference so the collector/readyz view and the
  // backend's own degradation flip stay the same object.
  Object.defineProperty(app.limiterState, 'degraded', {
    get: () => bundle.state.degraded,
    enumerable: true,
  });

  app.addHook('onClose', async () => {
    await bundle.close();
  });

  return { backend: bundle.backend, close: bundle.close };
}
