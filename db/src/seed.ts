import { randomUUID } from 'node:crypto';
import { hash } from '@node-rs/argon2';
import { passwordKeyMaterial } from '@saas/shared';
import { createDatabase, type Database } from './database.js';

/**
 * Deterministic-ish seed for local dev, integration tests and the load tests.
 *
 * Three tenants — one per plan — because every interesting number in
 * ARCHITECTURE.md (fairness under a noisy neighbour, cache hit ratio by plan,
 * 429 thresholds) needs all three tiers present. `projectsPerTenant` is
 * configurable so the load test can simulate a large customer without a
 * different code path.
 *
 * Tenants are provisioned with the same `app.register_tenant()` the API calls,
 * and the per-tenant writes run inside a real `SET LOCAL app.tenant_id`
 * transaction, so the seed exercises the same code path as production. Identity
 * bootstrap (creating `users` rows) is the one thing that must run with
 * operator privileges: `app_user` has no INSERT policy on `users` on purpose, so
 * `db:seed` takes the admin URL while the API keeps the unprivileged one.
 */

export const SEED_PASSWORD = 'Seed-Passw0rd-2026!';

export interface SeedTenantSpec {
  slug: string;
  name: string;
  plan: 'free' | 'pro' | 'enterprise';
  projects: number;
  members: number;
}

export interface SeedOptions {
  url: string;
  projectsPerTenant?: number;
  tenants?: SeedTenantSpec[];
  log?: (msg: string, meta?: Record<string, unknown>) => void;
  /** Wipe seeded tenants first (dev only). */
  reset?: boolean;
}

export const DEFAULT_SEED_TENANTS: SeedTenantSpec[] = [
  { slug: 'acme', name: 'Acme Rockets', plan: 'free', projects: 8, members: 3 },
  { slug: 'globex', name: 'Globex Analytics', plan: 'pro', projects: 60, members: 12 },
  { slug: 'initech', name: 'Initech Platform', plan: 'enterprise', projects: 400, members: 40 },
];

/** Same argon2id parameters the API uses, so a seeded login is not a special case. */
export async function hashSeedPassword(password: string = SEED_PASSWORD): Promise<string> {
  // Same pre-hash as the API's verifier: argon2 sees the digest of the
  // normalised password, never the password itself.
  return hash(passwordKeyMaterial(password), {
    algorithm: 2, // argon2id
    memoryCost: 19_456,
    timeCost: 2,
    parallelism: 1,
  });
}

export async function seed(opts: SeedOptions): Promise<{
  tenants: Array<{ id: string; slug: string; plan: string; users: number; projects: number }>;
}> {
  const log = opts.log ?? (() => undefined);
  const specs = (opts.tenants ?? DEFAULT_SEED_TENANTS).map((s) => ({
    ...s,
    projects: opts.projectsPerTenant ?? s.projects,
  }));
  const passwordHash = await hashSeedPassword();

  const db = createDatabase({
    connectionString: opts.url,
    statementTimeoutMs: 120_000,
    maxConnections: 4,
    applicationName: 'saas-seed',
  });

  try {
    if (opts.reset) {
      await truncateSeeded(db);
    }

    const out: Array<{ id: string; slug: string; plan: string; users: number; projects: number }> =
      [];

    for (const spec of specs) {
      const tenantId = randomUUID();
      const ownerId = randomUUID();

      await db.query(`SELECT app.register_tenant($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [
        tenantId,
        spec.slug,
        spec.name,
        spec.plan,
        ownerId,
        `owner@${spec.slug}.test`,
        passwordHash,
        `${spec.name} Owner`,
        'seed',
      ]);

      // Extra members, then projects — both inside the tenant's own context.
      await db.withTenant({ tenantId, userId: ownerId, role: 'owner' }, async (tx) => {
        for (let i = 1; i < spec.members; i++) {
          const userId = randomUUID();
          await tx.query(
            `INSERT INTO users (id, email, display_name, password_hash, email_verified_at)
             VALUES ($1, $2, $3, $4, now())
             ON CONFLICT (email_norm) DO UPDATE SET display_name = EXCLUDED.display_name
             RETURNING id`,
            [userId, `user${i}@${spec.slug}.test`, `Member ${i} of ${spec.slug}`, passwordHash],
          );
          await tx.query(
            `INSERT INTO tenant_members (tenant_id, user_id, role, status, joined_at)
             VALUES ($1, $2, $3, 'active', now())
             ON CONFLICT (tenant_id, user_id) DO NOTHING`,
            [tenantId, userId, i % 7 === 0 ? 'admin' : i % 3 === 0 ? 'viewer' : 'member'],
          );
        }
      });

      const inserted = await db.withTenant(
        { tenantId, userId: ownerId, role: 'owner' },
        async (tx) => {
          const values: string[] = [];
          const params: unknown[] = [];
          const maxProjects = spec.plan === 'free' ? 10 : spec.plan === 'pro' ? 250 : 100_000;
          const count = Math.min(spec.projects, maxProjects);
          for (let i = 0; i < count; i++) {
            params.push(
              tenantId,
              ownerId,
              `Project ${i + 1} (${spec.slug})`,
              `proj-${spec.slug}-${i + 1}`,
              i % 9 === 0 ? 'archived' : 'active',
              i % 5 === 0 ? ['priority', 'beta'] : i % 3 === 0 ? ['beta'] : '{}',
              `Generated seed row ${i} for tenant ${spec.slug}.`,
            );
            const base = params.length - 7;
            values.push(
              `($${base + 1}::uuid, $${base + 2}::uuid, $${base + 3}, $${base + 4}, $${base + 5}::project_status, $${base + 6}::text[], $${base + 7})`,
            );
          }
          if (values.length === 0) {
            return 0;
          }
          const res = await tx.query(
            `INSERT INTO projects (tenant_id, owner_id, name, slug, status, tags, description)
           VALUES ${values.join(',')}
           ON CONFLICT (tenant_id, slug) DO NOTHING
           RETURNING id`,
            params,
          );
          return res.rowCount ?? 0;
        },
      );

      const memberCount = await db.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM tenant_members WHERE tenant_id = $1`,
        [tenantId],
      );
      out.push({
        id: tenantId,
        slug: spec.slug,
        plan: spec.plan,
        users: Number(memberCount.rows[0]!.n),
        projects: inserted,
      });
      log('seeded tenant', {
        slug: spec.slug,
        plan: spec.plan,
        projects: inserted,
        users: Number(memberCount.rows[0]!.n),
      });
    }

    // Real queued work for the worker: report jobs *and* the outbox rows that
    // deliver them. The pairing matters — a seeded outbox row whose jobId points
    // at nothing would be dead-lettered by the handler's "job row missing" guard,
    // which makes the first thing an operator sees in the worker log an error
    // about sample data instead of a queue that drains. With this, `make dev`
    // shows depth falling to zero and `GET /v1/reports/{id}` returning a result.
    await seedReportJobs(
      db,
      out.map((t) => t.id),
    );

    return { tenants: out };
  } finally {
    await db.close();
  }
}

