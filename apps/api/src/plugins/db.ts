import type { FastifyInstance } from 'fastify';
import { createDatabase, type Database } from '@saas/db';
import type { AppConfig } from '../config/index.js';

/**
 * One `pg.Pool` per process, decorated onto the instance.
 *
 * Pool size is the product of `replicas × PG_POOL_MAX` and must stay under the
 * Postgres `max_connections` budget (or the PgBouncer pool) — that arithmetic is
 * written down in docs/ARCHITECTURE.md because getting it wrong is the most
 * common way to take down a shared-DB multi-tenant service.
 */
export async function registerDb(
  app: FastifyInstance,
  cfg: AppConfig,
  /** Test seam: a pool opened by the caller (apps/api/tests/helpers/app.ts). */
  override?: Database,
): Promise<Database> {
  if (override) {
    app.decorate('db', override);
    const early = await override.healthcheck();
    if (!early.ok) {
      throw new Error(`database unreachable at boot: ${early.error}`);
    }
    // No onClose hook: an injected pool is the caller's to close. Registering one
    // made `app.close()` and the test harness both call `pool.end()`, and the
    // second one throws `Called end on pool more than once` out of an afterAll.
    return override;
  }
  const db = createDatabase({
    connectionString: cfg.env.DATABASE_URL,
    maxConnections: cfg.env.PG_POOL_MAX,
    minConnections: cfg.env.PG_POOL_MIN,
    statementTimeoutMs: cfg.env.PG_STATEMENT_TIMEOUT_MS,
    slowQueryMs: cfg.env.PG_SLOW_QUERY_MS,
    log: app.log,
    applicationName: `${cfg.env.SERVICE_NAME}@${cfg.env.BUILD_SHA}`,
  });

  app.decorate('db', db);
  app.addHook('onClose', async () => {
    await db.close();
  });

  // Fail fast on boot rather than serving 503s after the first request.
  const health = await db.healthcheck();
  if (!health.ok) {
    throw new Error(`database unreachable at boot: ${health.error}`);
  }
  app.log.info({ latencyMs: health.latencyMs, pool: db.stats() }, 'database connected');
  return db;
}
