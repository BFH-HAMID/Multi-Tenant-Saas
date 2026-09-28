#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { createLogger } from '@saas/shared';
import {
  migrate,
  migrationStatus,
  nextMigrationName,
  waitForPostgres,
  migrationsDir,
} from './migrate.js';
import { seed, DEFAULT_SEED_TENANTS } from './seed.js';
import { ensureLoginRoles } from './bootstrap.js';
import { writeFileSync } from 'node:fs';
import pg from 'pg';
import { join } from 'node:path';

const envSchema = z.object({
  // The runtime role (app_user). Migrations/seed use the admin URL when given.
  DATABASE_URL: z.string().min(1),
  DATABASE_URL_ADMIN: z.string().optional(),
  MIGRATIONS_DIR: z.string().optional(),
  SEED_PROJECTS_PER_TENANT: z.coerce.number().int().min(0).max(20000).optional(),
  NODE_ENV: z.string().default('development'),
});

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    'dry-run': { type: 'boolean', default: false },
    force: { type: 'boolean', default: false },
    reset: { type: 'boolean', default: false },
    wait: { type: 'string', default: '30000' },
    help: { type: 'boolean', short: 'h', default: false },
  },
});

const HELP = `saas-db <command>

Commands
  migrate          Apply pending migrations (advisory-locked, one tx each)
  status           List migrations with applied | pending | drift
  new <name>       Create the next migration file in db/migrations
  bootstrap        Make app_user a LOGIN role (dev/CI only; see docs)
  seed             Provision demo tenants/users/projects (idempotent-ish)
  reset            TRUNCATE seeded data, then re-seed (dev only)
  rebuild          DROP SCHEMA public, re-migrate, re-bootstrap roles, re-seed

Flags
  --dry-run        Report what would be applied
  --force          Ignore checksum drift on applied migrations
  --wait <ms>      Wait up to ms for Postgres to accept connections (default 30000)

Env
  DATABASE_URL                    app role URL (RLS applies)
  DATABASE_URL_ADMIN              migration/seed URL (defaults to DATABASE_URL)
  MIGRATIONS_DIR                  default: db/migrations
  SEED_PROJECTS_PER_TENANT        override the per-tenant project count
`;

/** DROP SCHEMA public CASCADE + recreate, with the grants a fresh DB has. */
export async function rebuildSchema(
  url: string,
  log?: ReturnType<typeof createLogger>,
): Promise<void> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await client.query('SELECT pg_advisory_lock(74110543)');
    // Both schemas: `app` holds the helper/definer functions, and Postgres
    // refuses to change a function's return type in place, so leaving it behind
    // makes a rebuild fail on the next iteration.
    await client.query('DROP SCHEMA IF EXISTS app CASCADE');
    await client.query('DROP SCHEMA IF EXISTS public CASCADE');
    await client.query('CREATE SCHEMA public');
    await client.query('GRANT ALL ON SCHEMA public TO CURRENT_USER');
    await client.query('GRANT USAGE ON SCHEMA public TO PUBLIC');
    log?.info('schema public dropped and recreated');
  } finally {
    await client.query('SELECT pg_advisory_unlock(74110543)').catch(() => undefined);
    await client.end();
  }
}

