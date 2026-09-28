import { randomUUID } from 'node:crypto';
import { Queue } from 'bullmq';
import { JOBS, QUEUES, QUEUE_DEFAULTS, jobIdFor, queueForJob, type JobName } from '@saas/shared';
import type { Database } from '@saas/db';
import type { AppConfig } from '../config/index.js';

export interface EnqueueRequest {
  tenantId: string;
  job: JobName;
  payload: Record<string, unknown>;
  /** Dedupe identity: usually the HTTP Idempotency-Key or the resource id. */
  idempotencyKey: string;
  /** When provided, the outbox row is written in this transaction. */
  tx?: { query: (sql: string, params?: readonly unknown[]) => Promise<unknown> };
  delayMs?: number;
}

export interface EnqueueResult {
  jobId: string;
  via: 'outbox' | 'bullmq';
}

/**
 * Producers never call `queue.add()` on the request path *instead of* the
 * outbox — they write the outbox and treat the immediate publish as an
 * optimisation:
 *
 *   1. INSERT INTO outbox … (same transaction as the business write) → the job
 *      is durable the moment the HTTP 2xx is durable;
 *   2. best-effort BullMQ add() right away, so a healthy queue means ~0 extra
 *      latency instead of up to one relay tick;
 *   3. if (2) fails, nothing is lost: the worker's relay (FOR UPDATE SKIP
 *      LOCKED) publishes it with backoff.
 *
 * That gives at-least-once delivery without a dual-write hazard, and it is why
 * `QUEUE_DRIVER=outbox` can run the whole system with no Redis at all.
 */
export class QueueProducer {
  private readonly queues = new Map<string, Queue>();
  private bullAvailable = false;

  constructor(
    private readonly cfg: AppConfig,
    private readonly db: Database,
    private readonly log: {
      info(o: object, m?: string): void;
      warn(o: object, m?: string): void;
      debug(o: object, m?: string): void;
    },
  ) {}

  /** Called at boot; opens BullMQ connections only in `bullmq` mode. */
  async start(): Promise<void> {
    if (this.cfg.env.QUEUE_DRIVER !== 'bullmq') {
      this.log.info({ driver: this.cfg.env.QUEUE_DRIVER }, 'queue producer in outbox-only mode');
      return;
    }
    const { createQueueConnection } = await import('../plugins/redis.js');
    for (const name of Object.values(QUEUES)) {
      const connection = createQueueConnection(this.cfg, this.log as never, `api-${name}`);
      if (!connection) {
        this.log.warn(
          { driver: this.cfg.env.QUEUE_DRIVER },
          'QUEUE_DRIVER=bullmq but REDIS_QUEUE_URL is memory:// — falling back to outbox-only',
        );
        return;
      }
      this.queues.set(name, new Queue(this.prefixed(name), { connection, ...QUEUE_DEFAULTS }));
    }
    this.bullAvailable = true;
    this.log.info({ queues: [...this.queues.keys()] }, 'bullmq producers ready');
  }

  prefixed(name: string): string {
    return `${this.cfg.env.QUEUE_NAME_PREFIX}:${name}`;
  }

