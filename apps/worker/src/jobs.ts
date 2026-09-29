import { createHash } from 'node:crypto';
import {
  emailInvitePayload,
  emailWelcomePayload,
  JOBS,
  QUEUES,
  reportPayload,
  type JobName,
} from '@saas/shared';
import type { Database } from '@saas/db';
import type { Logger } from 'pino';
import type { MailTransport } from './handlers/email.js';
import { inviteText, welcomeText } from './handlers/email.js';
import { runReport } from './handlers/report.js';
import type { WorkerMetrics } from './metrics.js';

/**
 * Job dispatch: the single place where a message becomes a handler call, and the
 * only place that decides what happens when a handler fails. Both transports
 * (BullMQ and the Postgres outbox relay) funnel through `dispatch()`, so a job
 * behaves identically whichever one delivered it — that property is what makes
 * `QUEUE_DRIVER` a deployment choice instead of a semantic one.
 *
 * Retry policy, stated once:
 *
 *   - **Poison messages never retry.** A payload that fails `parsePayload` is
 *     structurally unwelcome: it will fail the same way on attempt 37, and each
 *     attempt burns a concurrency slot that the *next tenant's* work needs. It
 *     goes straight to the DLQ. This is the difference between a bad deploy
 *     causing 3 retries and causing 3 retries × 100k jobs of self-inflicted DoS.
 *   - **Everything else retries with exponential backoff** (500ms · 2^attempts,
 *     capped at 5 min) up to the queue's `attempts`, because the dominant real
 *     failure modes here are transient by nature: connection reset, statement
 *     timeout, lock contention, a relay that is grey-listing.
 *   - **The job's own idempotency claim is released on failure and completed on
 *     success**, so a retry can re-claim it but a *replayed* successful job is a
 *     no-op. Completion is stored in `idempotency_keys` (same definer functions
 *     the API uses for HTTP-level idempotency) — one mechanism, two layers.
 *   - **Terminal failure writes an audit row and the DLQ copy**, so "which
 *     tenant's job died and why" is answerable from the database, not only from
 *     pod logs that rotate.
 */
export interface JobEnvelope {
  /** Queue-side topic name (`report.generate`, …). */
  topic: JobName;
  tenantId: string;
  payload: Record<string, unknown>;
  idempotencyKey: string;
  /** Attempts already spent (1 on the first try, matching the outbox counter). */
  attempts: number;
  maxAttempts: number;
  source: 'bullmq' | 'outbox';
  /** Outbox row id, so the relay can settle it after the handler returns. */
  rowId?: number | string;
}

export type DispatchResult =
  | { kind: 'completed'; detail: unknown }
  | { kind: 'skipped'; reason: string }
  | { kind: 'retry'; afterMs: number; error: string }
  | { kind: 'dead'; reason: string; error: string };

export interface DispatchDeps {
  db: Database;
  log: Logger;
  metrics: WorkerMetrics;
  mail: MailTransport;
  report: {
    maxRows: number;
    workMultiplier: number;
    inlineMaxBytes: number;
  };
  claimTtlSeconds: number;
  acceptBaseUrl: string;
}

const BACKOFF_BASE_MS = 500;
const BACKOFF_CAP_MS = 300_000;

export function backoffMs(attempts: number): number {
  return Math.min(BACKOFF_BASE_MS * 2 ** Math.max(0, attempts - 1), BACKOFF_CAP_MS);
}

/**
 * Errors that will not fix themselves. Anything matching these is dead-lettered
 * on the first attempt rather than consuming the retry budget.
 */
export function isPermanent(err: unknown): { permanent: boolean; reason: string } {
  const e = err as { name?: string; code?: string; message?: string };
  const msg = e?.message ?? String(err);
  if (e?.name === 'ZodError' || msg.includes('unrecognized key') || msg.includes('Invalid input')) {
    return { permanent: true, reason: 'invalid-payload' };
  }
  if (msg.includes('missing required field') || msg.includes('payload-missing-field')) {
    return { permanent: true, reason: 'invalid-payload' };
  }
  // Serialization/deadlock failures are *explicitly* retryable even though they
  // look like database errors: they are the signature of two writers on the same
  // row, and backing off is the entire remedy.
  if (e?.code === '40001' || e?.code === '40P01') {
    return { permanent: false, reason: 'contention' };
  }
  if (e?.code === '57P01' || e?.code === '57P02' || e?.code === '57P03') {
    return { permanent: false, reason: 'postgres-restart' };
  }
  return { permanent: false, reason: 'handler-error' };
}