async function main(): Promise<void> {
  if (values.help || positionals.length === 0) {
    console.log(HELP);
    process.exit(values.help ? 0 : 2);
  }

  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    console.error(
      'invalid env:',
      parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
    );
    console.error('\n' + HELP);
    process.exit(2);
  }
  const env = parsed.data;
  const log = createLogger({ level: 'info' });
  const dir = env.MIGRATIONS_DIR;
  // Migrations need DDL rights; the app role must not have them. Seed/CLI
  // default to the admin URL in dev, and to DATABASE_URL if that is unset.
  const adminUrl = env.DATABASE_URL_ADMIN ?? env.DATABASE_URL;

  if (Number(values.wait) > 0) {
    await waitForPostgres(env.DATABASE_URL, Number(values.wait), log);
  }

  switch (positionals[0]) {
    case 'migrate': {
      const res = await migrate({
        url: adminUrl,
        dir,
        log,
        dryRun: values['dry-run'],
        force: values.force,
      });
      const verb = values['dry-run'] ? 'would apply' : 'applied';
      log.info(
        { count: res.applied.length, skipped: res.skipped, migrations: res.applied },
        `${verb} ${res.applied.length} migration(s), skipped ${res.skipped}`,
      );
      if (res.applied.length === 0) {
        log.info('database schema is up to date');
      }
      break;
    }
    case 'status': {
      const rows = await migrationStatus({ url: adminUrl, dir });
      for (const r of rows) {
        console.log(
          `${r.state.padEnd(8)} ${r.version}${r.appliedAt ? `  (${new Date(r.appliedAt).toISOString()})` : ''}`,
        );
      }
      if (rows.some((r) => r.state === 'drift')) {
        process.exitCode = 1;
        log.error('checksum drift detected: an applied migration was edited');
      }
      break;
    }
    case 'new': {
      const name = positionals[1];
      if (!name) {
        log.error('usage: saas-db new <snake_case_name>');
        process.exit(2);
      }
      const target = migrationsDir(dir);
      const { filename, sql } = nextMigrationName(target, name);
      const path = join(target, filename);
      writeFileSync(path, sql, 'utf8');
      log.info({ file: path }, 'created migration');
      break;
    }
    case 'rebuild': {
      // Dev-only nuke: drop everything (including roles' grants on it), recreate
      // the schema, then re-run the whole pipeline. Cheaper than deleting the
      // data directory when you are iterating on migrations.
      if (process.env.NODE_ENV === 'production') {
        throw new Error('refusing to rebuild against a production DATABASE_URL_ADMIN');
      }
      await rebuildSchema(adminUrl, log);
      const res = await migrate({ url: adminUrl, dir, log });
      log.info({ applied: res.applied.length }, 'rebuild: migrations applied');
      await ensureLoginRoles({
        adminUrl,
        appUserPassword: process.env.APP_USER_PASSWORD ?? 'app_user',
        log: (msg, meta) => log.info(meta ?? {}, msg),
      });
      const seeded = await seed({
        // Seed bootstrap of *identities* has to run with privileges the app role
        // deliberately does not have (no INSERT policy on `users` — see 0002).
        url: adminUrl,
        projectsPerTenant: env.SEED_PROJECTS_PER_TENANT,
        log: (msg, meta) => log.info(meta ?? {}, msg),
      });
      log.info(
        { tenants: seeded.tenants.map((t) => `${t.slug}:${t.projects}projects`) },
        'rebuild complete',
      );
      break;
    }
    case 'bootstrap': {
      await ensureLoginRoles({
        adminUrl,
        appUserPassword: process.env.APP_USER_PASSWORD ?? 'app_user',
        log: (msg, meta) => log.info(meta ?? {}, msg),
      });
      log.info('app_user is now a login role (dev/CI only)');
      break;
    }
    case 'seed': {
      const res = await seed({
        url: adminUrl,
        projectsPerTenant: env.SEED_PROJECTS_PER_TENANT,
        tenants: DEFAULT_SEED_TENANTS,
        reset: values.reset,
        log: (msg, meta) => log.info(meta ?? {}, msg),
      });
      log.info({ tenants: res.tenants }, 'seed complete');
      break;
    }
    case 'reset': {
      const res = await seed({
        url: adminUrl,
        reset: true,
        projectsPerTenant: env.SEED_PROJECTS_PER_TENANT,
        log: (msg, meta) => log.info(meta ?? {}, msg),
      });
      log.info({ tenants: res.tenants }, 'reset + reseed complete');
      break;
    }
    default:
      console.log(HELP);
      process.exit(2);
  }
}

main().catch((err) => {
  // Keep the message single-line-ish: CI logs and `make` output both matter.
  const detail =
    err instanceof Error
      ? (err as Error & { cause?: { message?: string } }).cause?.message
      : undefined;
  console.error(
    JSON.stringify({
      level: 'error',
      msg: 'db cli failed',
      error: String(err),
      cause: detail ?? null,
    }),
  );
  process.exit(1);
});
