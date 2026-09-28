import { Queue } from 'bullmq';
import { QUEUES } from '@saas/shared';
import type { MinimalLogger } from '@saas/db';
import type { AppConfig } from '../config/index.js';

export interface QueueDepth {
  counts: Record<string, Record<string, number>>;
  /** Seconds since the oldest waiting job was added (0 when the queue is empty). */
  oldest: Record<string, number>;
}

/**
 * BullMQ depth probe.
 *
 * `getJobCounts()` is a Redis `ZCARD`/`HLEN` per state on the queue key — cheap
 * but not free, so it runs on the collector interval (15s) rather than per
 * scrape, and the gauge keeps the last value in between. `oldest waiting job`
 * comes from the first element of the wait list: depth alone hides the case of
 * "5 jobs, each waiting 10 minutes", which is the incident you actually care
 * about.
 */
export function createQueueDepthProbe(
  cfg: AppConfig,
  log: MinimalLogger,
): () => Promise<QueueDepth> {
  const queues = Object.values(QUEUES).map(
    (name) =>
      new Queue(`${cfg.env.QUEUE_NAME_PREFIX}:${name}`, {
        connection: redisConnectionFor(cfg),
        // Probing must not create connections eagerly on boot.
      }),
  );

  const closed = false;

  return async (): Promise<QueueDepth> => {
    if (closed) {
      return { counts: {}, oldest: {} };
    }
    const counts: QueueDepth['counts'] = {};
    const oldest: QueueDepth['oldest'] = {};

    await Promise.all(
      queues.map(async (q) => {
        try {
          const raw = await q.getJobCounts();
          const shortName = q.name.split(':').slice(1).join(':');
          counts[shortName] = raw as unknown as Record<string, number>;

          const waiting = await q.getWaiting(0, 0);
          const first = waiting[0];
          oldest[shortName] = first ? (Date.now() - (first.timestamp ?? Date.now())) / 1000 : 0;
        } catch (err) {
          log.debug({ queue: q.name, err: String(err) }, 'queue depth read failed');
        }
      }),
    );

    return { counts, oldest };
  };
}

function redisConnectionFor(cfg: AppConfig) {
  const url = new URL(cfg.env.REDIS_QUEUE_URL);
  return {
    host: url.hostname,
    port: Number(url.port || 6379),
    username: url.username || undefined,
    password: url.password || undefined,
    db: url.pathname && url.pathname.length > 1 ? Number(url.pathname.slice(1)) : undefined,
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
  };
}