function fingerprint(payload: Record<string, unknown>): string {
  // Key order is normalised so a re-serialised copy of the same logical payload
  // (jsonb round-trips lose insertion order) still fingerprints identically.
  const norm = Object.keys(payload)
    .sort()
    .map((k) => `${k}=${stable(String(payload[k]))}`)
    .join(';');
  return createHash('sha256').update(norm).digest('hex').slice(0, 32);
}

function stable(v: string): string {
  return v.length > 512 ? `${v.slice(0, 512)}#${v.length}` : v;
}

export async function dispatch(deps: DispatchDeps, env: JobEnvelope): Promise<DispatchResult> {
  const startedAt = performance.now();
  const queue = queueOf(env.topic);
  const hash = fingerprint(env.payload);
  const claimKey = `job:${env.topic}:${env.idempotencyKey}`.slice(0, 128);

  const claimed = await claim(deps, env.tenantId, claimKey, hash);
  if (claimed === 'replay') {
    deps.metrics.jobResults.inc({ queue, job: env.topic, outcome: 'skipped' });
    return { kind: 'skipped', reason: 'already-handled' };
  }
  if (claimed === 'conflict') {
    // Same key, different bytes: the producer changed what it sends under an
    // identity that is supposed to be stable. Never guess — park it for a human.
    deps.metrics.jobResults.inc({ queue, job: env.topic, outcome: 'failed' });
    deps.metrics.deadLetters.inc({ queue, reason: 'idempotency-conflict' });
    return {
      kind: 'dead',
      reason: 'idempotency-conflict',
      error: 'same idempotency key, different payload',
    };
  }
  if (claimed === 'busy') {
    // Another pod (or the previous, not-yet-expired attempt) holds it.
    deps.metrics.jobResults.inc({ queue, job: env.topic, outcome: 'retry' });
    return {
      kind: 'retry',
      afterMs: backoffMs(Math.max(1, env.attempts)),
      error: 'in-flight-elsewhere',
    };
  }

  try {
    const detail = await runHandler(deps, env);
    // Handlers may return a *signal* instead of a result: `skipped` (work was
    // genuinely unnecessary — already completed, cancelled) or `retry` (a
    // transient condition the transport should re-schedule, e.g. the report
    // row losing the race against the enqueue COMMIT). Classifying these as
    // plain 'completed' once made a real bug invisible: the report handler's
    // "row not visible yet" path incremented `completed`, settled the
    // idempotency claim, and the job was never run — all metrics green.
    const signal = asSignal(detail);
    if (signal?.kind === 'retry') {
      // Release the claim so the redelivery can take it, then let the
      // transport own the schedule (BullMQ backoff / outbox next_attempt_at).
      await release(deps, env.tenantId, claimKey);
      deps.metrics.jobResults.inc({ queue, job: env.topic, outcome: 'retry' });
      return {
        kind: 'retry',
        afterMs: backoffMs(Math.max(1, env.attempts)),
        error: signal.reason,
      };
    }
    if (signal?.kind === 'skipped') {
      await settle(deps, env.tenantId, claimKey, 200, detail);
      deps.metrics.jobResults.inc({ queue, job: env.topic, outcome: 'skipped' });
      return { kind: 'skipped', reason: signal.reason };
    }
    await settle(deps, env.tenantId, claimKey, 200, detail);
    deps.metrics.jobResults.inc({ queue, job: env.topic, outcome: 'completed' });
    const seconds = (performance.now() - startedAt) / 1000;
    deps.metrics.jobDuration.observe({ queue, job: env.topic }, seconds);
    if (seconds > 30) {
      deps.metrics.slowJobs.inc({ job: env.topic });
      deps.log.warn(
        { topic: env.topic, tenantId: env.tenantId, seconds: seconds.toFixed(1) },
        'slow job',
      );
    }
    return { kind: 'completed', detail };
  } catch (err) {
    const seconds = (performance.now() - startedAt) / 1000;
    deps.metrics.jobDuration.observe({ queue, job: env.topic }, seconds);
    const { permanent, reason } = isPermanent(err);
    const message = err instanceof Error ? err.message : String(err);
    const attemptsLeft = env.maxAttempts - env.attempts;

    if (permanent || attemptsLeft <= 0) {
      await settle(deps, env.tenantId, claimKey, 500, { error: message, reason });
      deps.metrics.jobResults.inc({ queue, job: env.topic, outcome: 'failed' });
      deps.metrics.deadLetters.inc({ queue, reason: permanent ? reason : 'exhausted-retries' });
      await audit(deps, env, permanent ? 'job.discarded' : 'job.failed', {
        reason,
        error: message,
        attempts: env.attempts,
      });
      deps.log.error(
        { topic: env.topic, tenantId: env.tenantId, reason, attempts: env.attempts, err: message },
        'job dead-lettered',
      );
      return { kind: 'dead', reason: permanent ? reason : 'exhausted-retries', error: message };
    }

    // Release so the next attempt can claim it, then let the transport schedule.
    await release(deps, env.tenantId, claimKey);
    deps.metrics.jobResults.inc({ queue, job: env.topic, outcome: 'retry' });
    deps.log.warn(
      { topic: env.topic, tenantId: env.tenantId, attempt: env.attempts, err: message },
      'job attempt failed',
    );
    return { kind: 'retry', afterMs: backoffMs(env.attempts + 1), error: message };
  }
}

