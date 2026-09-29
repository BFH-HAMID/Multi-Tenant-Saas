import pg from 'pg';

const { Pool } = pg;
export type { PoolClient, QueryResult, PoolConfig } from 'pg';

/** Anything pino-shaped; the API passes `app.log`, tests pass a recorder. */
export interface MinimalLogger {
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
  debug(obj: object, msg?: string): void;
}

export interface DatabaseOptions {
  connectionString: string;
  /** Hard ceiling on a single request's hold on a connection. */
  statementTimeoutMs?: number;
  idleInTransactionSessionTimeoutMs?: number;
  maxConnections?: number;
  minConnections?: number;
  log?: MinimalLogger;
  /** Slow-query log + metric hook. */
  onQuery?: (info: QueryObservation) => void;
  slowQueryMs?: number;
  applicationName?: string;
  ssl?: boolean | 'no-verify' | Record<string, unknown>;
}

/** What every request-scoped transaction pins into Postgres GUCs. */
export interface TenantContext {
  tenantId?: string | null;
  userId?: string | null;
  role?: string | null;
  requestId?: string | null;
  /** `SET TRANSACTION READ ONLY` — rejects accidental writes on hot paths. */
  readOnly?: boolean;
}

/**
 * Post-commit side effects of a tenant transaction.
 *
 * Exists for one specific bug class: the transactional outbox's "fast path".
 * Publishing to a queue from *inside* the business transaction is a dual-write
 * in disguise — the broker makes the job visible before the database makes the
 * row visible, a consumer reads a not-yet-committed row, sees nothing, and
 * (if the consumer treats "no row" as success) the job is silently lost. The
 * only correct moment to notify the outside world is *after* COMMIT returns,
 * which is exactly what `afterCommit` guarantees: callbacks run only if the
 * transaction committed, never on rollback, and never inside the transaction.
 */
export interface TransactionScope {
  /** Register work to run after this transaction commits. Best-effort. */
  afterCommit(fn: () => unknown): void;
}

/** What one instrumented statement/transaction looked like, from the outside. */
export interface QueryObservation {
  ms: number;
  /** The SQL text for a statement, or the literal 'transaction' for a unit of work. */
  sql: string;
  kind: QueryKind;
  tenantId?: string;
}

export type QueryKind = 'query' | 'transaction';

export interface Database {
  readonly pool: pg.Pool;
  /**
   * Replace the per-statement observer, or pass undefined to detach.
   *
   * A seam, not a feature: the pool has to exist before the Fastify instance can
   * finish booting (readiness probes it), while the Prometheus registry it reports to
   * is built a few lines later. Without this the only options are a metric that is
   * registered but never observed — which is what this used to be — or a boot order
   * dependency between two plugins that have nothing to do with each other.
   */
  setQueryObserver?(observer?: (info: QueryObservation) => void): void;
  query<T extends pg.QueryResultRow = pg.QueryResultRow>(
    text: string,
    params?: readonly unknown[],
  ): Promise<pg.QueryResult<T>>;
  withTenant<T>(
    ctx: TenantContext,
    fn: (tx: pg.PoolClient, scope: TransactionScope) => Promise<T>,
  ): Promise<T>;
  withClient<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T>;
  healthcheck(): Promise<{ ok: boolean; latencyMs: number; error?: string }>;
  stats(): { total: number; idle: number; waiting: number };
  close(): Promise<void>;
}

const GUC_MAP: Array<[keyof TenantContext, string]> = [
  ['tenantId', 'app.tenant_id'],
  ['userId', 'app.user_id'],
  ['role', 'app.tenant_role'],
  ['requestId', 'app.request_id'],
];

/**
 * Postgres access layer.
 *
 * Why `set_config(..., true)` and not `SET LOCAL app.tenant_id = '...'`:
 *  1. `SET` does not accept bind parameters, so string concatenation would be
 *     the only way — unacceptable for a value derived from a request header;
 *  2. `set_config` with `is_local = true` is scoped to the transaction, so a
 *     pooled connection can never leak tenant A's context into tenant B's query
 *     (the classic "SET without LOCAL" incident in pooled/transaction mode).
 */
