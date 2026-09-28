import { z } from 'zod';
import { generateReportSchema } from './schemas/project.js';

/**
 * Queue contracts, shared by the API (producer) and the worker (consumer).
 *
 * BullMQ guarantees *at-least-once* delivery: a job whose worker dies mid-flight
 * is retried. Everything in this file therefore assumes the handler may run
 * twice, and `idempotencyKey` is what makes that harmless. See
 * docs/adr/0002-bullmq.md and docs/adr/0005-outbox-and-idempotency.md.
 */

export const QUEUES = {
  email: 'email',
  reports: 'reports',
  /** Jobs that exhausted their retries land here for manual/automated replay. */
  deadLetter: 'dead-letter',
} as const;

export type QueueName = (typeof QUEUES)[keyof typeof QUEUES];

export const JOBS = {
  emailWelcome: 'email.welcome',
  emailMemberInvite: 'email.member-invite',
  reportGenerate: 'report.generate',
} as const;

export type JobName = (typeof JOBS)[keyof typeof JOBS];

/** Per-queue BullMQ defaults; the worker and the API must agree exactly. */
export const QUEUE_DEFAULTS = {
  attempts: 3,
  backoff: { type: 'exponential' as const, delay: 500 },
  removeOnComplete: { age: 3600, count: 1000 },
  removeOnFail: { age: 24 * 3600 },
  /** How long a job may run before the stalled-job checker re-queues it. */
  lockDuration: 30_000,
  maxStalledCount: 2,
} as const;

export const emailWelcomePayload = z.object({
  kind: z.literal(JOBS.emailWelcome),
  tenantId: z.string().uuid(),
  tenantSlug: z.string(),
  userId: z.string().uuid(),
  email: z.string(),
  displayName: z.string().nullable(),
  /** Set on retries so a consumer can dedupe: `tenant:user:welcomed`. */
  idempotencyKey: z.string().min(8).max(128),
  requestedAt: z.string(),
});
export type EmailWelcomePayload = z.infer<typeof emailWelcomePayload>;

export const emailInvitePayload = z.object({
  kind: z.literal(JOBS.emailMemberInvite),
  tenantId: z.string().uuid(),
  tenantSlug: z.string(),
  invitedEmail: z.string(),
  inviteToken: z.string(),
  invitedBy: z.string(),
  idempotencyKey: z.string().min(8).max(128),
  requestedAt: z.string(),
});
export type EmailInvitePayload = z.infer<typeof emailInvitePayload>;

export const reportPayload = z.object({
  kind: z.literal(JOBS.reportGenerate),
  tenantId: z.string().uuid(),
  // Nullable because `report_jobs.requested_by` is `ON DELETE SET NULL`: when the
  // requester's account is deleted the job is still valid work, and a payload
  // schema that rejects NULL turns account deletion into poison messages.
  requestedBy: z.string().uuid().nullable(),
  jobId: z.string().min(8).max(128),
  idempotencyKey: z.string().min(8).max(128),
  options: generateReportSchema.omit({ idempotencyKey: true }),
  requestedAt: z.string(),
});
export type ReportPayload = z.infer<typeof reportPayload>;

export type JobPayload = EmailWelcomePayload | EmailInvitePayload | ReportPayload;

/** The outbox envelope that turns "DB write + queue job" into one atomic step. */
export const OUTBOX_TOPICS = {
  [JOBS.emailWelcome]: QUEUES.email,
  [JOBS.emailMemberInvite]: QUEUES.email,
  [JOBS.reportGenerate]: QUEUES.reports,
} as const satisfies Record<JobName, QueueName>;

export const OUTBOX_STATUSES = ['pending', 'published', 'failed', 'discarded'] as const;
export type OutboxStatus = (typeof OUTBOX_STATUSES)[number];

export const outboxEnvelopeSchema = z.object({
  id: z.string(),
  tenantId: z.string().uuid(),
  topic: z.enum(Object.keys(OUTBOX_TOPICS) as [JobName, ...JobName[]]),
  payload: z.record(z.string(), z.unknown()),
  headers: z.record(z.string(), z.unknown()).default({}),
  attempts: z.number().int().default(0),
  status: z.enum(OUTBOX_STATUSES),
});
export type OutboxEnvelope = z.infer<typeof outboxEnvelopeSchema>;

export function queueForJob(job: JobName): QueueName {
  return OUTBOX_TOPICS[job];
}

export function parsePayload(job: JobName, data: unknown): JobPayload {
  switch (job) {
    case JOBS.emailWelcome:
      return emailWelcomePayload.parse(data);
    case JOBS.emailMemberInvite:
      return emailInvitePayload.parse(data);
    case JOBS.reportGenerate:
      return reportPayload.parse(data);
    default: {
      const exhaustive: never = job;
      throw new Error(`no payload schema for job ${String(exhaustive)}`);
    }
  }
}
