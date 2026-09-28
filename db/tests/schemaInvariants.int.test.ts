import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, type Database } from '../src/database.js';

/**
 * Schema invariants, asserted against the catalog rather than the application.
 *
 * The API tests prove that *this code path* is tenant-scoped. These prove that the
 * database itself would still hold the line if a code path forgot to be — which is
 * the entire reason row-level security is the backstop in this design:
 *
 *   - every table carrying `tenant_id` has RLS **enabled and forced** (a policy
 *     that is present but not forced is a policy an owner can skip),
 *   - every policy compares the row's tenant with the session's, so a missing
 *     predicate is not silently "allowed",
 *   - `app_admin` is the only BYPASSRLS role, and it cannot log in,
 *   - every SECURITY DEFINER function is owned by it, pins `search_path`, and is
 *     not executable by PUBLIC — a definer function reachable by anyone with a
 *     mutable search_path is a privilege-escalation primitive, not a helper,
 *   - the quota and `updated_at` behaviour lives in triggers, so a raw INSERT that
 *     bypasses the API is still bounded.
 *
 * All of it runs as `app_user`: nothing here needs superuser, which is also the
 * point — an operator can run this file against production with the app's own
 * credentials.
 */

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', 'migrations');
const NO_DATABASE = !process.env.DATABASE_URL;

let db!: Database;
const createdTenants: Array<{ tenantId: string; userId: string; slug: string }> = [];

beforeAll(() => {
  db = createDatabase({
    connectionString: process.env.DATABASE_URL as string,
    applicationName: 'saas-schema-it',
    maxConnections: 3,
    minConnections: 1,
  });
}, 30_000);

afterAll(async () => {
  // Best effort: dev Postgres should not accumulate test workspaces. Cascade takes
  // the rows; a failure here means the environment lacks DELETE rights, which is
  // not what this file is testing.
  for (const t of createdTenants) {
    await db
      .withTenant({ tenantId: t.tenantId, userId: t.userId, role: 'owner' }, (tx) =>
        tx.query('DELETE FROM tenants WHERE id = $1', [t.tenantId]),
      )
      .catch(() => undefined);
  }
  await db.close();
});

async function tenantPair(plan = 'pro') {
  const slug = `db-it-${Math.random().toString(36).slice(2, 10)}`;
  const rows = await db.query<{ o_tenant_id: string; o_user_id: string }>(
    'SELECT o_tenant_id, o_user_id FROM app.register_tenant($1,$2,$3,$4,$5,$6,$7,$8,$9)',
    [
      cryptoRandomUuid(),
      slug,
      `Schema invariant ${slug}`,
      plan,
      cryptoRandomUuid(),
      `owner@${slug}.test`,
      '$argon2id$not-a-real-hash-for-schema-tests',
      'Schema Tester',
      'schema-invariants',
    ],
  );
  const created = { tenantId: rows.rows[0]!.o_tenant_id, userId: rows.rows[0]!.o_user_id, slug };
  createdTenants.push(created);
  return created;
}

