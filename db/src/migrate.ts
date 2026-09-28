import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import type { Logger } from 'pino';

const { Client } = pg;

export interface MigrationFile {
  version: string; // '0001_foundation'
  filename: string;
  sql: string;
  checksum: string;
}

export interface AppliedRow {
  version: string;
  checksum: string;
  applied_at: string;
  duration_ms: number | null;
}

export interface MigrateOptions {
  url: string;
  dir?: string;
  log?: Logger;
  /** Validate without applying. */
  dryRun?: boolean;
  /** Ignore checksum drift on already-applied files (break-glass, logged loudly). */
  force?: boolean;
  lockTimeoutMs?: number;
}

const MIGRATIONS_TABLE = `
CREATE TABLE IF NOT EXISTS schema_migrations (
    version     text PRIMARY KEY,
    checksum    text        NOT NULL,
    applied_at  timestamptz NOT NULL DEFAULT now(),
    duration_ms integer
)`;

/** Advisory lock key so two pods running `migrate` at once serialise. */
const MIGRATE_LOCK_KEY = 74_110_543;

export function migrationsDir(explicit?: string): string {
  if (explicit) {
    return resolve(explicit);
  }
  const here = dirname(fileURLToPath(import.meta.url));
  // dist/ and src/ both sit one level below the package root (db/).
  return resolve(here, '..', 'migrations');
}

export function listMigrations(dir: string): MigrationFile[] {
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .filter((f) => /^\d{4}_[a-z0-9_]+\.sql$/.test(f))
    .sort();

  return files.map((filename) => {
    const full = join(dir, filename);
    if (!statSync(full).isFile()) {
      throw new Error(`migration path is not a file: ${full}`);
    }
    const sql = readFileSync(full, 'utf8');
    return {
      version: filename.replace(/\.sql$/, ''),
      filename,
      sql,
      checksum: createHash('sha256').update(sql, 'utf8').digest('hex').slice(0, 32),
    };
  });
}

export class MigrationError extends Error {
  constructor(
    message: string,
    readonly kind: 'drift' | 'apply' | 'out-of-order',
    override readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'MigrationError';
  }
}

/**
 * A deliberately boring migration runner: ordered `NNNN_name.sql` files, one
 * transaction each, a checksum so "someone edited an applied migration" is a
 * hard error, and an advisory lock so a rolling deploy of N API pods runs the
 * migration exactly once.
 *
 * Why not node-pg-migrate/knex/drizzle? Not because ORMs are bad — because a
 * hand-rolled runner is ~150 lines, has zero runtime dependency in the API
 * image, keeps SQL reviewable as plain DDL (which is what makes RLS policies
 * auditable), and never silently rewrites a migration you already shipped.
 */
export async function migrate(opts: MigrateOptions): Promise<{
  applied: string[];
  skipped: number;
  pending: string[];
}> {
  const log = opts.log;
  const dir = migrationsDir(opts.dir);
  const files = listMigrations(dir);
  const client = new Client({ connectionString: opts.url, application_name: 'saas-migrate' });

  await client.connect();
  const applied: string[] = [];
  let skipped = 0;

  try {
    await client.query(`SELECT pg_advisory_lock(${MIGRATE_LOCK_KEY})`);
    await client.query(MIGRATIONS_TABLE);

    const { rows } = await client.query<AppliedRow>(
      'SELECT version, checksum, applied_at, duration_ms FROM schema_migrations ORDER BY version',
    );
    const byVersion = new Map(rows.map((r) => [r.version, r]));

    let lastVersion = 0;
    for (const file of files) {
      const numeric = Number(file.version.slice(0, 4));
      if (numeric < lastVersion) {
        throw new MigrationError(
          `out-of-order migration detected: ${file.version} sorts after ${lastVersion}`,
          'out-of-order',
        );
      }
      lastVersion = numeric;

      const existing = byVersion.get(file.version);
      if (existing) {
        if (existing.checksum !== file.checksum && !opts.force) {
          throw new MigrationError(
            `checksum mismatch for ${file.filename}: applied ${existing.checksum}, on disk ${file.checksum}. ` +
              'Never edit an applied migration — add a new one. (--force to override)',
            'drift',
          );
        }
        skipped++;
        continue;
      }

      if (opts.dryRun) {
        applied.push(file.version);
        log?.info({ migration: file.version }, 'dry-run: would apply');
        continue;
      }

      const started = Date.now();
      try {
        await client.query('BEGIN');
        await client.query(file.sql);
        await client.query(
          `INSERT INTO schema_migrations (version, checksum, duration_ms) VALUES ($1, $2, $3)`,
          [file.version, file.checksum, Date.now() - started],
        );
        await client.query('COMMIT');
        applied.push(file.version);
        log?.info({ migration: file.version, ms: Date.now() - started }, 'applied');
      } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw new MigrationError(
          `failed to apply ${file.filename}: ${err instanceof Error ? err.message : String(err)}`,
          'apply',
          err,
        );
      }
    }

    const pending = files
      .filter((f) => !applied.includes(f.version) && !byVersionHas(byVersion, f.version))
      .map((f) => f.version);
    return { applied, skipped, pending };
  } finally {
    await client.query(`SELECT pg_advisory_unlock(${MIGRATE_LOCK_KEY})`).catch(() => undefined);
    await client.end();
  }
}

