import type { Logger } from 'pino';
import type { Database } from '@saas/db';

/**
 * Email delivery, with a deliberate dry-run mode.
 *
 * There is no SMTP server in a sandbox, in CI, or in most local setups — and a
 * worker whose first job type fails to boot without one gets *stubbed out* by
 * the next person who touches it, which is how queue paths rot. So the transport
 * is chosen at runtime:
 *
 *   SMTP_URL set   → nodemailer (dynamically imported; it is an optional
 *                    dependency and prod images that do not send mail should not
 *                    carry it), with a hard timeout so a grey-listing relay
 *                    cannot hold a BullMQ lock;
 *   SMTP_URL unset → the message is *recorded*: written to the log, counted in
 *                    `emails_sent_total{transport="dry-run"}`, and the audit row
 *                    is still written. The rest of the pipeline (idempotency
 *                    claim, retry shape, DLQ) is exercised for real, because
 *                    that is what the tests are about.
 *
 * Idempotency: the caller already holds a claim on the job key, so a redelivered
 * welcome email does not re-enter this function. That is the only reason sending
 * twice is safe — a second `sendMail` would be a duplicate to the recipient.
 */
export interface MailTransport {
  readonly kind: 'smtp' | 'dry-run';
  send(msg: {
    to: string;
    subject: string;
    text: string;
    html?: string;
  }): Promise<{ messageId: string }>;
  close(): Promise<void>;
}

export interface MailDeps {
  cfg: { smtpUrl?: string | undefined; from: string; timeoutMs: number };
  log: Logger;
  db: Database;
  counter: { inc(labels: { transport: string; kind: string }): void };
}

export async function createMailTransport(deps: MailDeps): Promise<MailTransport> {
  const url = deps.cfg.smtpUrl;
  if (!url) {
    deps.log.warn(
      {},
      'SMTP_URL not configured — email handler runs in dry-run mode (records, does not deliver)',
    );
    return {
      kind: 'dry-run',
      async send(msg) {
        deps.log.info({ to: msg.to, subject: msg.subject }, 'email (dry-run)');
        // A deterministic id keeps replays comparable; a real relay returns its own.
        return {
          messageId: `dryrun-${Buffer.from(msg.to + msg.subject)
            .toString('base64url')
            .slice(0, 24)}`,
        };
      },
      async close() {},
    };
  }

  const nodemailer = await import('nodemailer');
  const { createTransport } = nodemailer;
  // The URL is decomposed rather than handed to nodemailer as a connection URL:
  // `createTransport(url)` ignores pool/timeout options entirely, and the
  // timeouts are the load-bearing part here — without them a dead relay turns
  // into a stalled-job storm (BullMQ's lock expires, the job is re-queued, and
  // every attempt hangs in exactly the same way).
  const relay = new URL(url);
  const port = Number(relay.port || (relay.protocol === 'smtps:' ? 465 : 587));
  const transport = createTransport({
    host: relay.hostname,
    port,
    secure: relay.protocol === 'smtps:' || port === 465,
    ...(relay.username
      ? {
          auth: {
            user: decodeURIComponent(relay.username),
            pass: decodeURIComponent(relay.password),
          },
        }
      : {}),
    pool: true,
    maxConnections: 2,
    connectionTimeout: deps.cfg.timeoutMs,
    greetingTimeout: deps.cfg.timeoutMs,
    socketTimeout: deps.cfg.timeoutMs,
  });
  return {
    kind: 'smtp',
    async send(msg) {
      const info = await transport.sendMail({ from: deps.cfg.from, ...msg });
      return { messageId: String(info.messageId) };
    },
    async close() {
      transport.close();
    },
  };
}

export const WELCOME_SUBJECT = 'Your workspace is ready';

export function welcomeText(input: { tenantName: string; displayName: string | null }): string {
  return [
    `Hi ${input.displayName ?? 'there'},`,
    '',
    `Workspace "${input.tenantName}" is set up. Invite teammates from Settings → Members.`,
    '',
    '— the SaaS team',
  ].join('\n');
}

export function inviteText(input: {
  tenantName: string;
  invitedBy: string | null;
  acceptUrl: string;
  role: string;
}): string {
  return [
    `You have been invited (${input.role}) to join "${input.tenantName}"${input.invitedBy ? ` by ${input.invitedBy}` : ''}.`,
    '',
    `Accept: ${input.acceptUrl}`,
    '',
    'This invitation expires in 7 days.',
  ].join('\n');
}
