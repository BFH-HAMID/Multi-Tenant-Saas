import { QUEUES, QUEUE_DEFAULTS, type JobName } from '@saas/shared';
import type { Database } from '@saas/db';
import type { DispatchResult, JobEnvelope } from './jobs.js';
import type { WorkerMetrics } from './metrics.js';

/**
 * The transactional-outbox relay.
 *
 * `app.outbox_claim` already does the hard part — `FOR UPDATE … SKIP LOCKED`
 * plus a lease — so this loop needs no leader election and no coordination: N
 * replicas can all run it and each will get a disjoint batch. The two rules that
 * matter here:
 *
 *   - **The lease, not the handler, decides re-delivery.** A pod that dies mid
 *     job stops extending the lease, so after `leaseSeconds` another pod claims
 *     the row. That is why dispatch is expected to be idempotent (it claims a job
 *     key), not why it is nice to have.
 *   - **Backoff lives in the row** (`next_attempt_at`), not in memory: a restart
 *     must not turn a hot-looping poison message into a hot loop again.
 *
 * Ticks are scheduled with `setTimeout` after the previous one *finishes*
 * (never `setInterval`), because a busy relay whose batches overlap would
 * double-claim up to `batchSize × concurrentTicks` rows and starve the pool.
 */
export interface RelayDeps {
  db: Database;
  log: {
    info(o: object, m?: string): void;
    warn(o: object, m?: string): void;
    debug(o: object, m?: string): void;
    error(o: object, m?: string): void;
  };
  metrics: WorkerMetrics;
  dispatch: (env: JobEnvelope) => Promise<DispatchResult>;
  onDead: (env: JobEnvelope, result: Extract<DispatchResult, { kind: 'dead' }>) => Promise<void>;
  intervalMs: number;
  batchSize: number;
  leaseSeconds: number;
  concurrency: number;
}

export interface Relay {
  start(): void;
  stop(): Promise<void>;
  /** One tick, exposed for tests and for `--once` in the smoke harness. */
  tick(): Promise<number>;
  stats(): { ticks: number; claimed: number; errors: number; running: boolean; lastTickMs: number };
}

interface ClaimedRow {
  id: string;
  tenant_id: string;
  topic: JobName;
  payload: Record<string, unknown>;
  idempotency_key: string | null;
  attempts: number;
  max_attempts: number;
}