export function queueOf(topic: JobName): string {
  switch (topic) {
    case JOBS.reportGenerate:
      return QUEUES.reports;
    case JOBS.emailWelcome:
    case JOBS.emailMemberInvite:
      return QUEUES.email;
    default: {
      const exhaustive: never = topic;
      throw new Error(`no queue for job ${String(exhaustive)}`);
    }
  }
}

/**
 * Narrow a handler's return value to a `skipped`/`retry` signal, or null for a
 * normal result. Structural on purpose: handlers keep returning plain data
 * objects (email sends return `{messageId, transport}`), and only the explicit
 * `kind` field opts into signalling — an email result that happens to grow a
 * `kind: 'skipped'` field would be a code-review smell, not a silent semantic
 * change.
 */
function asSignal(detail: unknown): { kind: 'skipped' | 'retry'; reason: string } | null {
  if (typeof detail !== 'object' || detail === null) {
    return null;
  }
  const d = detail as { kind?: unknown; reason?: unknown };
  if ((d.kind === 'skipped' || d.kind === 'retry') && typeof d.reason === 'string') {
    return { kind: d.kind, reason: d.reason };
  }
  return null;
}

async function runHandler(deps: DispatchDeps, env: JobEnvelope): Promise<unknown> {
  switch (env.topic) {
    case JOBS.reportGenerate: {
      const p = reportPayload.parse(env.payload);
      return runReport(
        {
          db: deps.db,
          log: deps.log,
          maxRows: deps.report.maxRows,
          workMultiplier: deps.report.workMultiplier,
          inlineMaxBytes: deps.report.inlineMaxBytes,
        },
        { tenantId: p.tenantId, jobId: p.jobId, requestedBy: p.requestedBy },
      );
    }
    case JOBS.emailWelcome: {
      const p = emailWelcomePayload.parse(env.payload);
      const tenant = await tenantName(deps.db, p.tenantId);
      const { messageId } = await deps.mail.send({
        to: p.email,
        subject: 'Your workspace is ready',
        text: welcomeText({ tenantName: tenant, displayName: p.displayName }),
      });
      await audit(deps, env, 'email.welcome_sent', {
        to: p.email,
        messageId,
        transport: deps.mail.kind,
      });
      return { messageId, transport: deps.mail.kind };
    }
    case JOBS.emailMemberInvite: {
      const p = emailInvitePayload.parse(env.payload);
      const tenant = await tenantName(deps.db, p.tenantId);
      const { messageId } = await deps.mail.send({
        to: p.invitedEmail,
        subject: `Join ${tenant}`,
        text: inviteText({
          tenantName: tenant,
          invitedBy: null,
          acceptUrl: `${deps.acceptBaseUrl}/accept?token=${p.inviteToken}`,
          role: 'member',
        }),
      });
      await audit(deps, env, 'email.invite_sent', {
        to: p.invitedEmail,
        messageId,
        transport: deps.mail.kind,
      });
      return { messageId, transport: deps.mail.kind };
    }
    default: {
      const exhaustive: never = env.topic;
      throw new Error(`unknown job topic ${String(exhaustive)}`);
    }
  }
}

