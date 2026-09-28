import { buildApp, type BuildOptions } from '../../src/app.js';
import { loadConfig, type AppConfig } from '../../src/config/index.js';
import type { Database, MinimalLogger, TenantContext } from '@saas/db';
import type { FastifyInstance } from 'fastify';
import type { PoolClient, QueryResult, QueryResultRow } from 'pg';

/**
 * Test-only app construction.
 *
 * Two modes, because they answer different questions and cost different things:
 *
 *   - `buildTestApp({ db })` with the **stub** below: no services at all, so it
 *     runs on every commit and can assert things that must be true *structurally*
 *     — every route declares its role/rate class, write routes never emit a
 *     cacheable `cache-control`, the OpenAPI document has no tenant data, and so
 *     on. These are the invariants that a code review cannot hold in its head
 *     once there are 30 routes; the *only* thing that keeps them true is a test
 *     that enumerates the tree.
 *   - `openLiveTestApp()` (see `liveApp.ts`): same builder, real Postgres, so the
 *     RLS/quota/rotation behaviour is exercised rather than assumed.
 *
 * The stub deliberately records every statement. Half of the interesting
 * assertions in a multi-tenant API are "the tenant predicate was actually in the
 * SQL", which is only checkable if you can see the SQL.
 */
export const TEST_JWT_SECRET = 'unit-test-secret-do-not-use-in-production-32b';

export interface StubCall {
  sql: string;
  params: readonly unknown[];
  ctx: TenantContext | null;
}

/**
 * Rows for a stubbed statement: fixed, or computed from the bound parameters —
 * useful when one test needs two different answers for the same SQL shape (a
 * quota check per plan, a row lookup per id).
 */
export type StubRows = unknown[] | ((params: readonly unknown[]) => unknown[]);

export interface StubDatabase extends Database {
  readonly calls: StubCall[];
  /** Rows returned for any statement containing the needle (first match wins). */
  stub(sqlContains: string, rows: StubRows): void;
  reset(): void;
}

export function stubDatabase(): StubDatabase {
  const calls: StubCall[] = [];
  const stubs: Array<[string, StubRows]> = [];

  function result<TR extends QueryResultRow>(
    sql: string,
    params: readonly unknown[],
  ): QueryResult<TR> {
    const hit = stubs.find(([needle]) => sql.includes(needle));
    const want = hit?.[1] ?? [];
    const rows = (typeof want === 'function' ? want(params) : want) as TR[];
    return {
      rows,
      rowCount: rows.length,
      command: sql.trim().split(/\s+/)[0]?.toUpperCase() ?? 'SELECT',
      fields: [],
      oid: 0 as unknown as number,
    };
  }

  const client: Pick<PoolClient, 'query'> = {
    query: (async (sql: string, params: readonly unknown[] = []) => {
      calls.push({ sql, params, ctx: null });
      return result(sql, params);
    }) as PoolClient['query'],
  };

  const db: StubDatabase = {
    calls,
    pool: undefined as unknown as Database['pool'],
    stub(needle, rows) {
      stubs.push([needle, rows]);
    },
    reset() {
      calls.length = 0;
      stubs.length = 0;
    },
    async query<TR extends QueryResultRow>(text: string, params: readonly unknown[] = []) {
      calls.push({ sql: text, params, ctx: null });
      return result<TR>(text, params);
    },
    async withTenant<T>(_ctx: TenantContext, fn: (tx: PoolClient) => Promise<T>): Promise<T> {
      // The stub mirrors the real signature closely enough that a handler which
      // forgets `withTenant` shows up as a `ctx: null` entry in `calls`.
      calls.push({ sql: `-- begin tenant ${_ctx.tenantId ?? 'none'}`, params: [], ctx: _ctx });
      const out = await fn(client as PoolClient);
      calls.push({ sql: '-- commit', params: [], ctx: _ctx });
      return out;
    },
    async withClient<T>(fn: (tx: PoolClient) => Promise<T>): Promise<T> {
      return fn(client as PoolClient);
    },
    async healthcheck() {
      return { ok: true, latencyMs: 0 };
    },
    stats() {
      return { total: 1, idle: 1, waiting: 0 };
    },
    async close() {},
  };
  return db;
}

export type TestConfigOverrides = Record<string, string | undefined>;

export function testConfig(overrides: TestConfigOverrides = {}): AppConfig {
  return loadConfig({
    NODE_ENV: 'test',
    INTERNAL_LISTENER_ENABLED: 'false',
    LOG_LEVEL: 'silent',
    LOG_PRETTY: 'false',
    DATABASE_URL: 'postgres://app_user:app_user@127.0.0.1:55432/saas',
    REDIS_CACHE_URL: 'memory://',
    REDIS_QUEUE_URL: 'memory://',
    QUEUE_DRIVER: 'outbox',
    JWT_SECRET: TEST_JWT_SECRET,
    ENABLE_SWAGGER: 'true',
    RATE_LIMIT_ENABLED: 'true',
    CACHE_ENABLED: 'true',
    REQUIRE_TENANT_HEADER: 'false',
    ...overrides,
  });
}

export interface TestApp {
  app: FastifyInstance;
  cfg: AppConfig;
  db: StubDatabase;
  log: MinimalLogger;
  close(): Promise<void>;
}

/** Build an app that touches no services. `dbStub` is shared so tests can seed rows. */
export async function buildTestApp(
  opts: {
    config?: Record<string, string | undefined>;
    db?: StubDatabase;
    build?: Partial<BuildOptions>;
  } = {},
): Promise<TestApp> {
  const cfg = testConfig(opts.config);
  const db = opts.db ?? stubDatabase();
  const app = await buildApp({
    config: cfg,
    dbOverride: db,
    logger: false,
    ...opts.build,
  });
  await app.ready();
  return {
    app,
    cfg,
    db,
    log: app.log as unknown as MinimalLogger,
    async close() {
      await app.close();
    },
  };
}

/** A bearer token that is *structurally* valid but unsigned — for 401-path tests. */
export function unsignedJwt(payload: Record<string, unknown>): string {
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64(payload)}.not-a-signature`;
}