export function createRelay(deps: RelayDeps): Relay {
  let timer: NodeJS.Timeout | null = null;
  let stopping = false;
  let inFlight: Promise<number> | null = null;
  const stats = { ticks: 0, claimed: 0, errors: 0, lastTickMs: 0 };

  async function tick(): Promise<number> {
    const startedAt = performance.now();
    stats.ticks += 1;
    // `outbox_claim_batch` (0012) rather than 0005's `outbox_claim`: the consumer
    // needs `max_attempts` to decide "retry later" vs "dead-letter now", and it
    // cannot read that from the RLS-protected table itself (it has no tenant
    // membership, so a JOIN there returns zero rows and the relay quietly stops).
    const res = await deps.db.query<ClaimedRow>(
      `SELECT o_id::text AS id,
              o_tenant_id AS tenant_id,
              o_topic AS topic,
              o_payload AS payload,
              o_idempotency_key AS idempotency_key,
              o_attempts AS attempts,
              o_max_attempts AS max_attempts
         FROM app.outbox_claim_batch($1::int, $2::int)`,
      [deps.batchSize, deps.leaseSeconds],
    );
    const rows = res.rows;
    stats.lastTickMs = performance.now() - startedAt;
    if (rows.length === 0) {
      deps.metrics.relayTicks.inc({ outcome: 'idle' });
      return 0;
    }
    stats.claimed += rows.length;
    deps.metrics.relayTicks.inc({ outcome: 'claimed' });

    let handled = 0;
    await mapLimit(rows, deps.concurrency, async (row) => {
      const envelope: JobEnvelope = {
        topic: row.topic,
        tenantId: row.tenant_id,
        payload: row.payload ?? {},
        idempotencyKey: row.idempotency_key ?? `outbox:${row.id}`,
        attempts: row.attempts,
        maxAttempts: row.max_attempts ?? QUEUE_DEFAULTS.attempts,
        source: 'outbox',
        rowId: row.id,
      };
      const result = await deps.dispatch(envelope);
      handled += 1;
      await settle(deps, row, result);
      if (result.kind === 'dead') {
        await deps.onDead(envelope, result).catch((err: unknown) => {
          deps.log.warn({ err: String(err), id: row.id }, 'DLQ write failed');
        });
      }
    });
    return handled;
  }

  function schedule(): void {
    if (stopping) {
      return;
    }
    timer = setTimeout(async () => {
      try {
        inFlight = tick();
        await inFlight;
      } catch (err) {
        stats.errors += 1;
        deps.metrics.relayTicks.inc({ outcome: 'error' });
        deps.metrics.errors.inc({ where: 'relay' });
        // A claim failure is usually "the pool is exhausted" or "Postgres is
        // restarting" — both clear on their own, so warn (not error) and retry
        // on the next tick instead of alerting on every blip.
        deps.log.warn({ err: String(err) }, 'outbox relay tick failed');
      } finally {
        inFlight = null;
        schedule();
      }
    }, deps.intervalMs);
    // Node keeps the process alive for pending timers; a worker should exit on
    // SIGTERM even mid-tick, so this one must not hold the loop open.
    timer.unref?.();
  }

  return {
    start() {
      stopping = false;
      deps.log.info(
        {
          intervalMs: deps.intervalMs,
          batchSize: deps.batchSize,
          leaseSeconds: deps.leaseSeconds,
          concurrency: deps.concurrency,
        },
        'outbox relay started',
      );
      schedule();
    },
    async stop() {
      stopping = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      // Let the current batch finish rather than abandoning leases mid-handler.
      if (inFlight) {
        await inFlight.catch(() => undefined);
      }
      deps.log.info(stats, 'outbox relay stopped');
    },
    tick,
    stats: () => ({ ...stats, running: !stopping }),
  };
}

async function settle(deps: RelayDeps, row: ClaimedRow, result: DispatchResult): Promise<void> {
  const id = Number(row.id);
  switch (result.kind) {
    case 'completed':
    case 'skipped':
      await deps.db.query('SELECT app.outbox_mark_published(ARRAY[$1]::bigint[])', [id]);
      deps.metrics.outboxPublished.inc({ topic: row.topic });
      return;
    case 'retry':
      await deps.db.query('SELECT app.outbox_mark_failed($1, $2, $3)', [
        id,
        result.error.slice(0, 500),
        Math.ceil(result.afterMs / 1000),
      ]);
      return;
    case 'dead':
    default: {
      // Terminal, so it must leave `pending` *now*: `dispatch()` has already decided
      // this can never succeed (poison payload, key collision, retries exhausted).
      // Scheduling another attempt instead would keep `outbox_depth.pending` and
      // `outbox_oldest_lag_seconds` high for an hour per bad message — which is the
      // exact signal the "queue is stuck" alert watches, so it would page for
      // garbage and miss a real stall. 0013's `mark_discarded` is the DB's answer.
      await deps.db
        .query('SELECT app.outbox_mark_discarded($1, $2)', [
          id,
          `${result.kind}:${'error' in result ? result.error : ''}`.slice(0, 500),
        ])
        .catch((err: unknown) =>
          deps.log.warn({ err: String(err), id: row.id }, 'mark_discarded failed'),
        );
      return;
    }
  }
}

/** Bounded parallel map: `limit` at a time, first error wins. */
async function mapLimit<T>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let cursor = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const i = cursor;
      cursor += 1;
      if (i >= items.length) {
        return;
      }
      await fn(items[i] as T);
    }
  });
  await Promise.all(workers);
}

export function relayQueueNames(): string[] {
  return Object.values(QUEUES);
}
