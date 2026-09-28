import { createHash } from 'node:crypto';
import type { Database } from '@saas/db';
import type { Logger } from 'pino';

/**
 * Report generation.
 *
 * Three deliberate properties:
 *
 * 1. **The row, not the payload, is authoritative.** The queue message is only a
 *    wake-up call; the handler re-reads `report_jobs` under the tenant's RLS
 *    context. That makes a replayed message harmless, lets a `cancelled` job be
 *    skipped without a queue-level cancel API, and means a payload tampered with
 *    in Redis cannot ask for another tenant's data.
 * 2. **Every state change is a SECURITY DEFINER function**
 *    (`app.report_job_finish`, `app.report_job_fail_or_retry`) with a transition
 *    guard, so a stale retry that arrives after a timeout is a no-op instead of a
 *    second write.
 * 3. **The artifact is stored in Postgres, size-capped.** Full text up to
 *    `inlineMaxBytes`, otherwise a summary plus a sample of rows, with the
 *    `sha256` of what *would* have been returned so a client can still verify a
 *    fetch-from-object-storage later. Results in BullMQ would be deleted by
 *    `removeOnComplete`; results in Redis are an ops knob, not a product promise.
 */
export interface ReportRow {
  id: string;
  slug: string;
  name: string;
  status: string;
  members: string;
  created_at: string;
  updated_at: string;
  last_member_activity: string | null;
}

export interface BuiltReport {
  format: 'csv' | 'json';
  rowCount: number;
  bytes: number;
  sha256: string;
  truncated: boolean;
  columns: string[];
  body?: string;
  sample?: ReportRow[];
}

const COLUMNS = [
  'id',
  'slug',
  'name',
  'status',
  'members',
  'created_at',
  'updated_at',
  'last_member_activity',
] as const;

/**
 * Real work, not a sleep. When `workMultiplier` > 1 the handler hashes
 * `rows × multiplier` KiB of synthetic data: that is genuine CPU load, which is
 * what a head-of-line-blocking / HPA experiment needs (a `setTimeout` would make
 * the pod look idle while it "worked" and would teach the autoscaler to add
 * replicas that help nobody).
 */
function burnCpu(kib: number): string {
  if (kib <= 0) {
    return '';
  }
  const h = createHash('sha256');
  const chunk = Buffer.alloc(1024, 'x');
  for (let i = 0; i < kib; i += 1) {
    h.update(chunk);
    chunk[0] = (chunk[0] ?? 120) + (i & 7);
  }
  return h.digest('hex');
}

