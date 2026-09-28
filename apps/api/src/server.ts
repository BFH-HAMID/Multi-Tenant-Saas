import { buildApp } from './app.js';
import { loadConfig } from './config/index.js';

/**
 * Process entry point: build, listen, and shut down *in the order Kubernetes
 * needs*.
 *
 * On SIGTERM we (1) stop being ready, (2) wait a beat, then (3) close the
 * listener and (4) drain. Step (1)+(2) is the part people skip: the pod stays in
 * the Service endpoints for a few seconds after SIGTERM (the endpoint removal is
 * asynchronous), so without a readiness flip and a short grace, in-flight
 * requests arriving during a rollout get connection resets that a client retry
 * cannot always make harmless. `preStop: sleep 5` in the manifest and
 * `SHUTDOWN_GRACE_MS` here are the same decision seen from two sides.
 *
 * `forceCloseConnections` (set in app.ts) then bounds how long a keep-alive
 * socket can hold the drain open; `close()` returns once the queue is empty.
 */
async function main(): Promise<void> {
  const cfg = loadConfig();
  const app = await buildApp({ config: cfg });

  let closing = false;
  const shutdown = (signal: string): void => {
    if (closing) {
      return;
    }
    closing = true;
    app.log.info({ signal }, 'shutdown started');

    // 1. Ask the readiness probe to fail so the Service stops sending new pods.
    app.readinessProbe = async () => ({
      ok: false,
      checks: { shuttingDown: { ok: false, decisive: true, signal } },
    });

    // 2. Give endpoint propagation a moment (the ingress needs it too).
    setTimeout(() => {
      void app
        .close()
        .then(() => {
          app.log.info('closed cleanly');
          process.exit(0);
        })
        .catch((err: unknown) => {
          app.log.error({ err }, 'error during close');
          process.exit(1);
        });
    }, cfg.env.SHUTDOWN_GRACE_MS).unref?.();

    // Hard stop: never let a stuck handler turn a rollout into a hung pod that
    // kubelet then SIGKILLs after 30s anyway.
    setTimeout(() => {
      app.log.warn('grace period exceeded, exiting');
      process.exit(0);
    }, cfg.env.SHUTDOWN_GRACE_MS + 20_000).unref?.();
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('unhandledRejection', (reason) => {
    app.log.fatal({ err: reason }, 'unhandled promise rejection');
  });
  process.on('uncaughtException', (err) => {
    app.log.fatal({ err }, 'uncaught exception');
    process.exit(1);
  });

  try {
    await app.listen({ port: cfg.env.PORT, host: cfg.env.HOST });
    app.log.info(
      {
        port: cfg.env.PORT,
        metricsPort: cfg.env.METRICS_PORT,
        env: cfg.env.NODE_ENV,
        driver: cfg.env.QUEUE_DRIVER,
      },
      'api listening',
    );
  } catch (err) {
    app.log.fatal({ err }, 'failed to start');
    process.exit(1);
  }
}

void main();
