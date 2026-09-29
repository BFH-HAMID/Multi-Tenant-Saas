import { pathToFileURL } from 'node:url';
import { createDatabase, type MinimalLogger } from '@saas/db';
import { createLogger, QUEUES } from '@saas/shared';
import { createBroker, type Broker } from './broker.js';
import { startCollectors } from './collectors.js';
import { loadConfig, type WorkerConfig } from './config.js';
import { createMailTransport, type MailTransport } from './handlers/email.js';
import { createInternalServer } from './internal.js';
import { dispatch, type DispatchResult, type JobEnvelope } from './jobs.js';
import { createMetrics } from './metrics.js';
import { createRelay, type Relay } from './relay.js';

/**
 * Worker composition root.
 *
 * Everything that decides *behaviour* lives in the modules this wires together;
 * this file only decides order and shutdown, because the interesting failure of a
 * queue consumer is a shutdown problem:
 *
 *   - SIGTERM must stop *fetching* first (BullMQ `close()` does exactly that),
 *     then let in-flight jobs finish inside the grace budget, then release
 *     resources. Closing the Redis connection before the handler finishes turns a
 *     clean rollout into thousands of stalled jobs waiting for their lock to
 *     expire — which is the single most common cause of "the deploy made the queue
 *     back up for ten minutes".
 *   - `terminationGracePeriodSeconds` in k8s must exceed SHUTDOWN_GRACE_MS, so
 *     the kernel's SIGKILL is never what ends a job. `infra/kustomize/base/
 *     deployment-worker.yaml` sets them to agree.
 *   - Anything still running when the grace expires is *not* cancelled: the lease
 *     simply lapses and another pod re-claims it. That is why the handlers are
 *     idempotent, and why a hard exit is acceptable here but never in the API.
 */
export interface RunningWorker {
  close(reason: string): Promise<void>;
  readonly cfg: WorkerConfig;
  readonly relay: Relay;
  readonly broker: Broker | null;
  readonly metrics: ReturnType<typeof createMetrics>;
}

