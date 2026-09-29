import type { FastifyInstance } from 'fastify';
import { Redis } from 'ioredis';
import { MemoryKv, RedisKv, type KvClient, type RedisRateLimiterBackend } from '@saas/shared';
import type { AppConfig } from '../config/index.js';

export interface RedisHandles {
  /** Cache/lock/idempotency KV. MemoryKv when `REDIS_CACHE_URL=memory://`. */
  kv: KvClient;
  /** Raw client for the limiter's EVALSHA and for health checks; null in memory mode. */
  client: Redis | null;
  /** True when a real Redis answered PING at boot. */
  live: boolean;
  /** `redis://…` or `memory://` — reported by /readyz and metrics. */
  mode: 'redis' | 'memory';
  limiterBackend?: RedisRateLimiterBackend;
}

/**
 * Redis wiring for the *cache* instance.
 *
 * Two separate Redis instances by purpose (see docs/adr/0006 and the compose
 * file): the cache DB runs `maxmemory + allkeys-lru` because losing an entry is
 * fine; the queue DB must never evict because losing a job is data loss. They
 * have opposite failure models, so they must not share an instance.
 *
 * Client settings that matter:
 *  - `maxRetriesPerRequest: null` is required by BullMQ on the *queue* client;
 *    on the cache client we *do* want a bound (2) so a cache call cannot retry
 *    forever behind a latency SLO;
 *  - `enableAutoPipelining` keeps throughput up when a hot key is read by many
 *    concurrent requests;
 *  - `commandTimeout` + `lazyConnect` so a dead Redis is discovered by the
 *    health check and the limiter fallback, not by a stalled event loop.
 */
export async function registerRedis(app: FastifyInstance, cfg: AppConfig): Promise<RedisHandles> {
  const url = cfg.env.REDIS_CACHE_URL;
  const handle: RedisHandles = { kv: new MemoryKv(), client: null, live: false, mode: 'memory' };

  if (url.startsWith('memory://')) {
    app.log.warn(
      'REDIS_CACHE_URL=memory:// → in-process cache/limiter double (single-pod semantics; never use in production)',
    );
    app.decorate('redis', handle);
    app.decorate('redisHandles', handle);
    return handle;
  }

  const client = new Redis(url, {
    keyPrefix: cfg.env.REDIS_KEY_PREFIX || undefined,
    maxRetriesPerRequest: 2,
    enableAutoPipelining: true,
    autoPipeliningIgnoredCommands: ['evalsha', 'eval'],
    commandTimeout: cfg.env.REDIS_TIMEOUT_MS,
    connectTimeout: 2_000,
    // Reconnect quickly but never faster than the server can recover.
    retryStrategy: (times: number) => Math.min(1000 * 2 ** Math.min(times, 4), 5_000),
    // Fail fast instead of buffering: a cache client that queues commands during
    // a failover turns a cache outage into a request-queue outage. Everything on
    // top of this (CacheStore, the limiter) already treats an error as a miss, so
    // a rejected command is the *good* outcome.
    enableOfflineQueue: false,
    keepAlive: 30_000,
    enableReadyCheck: true,
    // TLS for ElastiCache/Upstash style endpoints.
    tls: /rediss:\/\//.test(url) ? { rejectUnauthorized: false } : undefined,
  });

  client.on('error', (err: Error) => {
    // Debug-level for reconnect noise, but never let it become an unhandled
    // rejection: ioredis emits 'error' on the client while retrying.
    app.log.debug({ err: err.message }, 'redis cache error');
  });
  client.on('ready', () => {
    app.log.info('redis cache ready');
  });
  client.on('end', () => {
    app.log.warn('redis cache connection ended');
  });

  handle.client = client;
  // Structural boundary cast: RedisKv depends on a narrow `RedisLike`
  // (get/set/del/incr/expire/scan/ping/eval) so the shared package does not
  // depend on ioredis; the real client satisfies it, and the assertion is checked
  // by the integration tests rather than by the compiler.
  handle.kv = new RedisKv(client as unknown as ConstructorParameters<typeof RedisKv>[0], {
    timeoutMs: cfg.env.REDIS_TIMEOUT_MS,
    onError: (op, err) =>
      app.log.debug({ op, err: String(err) }, 'redis cache op failed (degrading)'),
  });

  // `enableOfflineQueue: false` (correctly) rejects commands issued before the
  // connection is ready, so pinging immediately after construction races the
  // handshake and reports a healthy Redis as down. Wait for `ready` first —
  // bounded, because the boot must not hang on a dead Redis either.
  await new Promise<void>((resolve) => {
    if (client.status === 'ready') {
      return resolve();
    }
    const timer = setTimeout(() => resolve(), 2_000);
    client.once('ready', () => {
      clearTimeout(timer);
      resolve();
    });
    client.once('end', () => {
      clearTimeout(timer);
      resolve();
    });
  });
  try {
    handle.live = (await client.ping()) === 'PONG';
  } catch (err) {
    app.log.error({ err: String(err) }, 'redis ping failed at boot — continuing in degraded mode');
    handle.live = false;
  }
  handle.mode = 'redis';

  app.addHook('onClose', async () => {
    client.disconnect();
  });

  app.decorate('redis', handle);
  app.decorate('redisHandles', handle);
  return handle;
}

/** Queue-side connection (BullMQ). Separate instance: no eviction, AOF on. */
export function createQueueConnection(
  cfg: AppConfig,
  log: FastifyInstance['log'],
  label: string,
): Redis | null {
  const url = cfg.env.REDIS_QUEUE_URL;
  if (url.startsWith('memory://')) {
    return null;
  }
  return new Redis(url, {
    maxRetriesPerRequest: null, // BullMQ requirement: blocking commands must not give up
    enableReadyCheck: false,
    keepAlive: 30_000,
    connectTimeout: 3_000,
    retryStrategy: (times: number) => Math.min(1000 * 2 ** Math.min(times, 4), 5_000),
    lazyConnect: false,
    // Labelled so `CLIENT LIST` / `redis-cli client list` shows which pool a
    // connection belongs to — priceless when you are deciding which service to
    // kill during an incident.
    connectionName: `${label}-${process.pid}`,
    tls: /rediss:\/\//.test(url) ? { rejectUnauthorized: false } : undefined,
  });
}
