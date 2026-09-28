import { randomUUID } from 'node:crypto';
import { createDatabase, type Database } from '@saas/db';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import { testConfig, type TestConfigOverrides } from './app.js';

/**
 * The live half of the API test harness: the same `buildApp()` as the unit suite,
 * but with a real PostgreSQL behind it.
 *
 * What only this can prove, and therefore what lives here:
 *
 *   - RLS actually filters (the stub records SQL; it cannot fail closed)
 *   - the plan quota trigger fires, and its failure rolls the whole write back
 *   - `app.session_rotate` really revokes a family on reuse, atomically
 *   - an idempotency replay returns the *stored* response, not a re-execution
 *   - ETags, 304s and cache invalidation survive contact with real row versions
 *
 * Every call goes through HTTP (`app.inject`), never through a service method: a
 * bug that a handler hides but a hook fixes is still a bug, and the hooks are half
 * of what this app does.
 *
 * Isolation: each run registers its *own* tenant with a unique slug, so tests can
 * share one database without a truncate step and without interleaving rows.
 */

export const LIVE_PASSWORD = 'Live-Test-Passw0rd-2026!';

/** True when no Postgres is configured — the file-level `describe.skipIf` switch. */
export const NO_DATABASE = !process.env.DATABASE_URL;

export interface LiveSession {
  tenantId: string;
  tenantSlug: string;
  userId: string;
  email: string;
  accessToken: string;
  refreshToken: string;
  role: string;
}

export interface LiveApp {
  app: FastifyInstance;
  db: Database;
  /** Register another workspace: the cheap way to get a second tenant. */
  enroll(input?: { slug?: string; plan?: 'free' | 'pro' | 'enterprise' }): Promise<LiveSession>;
  auth(s: LiveSession, extra?: Record<string, string>): Record<string, string>;
  /** Count rows a tenant can see, through the same RLS path the API uses. */
  count(s: LiveSession, table: 'projects' | 'memberships' | 'report_jobs'): Promise<number>;
  close(): Promise<void>;
}

export async function openLiveTestApp(
  overrides: TestConfigOverrides = {},
): Promise<LiveApp & { session: LiveSession }> {
  const url = process.env.DATABASE_URL as string;
  const db = createDatabase({
    connectionString: url,
    applicationName: 'saas-api-it',
    maxConnections: 4,
    minConnections: 1,
    statementTimeoutMs: 15_000,
    slowQueryMs: 2_000,
  });
  const cfg = testConfig({ ...overrides });
  const app = await buildApp({ config: cfg, dbOverride: db, logger: false });
  await app.ready();

  const sessions: LiveSession[] = [];

  async function enroll(input: { slug?: string; plan?: 'free' | 'pro' | 'enterprise' } = {}) {
    const slug = input.slug ?? `it-${randomUUID().slice(0, 8)}`;
    const email = `owner@${slug}.test`;
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: {
        tenant: { name: `Integration ${slug}`, slug, plan: input.plan ?? 'pro' },
        user: { email, password: LIVE_PASSWORD, displayName: 'Integration Owner' },
      },
    });
    if (res.statusCode !== 201) {
      throw new Error(`register failed (${res.statusCode}): ${res.body.slice(0, 400)}`);
    }
    const body = res.json() as {
      accessToken: string;
      refreshToken: string;
      tenant: { id: string; slug: string; role: string; plan: string };
    };
    const session: LiveSession = {
      tenantId: body.tenant.id,
      tenantSlug: body.tenant.slug,
      userId: '',
      email,
      accessToken: body.accessToken,
      refreshToken: body.refreshToken,
      role: body.tenant.role,
    };
    // The token carries the user id; reading it back here keeps tests from
    // hard-coding a claim shape they should not have to know.
    const claims = JSON.parse(
      Buffer.from(body.accessToken.split('.')[1] ?? '', 'base64url').toString('utf8'),
    ) as {
      sub?: string;
      uid?: string;
    };
    session.userId = claims.sub ?? claims.uid ?? '';
    sessions.push(session);
    return session;
  }

  return {
    app,
    db,
    enroll,
    session: await enroll(),
    auth(s, extra = {}) {
      return { authorization: `Bearer ${s.accessToken}`, ...extra };
    },
    async count(s, table) {
      const res = await db.withTenant(
        { tenantId: s.tenantId, userId: s.userId, role: s.role },
        async (tx) => {
          const r = await tx.query<{ n: string }>(`SELECT count(*)::text AS n FROM ${table}`);
          return r.rows[0]?.n ?? '0';
        },
      );
      return Number(res);
    },
    async close() {
      // Best effort: leave the database as we found it so a shared dev Postgres
      // does not accumulate test tenants forever. `ON DELETE CASCADE` on
      // tenant-owned tables does the work.
      for (const s of sessions) {
        await db
          .withTenant({ tenantId: s.tenantId, userId: s.userId, role: 'owner' }, (tx) =>
            tx.query('DELETE FROM tenants WHERE id = $1', [s.tenantId]),
          )
          .catch(() => undefined);
      }
      await app.close();
      await db.close();
    },
  };
}