/** RFC 4180 quoting: every field that could contain a delimiter or quote. */
export function csvEscape(value: unknown): string {
  if (value === null || value === undefined) {
    return '';
  }
  const s = String(value);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function renderCsv(rows: readonly ReportRow[], columns: readonly string[]): string {
  const head = columns.join(',');
  const body = rows.map((r) =>
    columns.map((c) => csvEscape((r as unknown as Record<string, unknown>)[c])).join(','),
  );
  return [head, ...body].join('\n');
}

export interface ReportDeps {
  db: Database;
  log: Logger;
  maxRows: number;
  workMultiplier: number;
  inlineMaxBytes: number;
}

export interface ReportRequest {
  tenantId: string;
  jobId: string;
  requestedBy: string | null;
}

export type ReportResult =
  { kind: 'done'; summary: Record<string, unknown> } | { kind: 'skipped'; reason: string };

export async function runReport(deps: ReportDeps, req: ReportRequest): Promise<ReportResult> {
  const { db, log } = deps;

  const job = await db.withTenant(
    { tenantId: req.tenantId, userId: req.requestedBy, readOnly: true },
    async (tx) => {
      const res = await tx.query<{
        status: string;
        format: 'csv' | 'json';
        options: { range?: { from: string; to: string } | null; includeArchived?: boolean } | null;
        project_scope: string | null;
        attempts: number;
      }>(
        `SELECT status, format, options, project_scope, attempts
         FROM report_jobs
        WHERE id = $1 AND tenant_id = app.current_tenant_id()`,
        [req.jobId],
      );
      return res.rows[0] ?? null;
    },
  );

  if (!job) {
    // The row is gone (tenant deleted, retention prune). Retrying cannot help.
    return { kind: 'skipped', reason: 'job-row-missing' };
  }
  if (job.status === 'completed') {
    return { kind: 'skipped', reason: 'already-completed' };
  }
  if (job.status === 'cancelled') {
    return { kind: 'skipped', reason: 'cancelled-by-user' };
  }
  if (job.status !== 'queued') {
    // 'running' with a live lock elsewhere: another pod is on it. Let BullMQ
    // retry later rather than doing the work twice.
    return { kind: 'skipped', reason: `status-${job.status}` };
  }

  // `report_jobs` has FORCE ROW LEVEL SECURITY, so even the worker's own UPDATE
  // has to run inside a tenant context — a bare pool statement would silently
  // match zero rows (RLS filters, it does not raise), and the job would sit in
  // 'queued' forever while the handler cheerfully did the work.
  await db.withTenant({ tenantId: req.tenantId }, (tx) =>
    tx.query(
      `UPDATE report_jobs SET status = 'running', started_at = now(), attempts = attempts WHERE id = $1 AND status = 'queued'`,
      [req.jobId],
    ),
  );

  const range = job.options?.range ?? null;
  const includeArchived = job.options?.includeArchived === true;
  const startedAt = Date.now();

  const rows = await db.withTenant({ tenantId: req.tenantId, readOnly: true }, async (tx) => {
    const res = await tx.query<ReportRow>(
      `SELECT p.id,
              p.slug,
              p.name,
              p.status::text,
              count(m.user_id) AS members,
              p.created_at,
              p.updated_at,
              max(m.last_seen_at) AS last_member_activity
         FROM projects p
         LEFT JOIN tenant_members m ON m.tenant_id = p.tenant_id AND m.status = 'active'
        WHERE p.tenant_id = app.current_tenant_id()
          AND ($1::uuid IS NULL OR p.id = $1)
          AND ($2 OR p.status::text <> 'archived')
          AND ($3::timestamptz IS NULL OR p.created_at >= $3::timestamptz)
          AND ($4::timestamptz IS NULL OR p.created_at <= $4::timestamptz)
        GROUP BY p.id
        ORDER BY p.created_at DESC, p.id DESC
        LIMIT $5`,
      [
        job.project_scope,
        includeArchived,
        range?.from ?? null,
        range?.to ?? null,
        deps.maxRows + 1,
      ],
    );
    return res.rows;
  });

  const truncated = rows.length > deps.maxRows;
  const kept = truncated ? rows.slice(0, deps.maxRows) : rows;

  const body =
    job.format === 'csv'
      ? renderCsv(kept, COLUMNS)
      : JSON.stringify(kept, (_k, v) => (typeof v === 'bigint' ? String(v) : v));
  const bytes = Buffer.byteLength(body, 'utf8');
  const sha256 = createHash('sha256').update(body).digest('hex');
  const burn = burnCpu(Math.round(kept.length * (deps.workMultiplier - 1)));
  if (burn) {
    log.debug({ burn, ms: Date.now() - startedAt }, 'synthetic cpu work');
  }

  const durationMs = Date.now() - startedAt;
  const summary: Record<string, unknown> = {
    // The filters are part of the artifact's meaning: `rowCount: 0` is a
    // different answer when it means "no projects" and when it means "the only
    // project in scope is archived and includeArchived was false".
    scope: {
      projectId: job.project_scope,
      includeArchived,
      range,
    },
    format: job.format,
    rowCount: kept.length,
    bytes,
    sha256,
    columns: [...COLUMNS],
    truncated,
    maxRows: deps.maxRows,
    durationMs,
    generatedAt: new Date().toISOString(),
    workMultiplier: deps.workMultiplier,
  };
  if (bytes <= deps.inlineMaxBytes) {
    summary.body = body;
  } else {
    summary.sample = kept.slice(0, 50);
  }

  // The finish/fail transitions go through the definer function on purpose: it
  // owns the legal-transition guard, so a late duplicate of this job cannot
  // overwrite a result that a previous attempt already wrote.
  await db.query('SELECT app.report_job_finish($1, $2, $3::jsonb, $4)', [
    req.jobId,
    'completed',
    JSON.stringify(summary),
    null,
  ]);
  return { kind: 'done', summary };
}