async function tenantName(db: Database, tenantId: string): Promise<string> {
  // `app.tenant_by_id` is SECURITY DEFINER: the tenant row itself is not
  // selectable by app_user without a membership, and a worker has none.
  const res = await db
    .query<{ name: string }>('SELECT name FROM app.tenant_by_id($1)', [tenantId])
    .catch(() => null);
  return res?.rows[0]?.name ?? tenantId.slice(0, 8);
}

/** `true` claimed · `'replay'` already done · `'conflict'` key reuse · `'busy'` in flight. */
async function claim(
  deps: DispatchDeps,
  tenantId: string,
  key: string,
  hash: string,
): Promise<true | 'replay' | 'conflict' | 'busy'> {
  try {
    const looked = await deps.db.query<{ state: string; response_status: number | null }>(
      'SELECT state, response_status FROM app.idempotency_lookup($1,$2,$3)',
      [tenantId, key, hash],
    );
    const state = looked.rows[0]?.state;
    if (state === 'replay' || state === 'conflict' || state === 'inflight') {
      return state === 'replay' ? 'replay' : state === 'conflict' ? 'conflict' : 'busy';
    }
    const reserved = await deps.db.query<{ ok: boolean }>(
      'SELECT app.idempotency_reserve($1,$2,$3,$4) AS ok',
      [tenantId, key, hash, deps.claimTtlSeconds],
    );
    return reserved.rows[0]?.ok === true ? true : 'busy';
  } catch (err) {
    // A claim failure must not become a *delivery* failure: if the idempotency
    // table is unreachable we would otherwise stop the queue entirely. The
    // handlers are individually guarded (report_jobs state machine, transactional
    // writes), so degrading to at-least-once with a loud log is the safer branch.
    deps.log.error(
      { err: String(err) },
      'job claim unavailable; continuing without exactly-once guard',
    );
    deps.metrics.errors.inc({ where: 'claim' });
    return true;
  }
}

async function settle(
  deps: DispatchDeps,
  tenantId: string,
  key: string,
  status: number,
  detail: unknown,
): Promise<void> {
  try {
    await deps.db.query('SELECT app.idempotency_complete($1,$2,$3,$4::jsonb)', [
      tenantId,
      key,
      status,
      JSON.stringify(detail ?? null),
    ]);
  } catch (err) {
    deps.log.debug({ err: String(err) }, 'idempotency complete failed');
  }
}

async function release(deps: DispatchDeps, tenantId: string, key: string): Promise<void> {
  try {
    await deps.db.query('SELECT app.idempotency_release($1,$2)', [tenantId, key]);
  } catch (err) {
    deps.log.debug({ err: String(err) }, 'idempotency release failed');
  }
}

async function audit(
  deps: DispatchDeps,
  env: JobEnvelope,
  action: string,
  detail: object,
): Promise<void> {
  try {
    await deps.db.withTenant(
      { tenantId: env.tenantId, requestId: `job:${env.idempotencyKey.slice(0, 32)}` },
      (tx) =>
        tx.query('SELECT app.audit($1,$2,$3,$4::jsonb)', [
          action,
          'job',
          env.topic,
          JSON.stringify(detail),
        ]),
    );
  } catch (err) {
    deps.log.debug({ err: String(err) }, 'job audit write failed');
  }
}
