import { QUEUES, QUEUE_DEFAULTS, type JobName } from '@saas/shared';
import type { Database } from '@saas/db';
import { Queue, Worker } from 'bullmq';
import { Redis } from 'ioredis';
import type { JobEnvelope, DispatchResult } from './jobs.js';
import type { WorkerMetrics } from './metrics.js';

/**
 * BullMQ side of the consumer: one Worker per queue plus the dead-letter queue.
 *
 * Two choices worth stating because they are the ones people get wrong:
 *
 * 1. **`retry` results are thrown, not swallowed.** BullMQ owns the retry
 *    schedule when it is the transport (backoff, attempts, the `delayed` set);
 *    re-implementing a timer here would produce two competing schedules and
 *    jobs that run twice as often as either. So the processor's contract is:
 *    return = done (including "permanently dead, already parked in the DLQ"),
 *    throw = retry me.
 * 2. **The DLQ is a queue, not a status column** in this mode, so the standard
 *    tooling (`bullmq` CLI, a replay script, a dashboard panel on `failed`)
 *    works on it. `app.outbox`'s `discarded` rows remain the *durable* record
 *    of the same events; the two are reconciled by `outbox_depth`.
 *
 * Connections are `ioredis` instances cloned by BullMQ itself, so each worker
 * owns its sockets — sharing one connection between a Worker and a Queue is the
 * classic cause of "blocked" commands when a blocking `BRPOPLPUSH` holds it.
 */
export interface BrokerDeps {
  url: string;
  prefix: string;
  log: {
    info(o: object, m?: string): void;
    warn(o: object, m?: string): void;
    error(o: object, m?: string): void;
    debug(o: object, m?: string): void;
  };
  metrics: WorkerMetrics;
  db: Database;
  dispatch: (env: JobEnvelope) => Promise<DispatchResult>;
  concurrency: number;
  keyPrefix?: string;
}

export interface Broker {
  start(): Promise<void>;
  close(): Promise<void>;
  depths(): Promise<Record<string, Record<string, number>>>;
  pushDeadLetter(input: {
    queue: string;
    job: JobName;
    tenantId: string;
    idempotencyKey: string;
    error: string;
    reason: string;
  }): Promise<void>;
  listDeadLetters(limit: number): Promise<DeadLetterEntry[]>;
  replayDeadLetters(ids: string[]): Promise<number>;
  dlqDepth(): Promise<number>;
}

export interface DeadLetterEntry {
  id: string;
  queue: string;
  job: string;
  tenantId: string;
  attempts: number;
  failedReason: string;
  movedAt: string | null;
}