function byVersionHas(map: Map<string, unknown>, version: string): boolean {
  return map.has(version);
}

export async function migrationStatus(opts: {
  url: string;
  dir?: string;
}): Promise<{ version: string; state: 'applied' | 'pending' | 'drift'; appliedAt?: string }[]> {
  const dir = migrationsDir(opts.dir);
  const files = listMigrations(dir);
  const client = new Client({ connectionString: opts.url });
  await client.connect();
  try {
    await client.query(MIGRATIONS_TABLE);
    const { rows } = await client.query<AppliedRow>(
      'SELECT version, checksum, applied_at FROM schema_migrations',
    );
    const byVersion = new Map(rows.map((r) => [r.version, r]));
    return files.map((f) => {
      const rec = byVersion.get(f.version);
      if (!rec) {
        return { version: f.version, state: 'pending' as const };
      }
      return {
        version: f.version,
        state: rec.checksum === f.checksum ? ('applied' as const) : ('drift' as const),
        appliedAt: rec.applied_at,
      };
    });
  } finally {
    await client.end();
  }
}

/** Wait for Postgres to accept connections (compose healthcheck / CI gating). */
export async function waitForPostgres(
  url: string,
  timeoutMs = 30_000,
  log?: Logger,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let attempt = 0;
  for (;;) {
    attempt++;
    try {
      const client = new Client({ connectionString: url, connectionTimeoutMillis: 2_000 });
      await client.connect();
      await client.query('SELECT 1');
      await client.end();
      if (attempt > 1) {
        log?.info({ attempts: attempt }, 'postgres ready');
      }
      return;
    } catch (err) {
      // Only retry what looks like "server not up yet". Auth and missing-database
      // errors would otherwise burn the whole timeout in CI logs.
      const code = (err as Error & { code?: string }).code;
      if (code === '28P01' || code === '3D000' || code === '28000') {
        throw new Error(
          `postgres rejected the connection (${code}): ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      if (Date.now() > deadline) {
        throw new Error(
          `postgres not reachable after ${timeoutMs}ms (${attempt} attempts): ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
      await new Promise((r) => setTimeout(r, Math.min(1000, 100 * attempt)));
    }
  }
}

/** `migrate new <name>` — keeps filenames ordered and checksum-friendly. */
export function nextMigrationName(dir: string, name: string): { filename: string; sql: string } {
  const existing = listMigrations(dir).map((m) => Number(m.version.slice(0, 4)));
  const next = (existing.length ? Math.max(...existing) : 0) + 1;
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  const version = String(next).padStart(4, '0');
  return {
    filename: `${version}_${slug}.sql`,
    sql: `-- ${version}_${slug}.sql
-- Created ${new Date().toISOString()}
--
-- Remember:
--   * every new table with tenant data needs tenant_id + ENABLE/FORCE ROW LEVEL SECURITY + a policy
--   * app.unprotected_tenant_tables must stay empty
--   * never edit an applied migration; add a new one

BEGIN; -- runner already wraps, kept for copy/paste into psql

COMMIT;
`,
  };
}
