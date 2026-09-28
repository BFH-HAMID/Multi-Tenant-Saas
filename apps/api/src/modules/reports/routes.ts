import { AppError, JOBS, generateReportSchema, newTenantId, notFound } from '@saas/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { API_PREFIX, IDEMPOTENCY_HEADER } from '../../config/constants.js';
import { readBody, useParams, doc } from '../../lib/validate.js';
import { audit } from '../../services/audit.js';
import { etagFor } from '../../lib/paginate.js';

const jobParams = z.object({ jobId: z.string().uuid() });
const statusQuery = z.object({ wait: z.coerce.number().int().min(0).max(30).default(0) });

/**
 * The async work path, and the reason the queue decision is testable at all:
 *
 *   POST /projects/{id}/reports → INSERT report_jobs (queued) + outbox row, one
 *   tx → 202 with `jobId`; the worker (BullMQ consumer *or* outbox poller) does
 *   the work and writes the result back through `app.report_job_finish`;
 *   GET /reports/{jobId} → status, cached for a couple of seconds.
 *
 * Deliberate details:
 *   - 202, not 200: nothing has happened yet, and clients must poll.
 *   - `Location` points at the status URL, so a client can implement retries
 *     without guessing our routing.
 *   - the row and the queue write share a transaction, so "202 accepted" and
 *     "the job exists" are the same fact;
 *   - polling is a *read*, and the result is immutable once written, so it is the
 *     one place where a short TTL is free of regret.
 */