  async enqueue(req: EnqueueRequest): Promise<EnqueueResult> {
    const queueName = queueForJob(req.job);
    const jobId = jobIdFor(req.tenantId, req.idempotencyKey);

    // One payload object for both transports: the BullMQ job data and the outbox
    // row must be interchangeable, because in `outbox` mode the worker only ever
    // sees the relayed row. `kind` + `idempotencyKey` are part of the contract
    // the consumer validates with (see @saas/shared parsePayload).
    const payload = {
      ...req.payload,
      kind: req.job,
      idempotencyKey: req.idempotencyKey,
      tenantId: req.tenantId,
    };
    const sql = `SELECT app.outbox_enqueue($1, $2, $3::jsonb, $4) AS id`;
    const params = [req.tenantId, req.job, JSON.stringify(payload), req.idempotencyKey];

    let outboxRowId: string | null = null;
    if (req.tx) {
      // In-transaction: the outbox row commits or rolls back with the business
      // write, which is the entire point of the pattern.
      const res = (await req.tx.query(sql, params)) as { rows?: Array<{ id: string | number }> };
      outboxRowId = String(res?.rows?.[0]?.id ?? '') || null;
    } else {
      // No tx (e.g. a post-commit notification like a welcome email): still run
      // inside the tenant's transaction, because `outbox` is RLS-protected and a
      // bare pool query would have no `app.tenant_id` to satisfy WITH CHECK.
      const res = await this.db.withTenant({ tenantId: req.tenantId }, (tx) =>
        tx.query<{ id: string | number }>(sql, params),
      );
      outboxRowId = String(res.rows[0]?.id ?? '') || null;
    }

    // Fast path: publish now, but never fail the request if the broker is down.
    if (this.bullAvailable) {
      try {
        const queue = this.queues.get(queueName);
        if (queue) {
          await queue.add(req.job, payload, {
            jobId,
            delay: req.delayMs,
            // Consumer-side idempotency is the real guarantee; this only keeps
            // the *queue* from holding two copies of the same logical job.
            attempts:
              req.job === JOBS.reportGenerate
                ? QUEUE_DEFAULTS.attempts
                : QUEUE_DEFAULTS.attempts + 1,
            backoff: QUEUE_DEFAULTS.backoff,
            removeOnComplete: QUEUE_DEFAULTS.removeOnComplete,
            removeOnFail: QUEUE_DEFAULTS.removeOnFail,
          });
          // The broker owns delivery now: settle the ledger row so the relay does
          // not re-dispatch work that is already queued. If this best-effort mark
          // fails, the relay will claim the row later and `dispatch()`'s job claim
          // turns the duplicate into a no-op — which is why marking *after* a
          // successful add (never before) is safe, and marking before is not.
          if (outboxRowId) {
            await this.db
              .query('SELECT app.outbox_mark_published(ARRAY[$1]::bigint[])', [outboxRowId])
              .catch((err: unknown) =>
                this.log.debug({ err: String(err) }, 'outbox settle after publish failed'),
              );
          }
          return { jobId, via: 'bullmq' };
        }
      } catch (err) {
        this.log.debug(
          { err: String(err), jobId, queue: queueName },
          'immediate publish failed; the outbox relay will retry it',
        );
      }
    }
    return { jobId, via: 'outbox' };
  }

  async welcomeEmail(input: {
    tenantId: string;
    tenantSlug: string;
    userId: string;
    email: string;
    displayName: string | null;
    tx?: EnqueueRequest['tx'];
  }): Promise<EnqueueResult> {
    return this.enqueue({
      tenantId: input.tenantId,
      job: JOBS.emailWelcome,
      idempotencyKey: `welcome:${input.userId}`,
      payload: {
        tenantId: input.tenantId,
        tenantSlug: input.tenantSlug,
        userId: input.userId,
        email: input.email,
        displayName: input.displayName,
        requestedAt: new Date().toISOString(),
      },
      tx: input.tx,
    });
  }

  async inviteEmail(input: {
    tenantId: string;
    tenantSlug: string;
    invitedEmail: string;
    inviteToken: string;
    invitedBy: string;
    tx?: EnqueueRequest['tx'];
  }): Promise<EnqueueResult> {
    return this.enqueue({
      tenantId: input.tenantId,
      job: JOBS.emailMemberInvite,
      idempotencyKey: `invite:${input.tenantId}:${input.invitedEmail}`,
      payload: {
        tenantId: input.tenantId,
        tenantSlug: input.tenantSlug,
        invitedEmail: input.invitedEmail,
        inviteToken: input.inviteToken,
        invitedBy: input.invitedBy,
        requestedAt: new Date().toISOString(),
      },
      tx: input.tx,
    });
  }

  async report(input: {
    tenantId: string;
    requestedBy: string;
    reportJobId: string;
    options: Record<string, unknown>;
    idempotencyKey?: string;
    tx?: EnqueueRequest['tx'];
  }): Promise<EnqueueResult> {
    return this.enqueue({
      tenantId: input.tenantId,
      job: JOBS.reportGenerate,
      idempotencyKey: input.idempotencyKey ?? `report:${input.reportJobId}`,
      payload: {
        tenantId: input.tenantId,
        requestedBy: input.requestedBy,
        jobId: input.reportJobId,
        options: input.options,
        requestedAt: new Date().toISOString(),
      },
      tx: input.tx,
    });
  }

  /** Queue depth for a status endpoint, without importing the queue lib in outbox mode. */
  async depth(): Promise<Record<string, number> | null> {
    if (!this.bullAvailable) {
      return null;
    }
    const out: Record<string, number> = {};
    for (const [name, q] of this.queues) {
      const counts = await q.getJobCounts('waiting', 'active', 'delayed', 'failed');
      out[name] = Object.values(counts).reduce((a, b) => a + Number(b), 0);
    }
    return out;
  }

  async close(): Promise<void> {
    for (const q of this.queues.values()) {
      await q.close();
    }
    this.queues.clear();
    this.bullAvailable = false;
  }
}

export function newReportJobId(): string {
  return randomUUID();
}