export async function startWorker(
  input: { env?: NodeJS.ProcessEnv; listen?: boolean } = {},
): Promise<RunningWorker> {
  const cfg = loadConfig(input.env ?? process.env);
  const log = createLogger({
    level: cfg.env.LOG_LEVEL,
    pretty: cfg.env.LOG_PRETTY,
    base: { service: 'worker', version: cfg.env.BUILD_VERSION, env: cfg.env.NODE_ENV },
    redact: ['*.password', '*.inviteToken', '*.connectionString', 'url', '*.url'],
  });

  const metrics = createMetrics({
    version: cfg.env.BUILD_VERSION,
    sha: cfg.env.BUILD_SHA,
    env: cfg.env.NODE_ENV,
    driver: cfg.env.QUEUE_DRIVER,
    nodeEnv: cfg.env.NODE_ENV,
  });

  const db = createDatabase({
    connectionString: cfg.env.DATABASE_URL,
    maxConnections: cfg.env.PG_POOL_MAX,
    minConnections: cfg.env.PG_POOL_MIN,
    statementTimeoutMs: cfg.env.PG_STATEMENT_TIMEOUT_MS,
    slowQueryMs: cfg.env.PG_SLOW_QUERY_MS,
    applicationName: 'saas-worker',
    log: log as unknown as MinimalLogger,
    onQuery: ({ ms, kind }) => {
      metrics.dbQueryDuration.observe(ms / 1000);
      if (ms >= cfg.env.PG_SLOW_QUERY_MS) {
        metrics.dbSlowQueries.inc({ kind });
      }
    },
  });

  const mail: MailTransport = await createMailTransport({
    cfg: { smtpUrl: cfg.env.SMTP_URL, from: cfg.env.SMTP_FROM, timeoutMs: cfg.env.SMTP_TIMEOUT_MS },
    log,
    db,
    counter: {
      inc: (labels) => metrics.emailsSent.inc(labels),
    },
  });

  const runDispatch = (env: JobEnvelope): Promise<DispatchResult> =>
    dispatch(
      {
        db,
        log,
        metrics,
        mail,
        report: {
          maxRows: cfg.env.REPORT_MAX_ROWS,
          workMultiplier: cfg.env.REPORT_WORK_MULTIPLIER,
          inlineMaxBytes: cfg.env.REPORT_INLINE_MAX_BYTES,
        },
        claimTtlSeconds: cfg.env.JOB_CLAIM_TTL_SECONDS,
        acceptBaseUrl: cfg.env.ACCEPT_BASE_URL,
      },
      env,
    );

  const broker: Broker | null = cfg.bullmqEnabled
    ? createBroker({
        url: cfg.env.REDIS_QUEUE_URL,
        prefix: cfg.env.QUEUE_NAME_PREFIX,
        // BullMQ's Redis `keyPrefix` option would double-prefix every key (the
        // queue namespace already goes in as BullMQ's `prefix`), which is how a
        // queue silently stops being the one the API produces into.
        keyPrefix: undefined,
        log,
        metrics,
        db,
        dispatch: runDispatch,
        concurrency: cfg.env.CONCURRENCY,
      })
    : null;
  await broker?.start();

  const relay = createRelay({
    db,
    log,
    metrics,
    dispatch: runDispatch,
    concurrency: cfg.env.CONCURRENCY,
    intervalMs: cfg.env.RELAY_INTERVAL_MS,
    batchSize: cfg.env.RELAY_BATCH_SIZE,
    leaseSeconds: cfg.env.LEASE_SECONDS,
    onDead: async (env, result) => {
      if (broker) {
        await broker.pushDeadLetter({
          queue: QUEUES.deadLetter,
          job: env.topic,
          tenantId: env.tenantId,
          idempotencyKey: env.idempotencyKey,
          error: result.error,
          reason: result.reason,
        });
        return;
      }
      // Outbox mode: the `discarded` row *is* the dead-letter record, and
      // `app.outbox_mark_failed` has already written the reason into `last_error`.
      log.error(
        { topic: env.topic, tenantId: env.tenantId, reason: result.reason },
        'job discarded (see outbox.last_error)',
      );
    },
  });
  relay.start();

  const collectors = startCollectors({
    db,
    metrics,
    broker,
    log,
    intervalMs: 10_000,
  });

  let internal: ReturnType<typeof createInternalServer> | null = null;
  if (input.listen !== false) {
    internal = createInternalServer({
      metrics,
      db,
      relay,
      broker,
      version: cfg.env.BUILD_VERSION,
      readinessStaleMs: cfg.env.READINESS_STALE_MS,
      log,
      onProbe: () => collectors.probe(),
    });
    await internal.listen(cfg.env.METRICS_PORT, cfg.env.HOST);
    log.info({ port: cfg.env.METRICS_PORT, host: cfg.env.HOST }, 'worker internal listener up');
  }

  log.info(
    {
      pid: process.pid,
      node: process.version,
      ...cfg.describe(),
      pgPool: db.stats(),
      mailTransport: mail.kind,
    },
    'worker started',
  );

  let closing = false;
  const close = async (reason: string): Promise<void> => {
    if (closing) {
      return;
    }
    closing = true;
    const t0 = Date.now();
    log.info({ reason, graceMs: cfg.env.SHUTDOWN_GRACE_MS }, 'worker shutting down');

    // 1. stop taking new work: relay loop first (it is the one that would keep
    //    claiming while we are trying to drain), then the broker.
    await relay.stop();
    // 2. let the collectors publish a final depth snapshot before we tear down.
    collectors.stop();
    // 3. close transports.
    await broker
      ?.close()
      .catch((err: unknown) => log.warn({ err: String(err) }, 'broker close failed'));
    await mail.close().catch(() => undefined);
    await internal?.close();
    await db.close().catch((err: unknown) => log.warn({ err: String(err) }, 'db close failed'));
    log.info({ ms: Date.now() - t0, ...relay.stats() }, 'worker stopped');
  };

  return { close, cfg, relay, broker, metrics };
}

/** Executable entry point. */
async function main(): Promise<void> {
  const worker = await startWorker();
  const die = (signal: string) => {
    void worker.close(signal).then(() => process.exit(0));
  };
  process.on('SIGTERM', () => die('SIGTERM'));
  process.on('SIGINT', () => die('SIGINT'));
  process.on('unhandledRejection', (reason) => {
    // Logged, not fatal: an unhandled rejection in a *timer* (a metric update,
    // say) must not kill a pod that is mid-job. Genuine handler failures are
    // caught by dispatch() and follow the retry policy instead.
    worker.metrics.errors.inc({ where: 'unhandledRejection' });
    worker.cfg.env.NODE_ENV === 'test'
      ? process.stderr.write(`unhandledRejection: ${String(reason)}\n`)
      : console.error('[worker] unhandledRejection', reason);
  });
  process.on('uncaughtException', (err) => {
    // Fatal on purpose: after an uncaught exception any in-flight job's locks and
    // pool state are unknown, and the only honest move is to exit and let the
    // lease/reclaim machinery re-run the work elsewhere.
    worker.metrics.errors.inc({ where: 'uncaughtException' });

    console.error('[worker] uncaughtException', err);
    process.exit(1);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main();
}