export function createDatabase(opts: DatabaseOptions): Database {
  const pool = new Pool({
    connectionString: opts.connectionString,
    max: opts.maxConnections ?? 10,
    min: opts.minConnections ?? 2,
    allowExitOnIdle: false,
    application_name: opts.applicationName ?? 'saas-api',
    // Server-side timeouts go through `options` (a startup parameter string) so
    // they are enforced *inside* Postgres — the only variant that also works
    // behind PgBouncer in transaction mode. An idle-in-transaction session is
    // the classic way to wedge a pooled pool, hence the explicit guard.
    statement_timeout: opts.statementTimeoutMs ?? 5_000,
    query_timeout: 15_000,
    options: [
      `-c statement_timeout=${opts.statementTimeoutMs ?? 5_000}`,
      `-c idle_in_transaction_session_timeout=${opts.idleInTransactionSessionTimeoutMs ?? 10_000}`,
      `-c lock_timeout=3000`,
      `-c application_name=${opts.applicationName ?? 'saas-api'}`,
    ].join(' '),
    connectionTimeoutMillis: 5_000,
    ssl:
      opts.ssl === undefined
        ? /sslmode=(require|verify-full|no-verify)/.test(opts.connectionString)
          ? { rejectUnauthorized: false }
          : undefined
        : opts.ssl === 'no-verify'
          ? { rejectUnauthorized: false }
          : opts.ssl === true
            ? { rejectUnauthorized: true }
            : opts.ssl,
    // `pg` reuses prepared statements per connection past 5 queries; for a
    // workload with ~10 hot queries this is a win.
    ...(typeof process.env.PG_POOL_MAX === 'string'
      ? { max: Number(process.env.PG_POOL_MAX) || undefined }
      : {}),
  });

  pool.on('error', (err) => {
    // An idle client erroring must not kill the process; log and let the pool
    // replace it.
    opts.log?.error({ err, code: (err as Error & { code?: string }).code }, 'pg idle client error');
  });

  const slowMs = opts.slowQueryMs ?? 250;

  let observer = opts.onQuery;

  const instrument = async <T>(
    run: () => Promise<T>,
    sql: string,
    ctx?: TenantContext,
    kind: QueryKind = 'query',
  ): Promise<T> => {
    const started = performance.now();
    try {
      return await run();
    } finally {
      const ms = performance.now() - started;
      if (ms >= slowMs) {
        opts.log?.warn(
          { sql: sql.slice(0, 200), ms: Number(ms.toFixed(1)), tenant: ctx?.tenantId },
          'slow query',
        );
      }
      // `observer` is read per call, not captured, so `setQueryObserver` can attach
      // after boot. Nothing here may throw into the caller: metrics are not allowed to
      // turn a successful query into a 500.
      try {
        observer?.({ ms, sql, kind, tenantId: ctx?.tenantId ?? undefined });
      } catch {
        /* instrumented, never fatal */
      }
    }
  };

  const db: Database = {
    pool,

    setQueryObserver(next?: (info: QueryObservation) => void): void {
      observer = next;
    },

    query<T extends pg.QueryResultRow = pg.QueryResultRow>(
      text: string,
      params?: readonly unknown[],
    ) {
      return instrument(() => pool.query<T>(text, params as unknown[] | undefined), text);
    },

    async withClient<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
      const client = await pool.connect();
      try {
        return await fn(client);
      } finally {
        client.release();
      }
    },

    async withTenant<T>(
      ctx: TenantContext,
      fn: (tx: pg.PoolClient, scope: TransactionScope) => Promise<T>,
    ): Promise<T> {
      const client = await pool.connect();
      // Filled by `scope.afterCommit`; emptied by running them. If the
      // transaction rolls back, `committed` stays false and they never run —
      // that is the entire contract.
      const hooks: Array<() => unknown> = [];
      const scope: TransactionScope = {
        afterCommit(fn2) {
          hooks.push(fn2);
        },
      };
      let committed = false;
      try {
        await client.query('BEGIN');
        if (ctx.readOnly) {
          await client.query('SET TRANSACTION READ ONLY');
        }
        for (const [key, guc] of GUC_MAP) {
          const value = ctx[key];
          // Always call set_config — even with NULL — so a previous value from
          // this pooled connection cannot survive into the next request.
          await client.query('SELECT set_config($1, $2, true)', [guc, value ?? null]);
        }
        const result = await instrument(() => fn(client, scope), 'transaction', ctx, 'transaction');
        await client.query('COMMIT');
        committed = true;
        return result;
      } catch (err) {
        try {
          await client.query('ROLLBACK');
        } catch {
          /* connection already broken; release() will discard it */
        }
        throw err;
      } finally {
        client.release();
        if (committed) {
          // Post-commit side effects run on the (now released) pool, outside
          // the transaction. A hook failure must never turn a committed
          // transaction into an error for the caller: the durable outbox row
          // is already committed, so the relay is the safety net for any
          // hook that fails.
          for (const hook of hooks) {
            try {
              await hook();
            } catch (err) {
              opts.log?.warn({ err: String(err) }, 'afterCommit hook failed');
            }
          }
        }
      }
    },

    async healthcheck() {
      const started = performance.now();
      try {
        await pool.query('SELECT 1');
        return { ok: true, latencyMs: Math.round(performance.now() - started) };
      } catch (err) {
        return {
          ok: false,
          latencyMs: Math.round(performance.now() - started),
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },

    stats() {
      return { total: pool.totalCount, idle: pool.idleCount, waiting: pool.waitingCount };
    },

    close() {
      return pool.end();
    },
  };

  return db;
}

/** Translate the two Postgres errors the API must never show as a 500. */
export function mapPgError(
  err: unknown,
): { statusCode: number; code: string; message: string } | null {
  const e = err as Error & { code?: string; constraint?: string };
  switch (e.code) {
    case '23505':
      return { statusCode: 409, code: 'CONFLICT', message: 'Resource already exists' };
    case '23514':
      return { statusCode: 402, code: 'QUOTA_EXCEEDED', message: e.message };
    case '42501':
      return {
        statusCode: 403,
        code: 'TENANT_MEMBERSHIP_REQUIRED',
        message: 'Missing tenant context',
      };
    case '40001':
      return { statusCode: 409, code: 'CONFLICT', message: 'Concurrent modification, retry' };
    case '57014': // query_canceled → statement_timeout
      return { statusCode: 504, code: 'TIMEOUT', message: 'Query exceeded the statement timeout' };
    case '53300': // too_many_connections
    case '57P03': // cannot_connect_now
    case '08000':
    case '08003':
    case '08006':
      return {
        statusCode: 503,
        code: 'DB_UNAVAILABLE',
        message: 'Database is busy or unreachable',
      };
    default:
      // No message sniffing: every error the API must translate is tagged with
      // an SQLSTATE by the trigger/function that raises it (0004, 0005).
      return null;
  }
}
