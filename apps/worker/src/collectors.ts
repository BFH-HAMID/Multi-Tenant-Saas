import type { Database } from '@saas/db';
import type { Broker } from './broker.js';
import type { WorkerMetrics } from './metrics.js';

/**
 * Pull-based gauges, on one interval, independent of job throughput.
 *
 * Why not update depth on every job? Because the number a dashboard alerts on
 * then depends on traffic: an idle queue with a stuck job would report its depth
 * as whatever it was when the last job finished — which is precisely the failure
 * the alert exists to catch. Reading `app.outbox_depth` and the broker counts on
 * a fixed tick costs one query per interval and is true by construction.
 *
 * Every collector is best-effort: a failing collector must not break the scrape,
 * because a missing scrape blinds the alert that would have caught the incident.
 */
export interface CollectorDeps {
  db: Database;
  metrics: WorkerMetrics;
  broker: Broker | null;
  log: { warn(o: object, m?: string): void; debug(o: object, m?: string): void };
  intervalMs: number;
}

export interface Collectors {
  start(): void;
  stop(): void;
  probe(): Promise<void>;
}

export function startCollectors(deps: CollectorDeps): Collectors {
  let timer: NodeJS.Timeout | null = null;

  async function probe(): Promise<void> {
    try {
      const res = await deps.db.query<{
        pending: string;
        failed: string;
        discarded: string;
        oldest_pending_seconds: string;
      }>(
        `SELECT pending::text AS pending,
                failed::text AS failed,
                discarded::text AS discarded,
                oldest_pending_seconds::text AS oldest_pending_seconds
           FROM app.outbox_depth`,
      );
      const row = res.rows[0];
      if (row) {
        deps.metrics.outboxPending.set({ kind: 'pending' }, Number(row.pending));
        deps.metrics.outboxPending.set({ kind: 'failed' }, Number(row.failed));
        deps.metrics.outboxPending.set({ kind: 'discarded' }, Number(row.discarded));
        deps.metrics.outboxLag.set(Number(row.oldest_pending_seconds));
        // Outbox mode has no broker to ask, so the ledger's own age *is* the
        // queue age. Reporting it here (instead of leaving the gauge unset) keeps
        // `queue_oldest_pending_job_seconds > 60` meaningful in both drivers — an
        // unset gauge reads 0, which is exactly what a staleness alert must not be
        // fooled by.
        deps.metrics.oldestPending.set({ queue: 'outbox' }, Number(row.oldest_pending_seconds));
        // The outbox is the durable ledger, so its pending count is the queue
        // depth for the `outbox` driver; in bullmq mode the broker wins below.
        deps.metrics.queueDepth.set({ queue: 'outbox', state: 'pending' }, Number(row.pending));
      }
    } catch (err) {
      deps.log.debug({ err: String(err) }, 'outbox depth probe failed');
    }

    if (deps.broker) {
      try {
        const depths = await deps.broker.depths();
        for (const [queue, counts] of Object.entries(depths)) {
          for (const [state, n] of Object.entries(counts)) {
            deps.metrics.queueDepth.set({ queue, state }, Number(n));
          }
        }
        const dlq = await deps.broker.dlqDepth();
        deps.metrics.dlqDepth.set(Math.max(0, dlq));
      } catch (err) {
        deps.log.debug({ err: String(err) }, 'broker depth probe failed');
      }
    }
  }

  return {
    start() {
      void probe();
      timer = setInterval(() => void probe(), deps.intervalMs);
      timer.unref?.();
    },
    stop() {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },
    probe,
  };
}
