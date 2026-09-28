import type { FastifyInstance } from 'fastify';
import { CacheStore } from '../cache/store.js';
import type { AppConfig } from '../config/index.js';
import type { AppMetrics } from './metrics.js';
import type { RedisHandles } from './redis.js';

/**
 * Builds the cache layer over whichever Kv the Redis plugin produced
 * (Redis-backed in production, in-process under `memory://` and in tests) and
 * decorates it. Kept as a plugin so `app.cache` exists before any hook that
 * reads it — the tenant and membership memos both use it, and both are installed
 * before routes.
 *
 * No `close()` here on purpose: the Kv is a view onto the Redis handle, whose
 * lifecycle the Redis plugin owns.
 */
export function registerCache(
  app: FastifyInstance,
  handles: RedisHandles,
  metrics: AppMetrics,
  cfg: AppConfig,
): CacheStore {
  const store = new CacheStore(handles.kv, metrics, cfg.env.CACHE_ENABLED);
  app.decorate('cache', store);
  app.log.info(
    {
      enabled: store.enabled,
      backend: handles.mode,
      listTtlMs: cfg.env.CACHE_LIST_TTL_MS,
      defaultTtlMs: cfg.env.CACHE_DEFAULT_TTL_MS,
    },
    'cache ready',
  );
  return store;
}
