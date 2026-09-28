import pg from 'pg';

const { Client } = pg;

/**
 * Local/CI convenience: turn the roles that the migrations create as
 * NOLOGIN groups into real login roles, so the API, worker and integration
 * tests can connect *as the unprivileged role* and actually exercise RLS.
 *
 * This is intentionally NOT part of a migration: credentials are a deployment
 * concern (Kubernetes Secret / managed-DB user), and a migration that embeds
 * passwords is a vulnerability waiting for the next environment.
 *
 * Production: create `app_user` out-of-band and grant it `LOGIN`. Everything
 * else in the schema is independent of this function.
 */
export interface BootstrapRolesOptions {
  adminUrl: string;
  appUserPassword?: string;
  /** Extra roles allowed to connect (defaults: the app role only). */
  statementTimeoutMs?: number;
  log?: (msg: string, meta?: Record<string, unknown>) => void;
}

export async function ensureLoginRoles(opts: BootstrapRolesOptions): Promise<void> {
  const client = new Client({
    connectionString: opts.adminUrl,
    application_name: 'saas-bootstrap',
  });
  const pw = opts.appUserPassword ?? 'app_user';
  await client.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `DO $$
       BEGIN
         IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN
           CREATE ROLE app_user;
         END IF;
         IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_migrator') THEN
           CREATE ROLE app_migrator;
         END IF;
         IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_admin') THEN
           CREATE ROLE app_admin NOLOGIN NOINHERIT BYPASSRLS;
         END IF;
       END $$`,
    );
    // Utility statements (ALTER ROLE) cannot take bind parameters, so the one
    // dev-only secret here is escaped instead. Production roles are managed by
    // the platform (Terraform / managed DB), never by this function.
    const escaped = pw.replace(/'/g, "''");
    await client.query(
      `ALTER ROLE app_user WITH LOGIN PASSWORD '${escaped}' CONNECTION LIMIT 40 NOSUPERUSER NOCREATEDB NOINHERIT NOREPLICATION NOBYPASSRLS`,
    );
    if (opts.statementTimeoutMs) {
      await client.query(
        `ALTER ROLE app_user SET statement_timeout = ${Number(opts.statementTimeoutMs) | 0}`,
      );
    }
    await client.query('ALTER ROLE app_user SET timezone TO UTC');
    await client.query('COMMIT');
    opts.log?.('login roles ensured', { appUser: 'app_user' });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    await client.end();
  }
}

/** Admin URL to use for migrations/seed: falls back to the app URL. */
export function adminUrlFrom(env: NodeJS.ProcessEnv): string {
  return env.DATABASE_URL_ADMIN ?? env.DATABASE_URL ?? '';
}