/**
 * Queued report jobs, one set per tenant, with the matching outbox rows.
 *
 * `idempotency_key` is derived from the seeded index and protected by the
 * partial unique index on (tenant_id, idempotency_key), so `npm run db:seed`
 * twice is a no-op instead of a constraint violation.
 */
async function seedReportJobs(
  db: Database,
  tenantIds: readonly string[],
  perTenant = 3,
): Promise<number> {
  let total = 0;
  for (const tenantId of tenantIds) {
    total += await db.withTenant({ tenantId }, async (tx) => {
      const inserted = await tx.query<{
        id: string;
        idempotency_key: string;
        requested_by: string | null;
      }>(
        `INSERT INTO report_jobs (tenant_id, requested_by, project_scope, format, status, options, max_attempts, idempotency_key)
         SELECT $1,
                (SELECT user_id FROM tenant_members WHERE tenant_id = $1 AND role = 'owner' LIMIT 1),
                -- A project that survives the report's own filter, so the demo
                -- data produces a non-empty artifact (the oldest seeded project is
                -- archived on purpose, and an empty sample report teaches nothing).
                (SELECT id FROM projects WHERE tenant_id = $1 AND status <> 'archived' ORDER BY created_at LIMIT 1),
                'json',
                'queued',
                jsonb_build_object('includeArchived', false, 'range', NULL),
                3,
                'seed-report-' || g
           FROM generate_series(1, $2::int) AS g
         ON CONFLICT (tenant_id, idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING
         RETURNING id, idempotency_key, requested_by`,
        [tenantId, perTenant],
      );
      for (const job of inserted.rows) {
        await tx.query(`SELECT app.outbox_enqueue($1, 'report.generate', $2::jsonb, $3)`, [
          tenantId,
          JSON.stringify({
            kind: 'report.generate',
            tenantId,
            jobId: job.id,
            requestedBy: job.requested_by,
            idempotencyKey: job.idempotency_key,
            options: { format: 'json', includeArchived: false, range: null },
            requestedAt: new Date().toISOString(),
          }),
          job.idempotency_key,
        ]);
      }
      return inserted.rowCount ?? 0;
    });
  }
  return total;
}

async function truncateSeeded(db: Database): Promise<void> {
  // Owner-level cleanup for dev only; RLS would otherwise block cross-tenant
  // deletes, and the seed is the one place where that is acceptable.
  await db.query(`
    TRUNCATE TABLE
      audit_log,
      idempotency_keys,
      outbox,
      invitations,
      refresh_tokens,
      projects,
      tenant_stats,
      tenant_members,
      users,
      tenants
    RESTART IDENTITY CASCADE
  `);
}
