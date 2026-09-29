import { randomUUID } from 'node:crypto';
import { Queue } from 'bullmq';
import { JOBS, QUEUES, QUEUE_DEFAULTS, jobIdFor, queueForJob, type JobName } from '@saas/shared';
import type { Database, TransactionScope } from '@saas/db';
import type { AppConfig } from '../config/index.js';

export interface EnqueueRequest {
  tenantId: string;
  job: JobName;
  payload: Record<string, unknown>;
  /** Dedupe identity: usually the HTTP Idempotency-Key or the resource id. */
  idempotencyKey: string;
  /**
   * When provided, the outbox row is written in this transaction.
   *
   * Pass `txScope` together with `tx` — it is how the fast-path publish is
   * deferred to after COMMIT. Publishing inside the transaction is a dual-write
   * in disguise: the broker would make the job visible before the row it
   * describes exists, and a consumer that reads "row not found" as success
   * loses the job silently (this is not hypothetical — it lost ~14% of report
   * jobs before the fix). Without `txScope` the enqueue is outbox-only, which
   * is always safe: the relay delivers it.
   */
  tx?: { query: (sql: string, params?: readonly unknown[]) => Promise<unknown> };
  txScope?: Pick<TransactionScope, 'afterCommit'>;
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
 *   2. best-effort BullMQ add() immediately *after COMMIT* (never inside the
 *      transaction — the broker must not become aware of a job before the row
 *      it describes is visible), so a healthy queue means ~0 extra latency
 *      instead of up to one relay tick;
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
      // BullMQ builds its Redis keys as `{prefix}:{queue}:{…}`. The prefix must
      // be passed as an option — baking it into the name throws ("Queue name
      // cannot contain :") and would silently fork the queue from the one the
      // worker consumes if it ever did not. The worker passes the same option.
      this.queues.set(
        name,
        new Queue(name, {
          connection,
          prefix: this.cfg.env.QUEUE_NAME_PREFIX,
          ...QUEUE_DEFAULTS,
        }),
      );
    }
    this.bullAvailable = true;
    this.log.info({ queues: [...this.queues.keys()] }, 'bullmq producers ready');
  }

  /** BullMQ key namespace shared with the worker ({@see QUEUES}). */
  queuePrefix(): string {
    return this.cfg.env.QUEUE_NAME_PREFIX;
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
      if (req.txScope) {
        // Fast path, deferred until the row is actually visible: the publish
        // (and its outbox settle) may only run once COMMIT returned. If the
        // transaction rolls back, neither runs — no phantom job, no settle of
        // a row that does not exist.
        req.txScope.afterCommit(() =>
          this.publishFastPath(queueName, req, payload, jobId, outboxRowId),
        );
        return { jobId, via: 'bullmq' };
      }
      // No scope (legacy caller): outbox-only is the safe default — the relay
      // will deliver it a tick later.
      return { jobId, via: 'outbox' };
    }
    // No tx (e.g. a post-commit notification like a welcome email): the row is
    // committed by the withTenant below, so publishing right after it is safe.
    // Still run inside the tenant's transaction, because `outbox` is
    // RLS-protected and a bare pool query would have no `app.tenant_id` to
    // satisfy WITH CHECK.
    const res = await this.db.withTenant({ tenantId: req.tenantId }, (tx) =>
      tx.query<{ id: string | number }>(sql, params),
    );
    outboxRowId = String(res.rows[0]?.id ?? '') || null;
    const via = await this.publishFastPath(queueName, req, payload, jobId, outboxRowId);
    return { jobId, via };
  }

  /**
   * Best-effort BullMQ publish, plus the outbox settle that must follow it.
   * Returns `'bullmq'` when the job reached the broker, `'outbox'` otherwise —
   * never throws, because a broker blip must not fail an already-committed
   * business write: the relay is the safety net for exactly that case.
   */
  private async publishFastPath(
    queueName: string,
    req: EnqueueRequest,
    payload: Record<string, unknown>,
    jobId: string,
    outboxRowId: string | null,
  ): Promise<'bullmq' | 'outbox'> {
    if (!this.bullAvailable) {
      return 'outbox';
    }
    try {
      const queue = this.queues.get(queueName);
      if (!queue) {
        return 'outbox';
      }
      await queue.add(req.job, payload, {
        jobId,
        delay: req.delayMs,
        // Consumer-side idempotency is the real guarantee; this only keeps
        // the *queue* from holding two copies of the same logical job.
        attempts:
          req.job === JOBS.reportGenerate ? QUEUE_DEFAULTS.attempts : QUEUE_DEFAULTS.attempts + 1,
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
      return 'bullmq';
    } catch (err) {
      this.log.debug(
        { err: String(err), jobId, queue: queueName },
        'immediate publish failed; the outbox relay will retry it',
      );
      return 'outbox';
    }
  }

  async welcomeEmail(input: {
    tenantId: string;
    tenantSlug: string;
    userId: string;
    email: string;
    displayName: string | null;
    tx?: EnqueueRequest['tx'];
    txScope?: EnqueueRequest['txScope'];
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
      txScope: input.txScope,
    });
  }

  async inviteEmail(input: {
    tenantId: string;
    tenantSlug: string;
    invitedEmail: string;
    inviteToken: string;
    invitedBy: string;
    tx?: EnqueueRequest['tx'];
    txScope?: EnqueueRequest['txScope'];
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
      txScope: input.txScope,
    });
  }

  async report(input: {
    tenantId: string;
    requestedBy: string;
    reportJobId: string;
    options: Record<string, unknown>;
    idempotencyKey?: string;
    tx?: EnqueueRequest['tx'];
    txScope?: EnqueueRequest['txScope'];
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
      txScope: input.txScope,
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