function cryptoRandomUuid(): string {
  const b = new Uint8Array(16);
  globalThis.crypto.getRandomValues(b);
  b[6] = ((b[6] as number) & 0x0f) | 0x40;
  b[8] = ((b[8] as number) & 0x3f) | 0x80;
  const hex = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

describe.skipIf(NO_DATABASE)('row-level security', () => {
  it('leaves no tenant table unprotected (RLS enabled AND forced)', async () => {
    const res = await db.query<{ table_name: string }>(
      'SELECT table_name::text AS table_name FROM app.unprotected_tenant_tables',
    );
    expect(res.rows, 'tables needing RLS enabled+forced').toEqual([]);
  });

  it('has a policy for every command, each one comparing against the session tenant', async () => {
    // `pg_policies` (not `pg_policy`) so the expressions are already rendered text.
    const res = await db.query<{
      table: string;
      policies: string;
      reads_unfiltered: string;
      foreign_predicate: string;
      writes_unchecked: string;
    }>(
      // The rule per table, read from `pg_policies` (already-rendered expressions):
      //   · every policy that filters reads has a USING expression, and that
      //     expression names `tenant_id` — otherwise "no row matches" is not what
      //     the policy says;
      //   · every policy that allows INSERT/UPDATE has WITH CHECK, or a row for
      //     another tenant can be written even though it cannot be read back;
      //   · append-only tables (audit_log) legitimately have no write policy at all,
      //     which is why this is asserted per command, not per table.
      `SELECT p.tablename AS table,
              count(*)::text AS policies,
              count(*) FILTER (WHERE p.qual IS NULL AND p.cmd IN ('SELECT','UPDATE','DELETE','ALL'))::text AS reads_unfiltered,
              count(*) FILTER (WHERE p.qual IS NOT NULL AND p.qual NOT LIKE '%tenant_id%')::text AS foreign_predicate,
              count(*) FILTER (WHERE p.with_check IS NULL AND p.cmd IN ('INSERT','UPDATE'))::text AS writes_unchecked
         FROM pg_policies p
        WHERE p.schemaname = 'public'
          AND p.tablename IN (
            SELECT c.relname
              FROM pg_class c
              JOIN pg_namespace n ON n.oid = c.relnamespace
             WHERE n.nspname = 'public'
               AND c.relkind = 'r'
               AND EXISTS (
                 SELECT 1 FROM pg_attribute a
                  WHERE a.attrelid = c.oid AND a.attname = 'tenant_id' AND a.attnum > 0 AND NOT a.attisdropped))
        GROUP BY p.tablename
        ORDER BY p.tablename`,
    );
    const tables = res.rows;
    // A guard against the query silently matching nothing and the test passing.
    expect(tables.length).toBeGreaterThanOrEqual(5);
    for (const row of tables) {
      expect(Number(row.policies), `${row.table} has policies`).toBeGreaterThanOrEqual(1);
      expect(Number(row.reads_unfiltered), `${row.table} filters reads`).toBe(0);
      expect(Number(row.foreign_predicate), `${row.table} predicate names tenant_id`).toBe(0);
      expect(Number(row.writes_unchecked), `${row.table} checks writes`).toBe(0);
    }
  });

  it('filters by tenant at the database, with no help from the application', async () => {
    const a = await tenantPair();
    const b = await tenantPair();
    const projectId = cryptoRandomUuid();

    await db.withTenant({ tenantId: a.tenantId, userId: a.userId, role: 'owner' }, async (tx) => {
      await tx.query(
        `INSERT INTO projects (id, tenant_id, owner_id, name, slug)
         VALUES ($1, app.current_tenant_id(), $2, 'Isolated', $3)`,
        [projectId, a.userId, `iso-${projectId.slice(0, 8)}`],
      );
    });

    const asB = await db.withTenant(
      { tenantId: b.tenantId, userId: b.userId, role: 'owner' },
      async (tx) => (await tx.query('SELECT id FROM projects WHERE id = $1', [projectId])).rows,
    );
    expect(asB, 'tenant B must not see tenant A’s row').toEqual([]);

    // …and with NO tenant pinned at all, app_user sees nothing: `app.current_tenant_id()`
    // is NULL, so the policy is false for every row. This is the state a forgotten
    // `withTenant` lands in, and it must fail closed rather than wide open.
    const unscoped = await db.query('SELECT id FROM projects');
    expect(unscoped.rowCount).toBe(0);

    const asA = await db.withTenant(
      { tenantId: a.tenantId, userId: a.userId, role: 'owner' },
      async (tx) => (await tx.query('SELECT id FROM projects WHERE id = $1', [projectId])).rowCount,
    );
    expect(asA).toBe(1);
  });
});

describe.skipIf(NO_DATABASE)('privileges', () => {
  it('keeps the bypass role unlogin-able and the app role bound by RLS', async () => {
    const res = await db.query<{
      rolname: string;
      canlogin: boolean;
      bypass: boolean;
      inherit: boolean;
    }>(
      `SELECT rolname, rolcanlogin AS canlogin, rolbypassrls AS bypass, rolinherit AS inherit
         FROM pg_roles WHERE rolname IN ('app_user','app_admin','app_migrator') ORDER BY rolname`,
    );
    const byName = new Map(res.rows.map((r) => [r.rolname, r]));
    expect(byName.get('app_user')).toMatchObject({ canlogin: true, bypass: false });
    expect(byName.get('app_admin')).toMatchObject({ canlogin: false, bypass: true });
    // NOINHERIT: app_admin's bypass must only apply inside a definer function that
    // explicitly assumes it, never because some role was granted membership.
    expect(byName.get('app_admin')?.inherit).toBe(false);
  });

  it('owns, pins and hides every SECURITY DEFINER function', async () => {
    const res = await db.query<{
      proname: string;
      owner: string;
      cfg: string | null;
      acl: string | null;
      public_execute: boolean;
    }>(
      `SELECT p.proname,
              pg_get_userbyid(p.proowner) AS owner,
              array_to_string(p.proconfig, ',') AS cfg,
              p.proacl::text AS acl,
              (p.proacl::text ~ '(^|\\{)=X/' OR p.proacl::text ~ ',=X/') AS public_execute
         FROM pg_proc p
         JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'app' AND p.prosecdef
        ORDER BY p.proname`,
    );
    expect(res.rowCount).toBeGreaterThan(5);
    for (const fn of res.rows) {
      expect(fn.owner, `${fn.proname} owner`).toBe('app_admin');
      expect(String(fn.cfg), `${fn.proname} search_path`).toContain('search_path=');
      expect(fn.public_execute, `${fn.proname} is executable by PUBLIC`).toBe(false);
    }
  });

  it('grants the app role DML only — no DDL, no truncate, no schema creation', async () => {
    const res = await db.query<{
      tbl: boolean;
      trunc: boolean;
      ref: boolean;
      ddl: boolean;
      plans_ro: boolean;
      plans_rw: boolean;
    }>(
      `SELECT has_table_privilege('app_user', 'public.projects', 'SELECT') AS tbl,
              has_table_privilege('app_user', 'public.projects', 'TRUNCATE') AS trunc,
              has_table_privilege('app_user', 'public.projects', 'REFERENCES') AS ref,
              has_schema_privilege('app_user', 'public', 'CREATE') AS ddl,
              has_table_privilege('app_user', 'public.plans', 'SELECT') AS plans_ro,
              has_table_privilege('app_user', 'public.plans', 'INSERT') AS plans_rw`,
    );
    expect(res.rows[0]).toEqual({
      tbl: true,
      trunc: false,
      // REFERENCES is what a malicious tenant could use to add an FK to another
      // tenant's table; the app never declares relations at runtime.
      ref: false,
      ddl: false,
      plans_ro: true,
      plans_rw: false,
    });
  });

  it('revokes public rights on the public schema itself', async () => {
    const res = await db.query<{ acl: string }>(
      `SELECT nspacl::text AS acl FROM pg_namespace n WHERE n.nspname = 'public'`,
    );
    expect(String(res.rows[0]?.acl)).not.toMatch(/^\{?=/); // no bare `=U/` for PUBLIC
  });
});

describe.skipIf(NO_DATABASE)('triggers and constraints', () => {
  it('enforces the plan quota in the database, not in the API', async () => {
    const t = await tenantPair('free');
    await expect(
      db.withTenant({ tenantId: t.tenantId, userId: t.userId, role: 'owner' }, async (tx) => {
        for (let i = 0; i < 11; i++) {
          await tx.query(
            `INSERT INTO projects (tenant_id, owner_id, name, slug)
             VALUES (app.current_tenant_id(), $1, $2, $3)`,
            [t.userId, `over ${i}`, `over-${i}-${cryptoRandomUuid().slice(0, 8)}`],
          );
        }
      }),
      // A free workspace may hold 10 projects: the API's 402 must not be the only
      // thing enforcing that, or any future writer (a migration, a script, another
      // service) silently ignores the plan table.
    ).rejects.toThrow(/quota|limit|plan/i);

    const count = await db.withTenant(
      { tenantId: t.tenantId, userId: t.userId, role: 'owner' },
      async (tx) => (await tx.query('SELECT count(*)::int AS n FROM projects')).rows[0]?.n,
    );
    // The rejected statement rolled back the whole transaction: no 11th row, and
    // no 10 rows left dangling from a partially-applied loop either.
    expect(count).toBe(0);
  });

  it('bumps version and updated_at on write', async () => {
    const t = await tenantPair();
    const before = await db.withTenant(
      { tenantId: t.tenantId, userId: t.userId, role: 'owner' },
      async (tx) => {
        const r = await tx.query<{
          id: string;
          version: number;
          updated_at: string;
          created_at: string;
        }>(
          `INSERT INTO projects (tenant_id, owner_id, name, slug)
         VALUES (app.current_tenant_id(), $1, 'Trigger check', 'trigger-check')
         RETURNING id, version::int AS version, updated_at, created_at`,
          [t.userId],
        );
        return r.rows[0]!;
      },
    );
    // Version starts where the trigger says it starts; the point is that it moves.
    expect(before.version).toBeGreaterThanOrEqual(1);
    const after = await db.withTenant(
      { tenantId: t.tenantId, userId: t.userId, role: 'owner' },
      async (tx) => {
        const r = await tx.query<{ version: number }>(
          'UPDATE projects SET description = $2 WHERE id = $1 RETURNING version::int AS version',
          [before.id, 'edited'],
        );
        return r.rows[0]!;
      },
    );
    expect(after.version).toBeGreaterThan(before.version);
  });

  it('keeps idempotency keys unique per tenant, and not globally', async () => {
    const a = await tenantPair();
    const b = await tenantPair();
    const key = 'shared-key-across-tenants';
    const insert = async (t: { tenantId: string; userId: string }) =>
      db.withTenant({ tenantId: t.tenantId, userId: t.userId, role: 'owner' }, (tx) =>
        tx.query(
          // No `id`: it is `GENERATED ALWAYS AS IDENTITY`, so supplying one is an
          // error by design — nothing outside the database picks outbox positions.
          `INSERT INTO outbox (tenant_id, topic, payload, idempotency_key, status)
           VALUES (app.current_tenant_id(), 'report.generate', '{}'::jsonb, $1, 'pending')`,
          [key],
        ),
      );
    await insert(a);
    // Same key, different workspace: legitimate — two tenants can independently
    // retry the same logical operation. It only has to be unique *within* one.
    await insert(b);
    await expect(insert(a)).rejects.toThrow(/duplicate key|violates unique/i);

    // These rows are deliberately *not* valid jobs, and the worker will claim them:
    // a poison payload left pending inflates outbox_oldest_lag_seconds for an hour
    // and pages for garbage. Retire them here so this file cannot pollute the
    // depth metric that the load tests read — and assert the cleanup actually did
    // something, because an RLS-blocked DELETE returns 0 rows and looks like success.
    for (const t of [a, b]) {
      const cleared = await db.withTenant(
        { tenantId: t.tenantId, userId: t.userId, role: 'owner' },
        async (tx) => {
          const rows = await tx.query<{ id: string }>(
            `SELECT id FROM outbox WHERE idempotency_key = $1 AND status <> 'discarded'`,
            [key],
          );
          for (const row of rows.rows) {
            // Through the same definer function the worker settles with, so this
            // file also proves the retirement path works for a real poison row.
            await tx.query('SELECT app.outbox_mark_discarded($1, $2)', [row.id, 'test garbage']);
          }
          return rows.rowCount ?? 0;
        },
      );
      // Assert it did something: a cleanup that silently matches zero rows is how
      // a test file leaves garbage in a shared dev database.
      expect(cleared).toBe(1);
    }
  });

  it('deletes a tenant’s rows with the tenant (no orphans, no reuse)', async () => {
    const t = await tenantPair();
    await db.withTenant({ tenantId: t.tenantId, userId: t.userId, role: 'owner' }, (tx) =>
      tx.query(
        `INSERT INTO projects (tenant_id, owner_id, name, slug)
         VALUES (app.current_tenant_id(), $1, 'Cascaded', 'cascaded')`,
        [t.userId],
      ),
    );
    const fk = await db.query<{ confdeltype: string }>(
      `SELECT confdeltype FROM pg_constraint
        WHERE contype = 'f' AND conrelid = 'public.projects'::regclass
          AND confrelid = 'public.tenants'::regclass`,
    );
    expect(fk.rows.map((r) => r.confdeltype)).toContain('c');
  });
});

describe.skipIf(NO_DATABASE)('deployed shape', () => {
  it('resolves every object the application calls by name', async () => {
    // The runner’s own ledger (`schema_migrations`) is deliberately NOT readable
    // by app_user — least privilege beats convenience — so this is the check that
    // a deployment actually applied 0012 and not just 0009: the API and worker call
    // these by name, and a half-migrated pod fails at request time instead of boot.
    const res = await db.query<{ why: string; present: string | null }>(
      `SELECT o.why,
              CASE WHEN o.kind = 'v' THEN to_regclass(o.fqn)::text
                   ELSE to_regprocedure(o.fqn)::text END AS present
         FROM (VALUES
           ('v', 'app.outbox_depth', 'outbox depth view (0005)'),
           ('f', 'app.outbox_claim_batch(integer,integer)', 'batch claimer (0012)'),
           ('f', 'app.register_tenant(uuid,text,text,text,uuid,text,text,text,text)', 'signup (0003)'),
           ('f', 'app.session_rotate(character(64),character(64),inet,text,integer)', 'refresh rotation (0008)')
         ) AS o(kind, fqn, why)`,
    );
    expect(res.rows).toHaveLength(4);
    for (const row of res.rows) {
      expect(row.present, `${row.why} is missing`).toBeTruthy();
    }
  });

  it('keeps the migration files contiguous, so a missed one is visible', () => {
    const nums = readdirSync(migrationsDir)
      .filter((f) => f.endsWith('.sql'))
      .map((f) => Number(f.slice(0, 4)))
      .sort((a, b) => a - b);
    expect(nums[0]).toBe(0);
    expect(nums.at(-1)).toBeGreaterThanOrEqual(12);
    // No gaps: `0001,0002,0004` would mean a migration was deleted after release,
    // which every environment that already applied it can never be told about.
    for (let i = 1; i < nums.length; i++) {
      expect(nums[i]).toBe((nums[i - 1] as number) + 1);
    }
  });
});