export function reportRoutes(app: FastifyInstance): void {
  app.post(
    `${API_PREFIX}/projects/:id/reports`,
    {
      config: {
        role: 'member',
        routeClass: 'bulk',
        rateLimitCost: 1,
        idempotency: 'optional',
        summary: 'Queue a report generation job (202 + poll for status)',
        operationId: 'generateReport',
      },
      schema: {
        tags: ['reports'],
        params: doc(z.object({ id: z.string().uuid() })),
        body: doc(generateReportSchema),
        'x-zod': true,
      },
    },
    async (req, reply) => {
      const { id } = useParams(req, z.object({ id: z.string().uuid() }));
      const body = readBody(req, generateReportSchema);
      const tenant = req.tenant!;
      const jobId = newTenantId();
      const idem = req.idempotencyKey ?? body.idempotencyKey ?? `report:${jobId}`;

      await app.projects.get(tenant, id); // 404s cross-tenant ids without leaking existence

      const accepted = await app.db.withTenant(
        { tenantId: tenant.id, userId: req.auth!.userId },
        async (tx) => {
          // Capacity is checked *inside* the transaction, on the same snapshot the
          // insert happens on: a free workspace may have at most N reports in
          // flight, and a read-then-insert outside the tx would let a burst of
          // parallel POSTs all see "0 running" and all queue work we cannot do.
          const queued = await tx.query<{ n: string }>(
            `SELECT count(*)::text AS n FROM report_jobs
            WHERE tenant_id = app.current_tenant_id() AND status IN ('queued','running')`,
          );
          const running = Number(queued.rows[0]?.n ?? 0);
          const maxConcurrent = tenant.planLimits.maxConcurrentJobs;
          if (running >= maxConcurrent) {
            throw new AppError(
              'PLAN_LIMIT_EXCEEDED',
              `${running} reports are already in flight for this workspace (plan allows ${maxConcurrent})`,
              429,
              { headers: { 'retry-after': '30' }, details: { running, maxConcurrent } },
            );
          }

          await tx.query(
            `INSERT INTO report_jobs (id, tenant_id, requested_by, project_scope, format, status, options, max_attempts, idempotency_key)
           VALUES ($1, app.current_tenant_id(), $2, $3, $4, 'queued', $5::jsonb, $6, $7)`,
            [
              jobId,
              req.auth!.userId,
              id,
              body.format,
              JSON.stringify({ range: body.range ?? null, includeArchived: body.includeArchived }),
              maxAttempts(tenant.plan),
              idem,
            ],
          );
          await tx.query('SELECT app.audit($1,$2,$3,$4::jsonb)', [
            'report.requested',
            'report_job',
            jobId,
            JSON.stringify({ format: body.format, projectId: id }),
          ]);
          // The outbox row is written in this transaction (queue/producer.ts): the
          // job is durable exactly when the 202 becomes observable.
          await app.producer.report({
            tenantId: tenant.id,
            requestedBy: req.auth!.userId,
            reportJobId: jobId,
            idempotencyKey: idem,
            options: {
              format: body.format,
              range: body.range ?? null,
              includeArchived: body.includeArchived,
            },
            tx,
          });
          return { jobId };
        },
      );

      await audit(app, req, 'report.requested', {
        targetType: 'report_job',
        targetId: accepted.jobId,
        data: { projectId: id },
      });

      return reply
        .code(202)
        .header('location', `${API_PREFIX}/reports/${jobId}`)
        .header('retry-after', '2')
        .header(IDEMPOTENCY_HEADER, idem)
        .send({
          jobId,
          state: 'queued',
          statusUrl: `${API_PREFIX}/reports/${jobId}`,
          pollAfterMs: 1000,
          queue: app.cfg.env.QUEUE_DRIVER === 'bullmq' ? JOBS.reportGenerate : 'outbox',
        });
    },
  );

  app.get(
    `${API_PREFIX}/reports/:jobId`,
    {
      config: {
        role: 'viewer',
        routeClass: 'read',
        summary: 'Poll a report job',
        operationId: 'getReportStatus',
      },
      schema: {
        tags: ['reports'],
        params: doc(jobParams),
        querystring: doc(statusQuery),
        'x-zod': true,
      },
    },
    async (req, reply) => {
      const { jobId } = useParams(req, jobParams);
      const tenant = req.tenant!;

      const rows = await app.db.withTenant(
        { tenantId: tenant.id, readOnly: true },
        async (tx) =>
          (
            await tx.query<{
              id: string;
              status: string;
              progress: number;
              attempts: number;
              max_attempts: number;
              format: string;
              error: string | null;
              result: unknown;
              created_at: Date;
              started_at: Date | null;
              finished_at: Date | null;
              queue_job_id: string | null;
            }>(
              `SELECT id, status, progress, attempts, max_attempts, format, error, result,
                    created_at, started_at, finished_at, queue_job_id
               FROM report_jobs WHERE id = $1`,
              [jobId],
            )
          ).rows,
      );

      const job = rows[0];
      if (!job) {
        throw notFound('Report job');
      }
      const payload = {
        jobId: job.id,
        state: job.status as 'queued' | 'running' | 'completed' | 'failed' | 'cancelled',
        progress: job.progress,
        attempts: job.attempts,
        maxAttempts: job.max_attempts,
        format: job.format,
        error: job.error,
        result: job.status === 'completed' ? job.result : undefined,
        queueJobId: job.queue_job_id,
        createdAt: job.created_at.toISOString(),
        startedAt: job.started_at ? job.started_at.toISOString() : null,
        finishedAt: job.finished_at ? job.finished_at.toISOString() : null,
      };
      const etag = etagFor(payload);
      if (req.headers['if-none-match'] === etag) {
        return reply.code(304).send();
      }
      // Terminal states may be cached by the client; in-flight ones must not.
      const terminal = payload.state === 'completed' || payload.state === 'failed';
      reply
        .header('etag', etag)
        .header('cache-control', terminal ? 'private, max-age=300' : 'private, no-cache')
        .header('retry-after', terminal ? '0' : '2');
      return payload;
    },
  );
}

function maxAttempts(plan: PlanIdLike): number {
  return plan === 'enterprise' ? 5 : plan === 'pro' ? 4 : 3;
}
type PlanIdLike = 'free' | 'pro' | 'enterprise';