export function createBroker(deps: BrokerDeps): Broker {
  const connection = () =>
    new Redis(deps.url, {
      // BullMQ requires maxRetriesPerRequest=null so a blocking command is never
      // re-issued behind the scenes (that would break the job lock semantics).
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
      // Same rule as the API: a queued-up command against a dead Redis is worse
      // than an immediate error the caller can fall back for.
      enableOfflineQueue: false,
      connectionName: `worker-${process.pid}`,
      keyPrefix: deps.keyPrefix,
    });

  // Queue names stay bare: BullMQ rejects ':' inside a name, and the namespace
  // belongs to the `prefix` *option* so every key becomes
  // `{prefix}:{queue}:{…}` — exactly the keys the API's producer creates.
  const names = {
    email: QUEUES.email,
    reports: QUEUES.reports,
    dead: QUEUES.deadLetter,
  };

  const dlq = new Queue(names.dead, { connection: connection(), prefix: deps.prefix });
  const workers: Worker[] = [];

  const makeWorker = (queueName: string) =>
    new Worker(
      queueName,
      async (job) => {
        const data = (job.data ?? {}) as Record<string, unknown>;
        const tenantId = typeof data.tenantId === 'string' ? data.tenantId : '';
        if (!tenantId) {
          // Without a tenant the handler cannot even open a scoped transaction,
          // and guessing from the payload would be worse than failing loudly.
          throw new Error('job payload missing tenantId');
        }
        const envelope: JobEnvelope = {
          topic: job.name as JobName,
          tenantId,
          payload: data,
          idempotencyKey:
            typeof data.idempotencyKey === 'string' ? data.idempotencyKey : String(job.id),
          attempts: (job.attemptsMade ?? 0) + 1,
          maxAttempts: (job.opts.attempts as number | undefined) ?? QUEUE_DEFAULTS.attempts,
          source: 'bullmq',
        };
        deps.metrics.activeJobs.inc({ queue: queueName });
        try {
          const result = await deps.dispatch(envelope);
          if (result.kind === 'retry') {
            // Hand the schedule back to BullMQ.
            throw new Error(result.error);
          }
          if (result.kind === 'dead') {
            await dlq
              .add(
                envelope.topic,
                {
                  ...envelope.payload,
                  _dead: {
                    reason: result.reason,
                    error: result.error,
                    at: new Date().toISOString(),
                  },
                },
                {
                  jobId: `${envelope.topic}:${envelope.idempotencyKey}`.slice(0, 128),
                  removeOnComplete: { age: 3600 * 24 * 7 },
                  removeOnFail: { age: 3600 * 24 * 30 },
                },
              )
              .catch((err: unknown) =>
                deps.log.warn({ err: String(err) }, 'dead-letter add failed'),
              );
          }
          return result;
        } finally {
          deps.metrics.activeJobs.dec({ queue: queueName });
        }
      },
      {
        connection: connection(),
        concurrency: deps.concurrency,
        // Same lock policy as the producer's defaults, so a stalled job is
        // re-claimed on a schedule the operator can reason about.
        lockDuration: QUEUE_DEFAULTS.lockDuration,
        maxStalledCount: QUEUE_DEFAULTS.maxStalledCount,
        // Same namespace the producer uses — see the `names` note above.
        prefix: deps.prefix,
      },
    );

  for (const name of [names.email, names.reports]) {
    const w = makeWorker(name);
    w.on('failed', (job, err) => {
      deps.log.warn(
        { queue: name, jobId: job?.id, attempt: job?.attemptsMade, err: err.message },
        'job attempt failed',
      );
    });
    w.on('error', (err) => deps.log.warn({ err: err.message }, 'worker error'));
    workers.push(w);
  }

  return {
    async start() {
      deps.log.info(
        { queues: [names.email, names.reports], concurrency: deps.concurrency },
        'bullmq workers ready',
      );
    },
    async close() {
      // `close()` waits for the jobs this pod is holding; the caller caps it with
      // the shutdown-grace budget and then lets the lease expire instead.
      await Promise.all(workers.map((w) => w.close()));
      await dlq.close();
    },
    async depths() {
      const out: Record<string, Record<string, number>> = {};
      await Promise.all(
        [names.email, names.reports, names.dead].map(async (name) => {
          const q = new Queue(name, { connection: connection(), prefix: deps.prefix });
          try {
            const counts = await q.getJobCounts(
              'waiting',
              'active',
              'delayed',
              'failed',
              'completed',
            );
            out[name] = counts as unknown as Record<string, number>;
          } finally {
            await q.close();
          }
        }),
      );
      return out;
    },
    async pushDeadLetter(input) {
      await dlq.add(
        input.job,
        {
          tenantId: input.tenantId,
          _dead: { reason: input.reason, error: input.error, at: new Date().toISOString() },
        },
        {
          jobId: `${input.job}:${input.idempotencyKey}`.slice(0, 128),
          removeOnComplete: { age: 3600 * 24 * 7 },
          removeOnFail: { age: 3600 * 24 * 30 },
        },
      );
    },
    async listDeadLetters(limit) {
      const jobs = await dlq.getJobs(['waiting', 'delayed'], 0, Math.max(1, Math.min(limit, 200)));
      return jobs.map((job): DeadLetterEntry => {
        const meta =
          (job.data as { _dead?: { reason?: string; error?: string; at?: string } } | undefined)
            ?._dead ?? {};
        return {
          id: String(job.id ?? ''),
          queue: names.dead,
          job: job.name,
          tenantId: String((job.data as { tenantId?: string } | undefined)?.tenantId ?? ''),
          attempts: job.attemptsMade,
          failedReason: String(meta.error ?? job.failedReason ?? ''),
          movedAt: meta.at ?? null,
        };
      });
    },
    async replayDeadLetters(ids) {
      let n = 0;
      for (const id of ids) {
        const job = await dlq.getJob(id);
        if (!job) {
          continue;
        }
        // `retry()` pushes the job back onto its parent queue with a fresh
        // attempt budget — the payload and its idempotency key are untouched, so
        // the claim in `dispatch()` is what decides whether the work re-runs.
        await job.retry().catch(async () => {
          await dlq.add(job.name, job.data, {
            removeOnComplete: { age: 3600 },
            removeOnFail: { age: 3600 },
          });
          await job.remove();
        });
        n += 1;
      }
      return n;
    },
    async dlqDepth() {
      const counts = await dlq.getJobCounts('waiting', 'delayed');
      return Number(counts.waiting ?? 0) + Number(counts.delayed ?? 0);
    },
  };
}
