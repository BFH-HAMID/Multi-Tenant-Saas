import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, type Database } from '../src/database.js';

/**
 * `withTenant`'s after-commit hooks, against a live Postgres.
 *
 * These specs exist because of a specific production-shaped bug: the queue
 * producer published a BullMQ job from *inside* the business transaction, the
 * worker consumed it before COMMIT made the row visible, and the "row not
 * found" path settled the idempotency claim — so the outbox relay's later
 * delivery looked like a replay and the job never ran. `afterCommit` is the
 * contract that makes that class of bug impossible to reintroduce silently:
 *
 *   - hooks run only after COMMIT returned, so any read they trigger observes
 *     the transaction's writes;
 *   - hooks never run for a rolled-back transaction (no phantom jobs);
 *   - a failing hook cannot turn a committed transaction into an error for the
 *     caller (the durable outbox row is the safety net).
 */

const NO_DATABASE = !process.env.DATABASE_URL;

let db!: Database;
const created: Array<{ tenantId: string; userId: string }> = [];

beforeAll(() => {
  db = createDatabase({
    connectionString: process.env.DATABASE_URL as string,
    applicationName: 'saas-tx-it',
  });
});

afterAll(async () => {
  for (const t of created) {
    await db
      .withTenant({ tenantId: t.tenantId, userId: t.userId, role: 'owner' }, (tx) =>
        tx.query('DELETE FROM tenants WHERE id = $1', [t.tenantId]),
      )
      .catch(() => undefined);
  }
  await db.close();
});

async function makeTenant(): Promise<{ tenantId: string; userId: string }> {
  const slug = `tx-it-${Math.random().toString(36).slice(2, 10)}`;
  const rows = await db.query<{ o_tenant_id: string; o_user_id: string }>(
    'SELECT o_tenant_id, o_user_id FROM app.register_tenant($1,$2,$3,$4,$5,$6,$7,$8,$9)',
    [
      randomUUID(),
      slug,
      `Tx scope ${slug}`,
      'pro',
      randomUUID(),
      `owner@${slug}.test`,
      'Owner',
      'Owner-Passw0rd-2026!',
      'owner',
    ],
  );
  const { o_tenant_id: tenantId, o_user_id: userId } = rows.rows[0];
  created.push({ tenantId, userId });
  return { tenantId, userId };
}

describe.skipIf(NO_DATABASE)('withTenant afterCommit', () => {
  it('runs hooks after the writes are committed and visible', async () => {
    const { tenantId, userId } = await makeTenant();
    let seenByHook: string | null = null;

    const result = await db.withTenant({ tenantId, userId, role: 'owner' }, async (tx, scope) => {
      await tx.query(
        `INSERT INTO projects (id, tenant_id, name, slug)
           VALUES ($1, app.current_tenant_id(), 'hook proof', 'hook-proof')`,
        [randomUUID()],
      );
      scope.afterCommit(async () => {
        // A fresh tenant-scoped read on a *different* connection — exactly
        // what the worker's report handler does. If the hook ran inside the
        // transaction (the bug this contract exists to prevent), the row
        // would not be committed yet and this count would be 0.
        const res = await db.withTenant({ tenantId, readOnly: true }, (tx) =>
          tx.query<{ n: string }>('SELECT count(*)::text AS n FROM projects'),
        );
        seenByHook = res.rows[0]?.n ?? null;
      });
      return 'body';
    });

    expect(result).toBe('body'); // the caller is not blocked on hook results
    expect(seenByHook).toBe('1'); // the hook observed the committed row
  });

  it('never runs hooks for a rolled-back transaction', async () => {
    const { tenantId, userId } = await makeTenant();
    let hookRan = false;

    await expect(
      db.withTenant({ tenantId, userId, role: 'owner' }, async (tx, scope) => {
        scope.afterCommit(() => {
          hookRan = true;
        });
        await tx.query(
          `INSERT INTO projects (id, tenant_id, name, slug)
           VALUES ($1, app.current_tenant_id(), 'doomed', 'doomed')`,
          [randomUUID()],
        );
        throw new Error('intentional rollback');
      }),
    ).rejects.toThrow('intentional rollback');

    expect(hookRan).toBe(false);
  });

  it('does not fail the caller when a hook throws', async () => {
    const { tenantId, userId } = await makeTenant();
    let secondHookRan = false;

    const result = await db.withTenant({ tenantId, userId, role: 'owner' }, async (_tx, scope) => {
      scope.afterCommit(() => {
        throw new Error('broker is down (simulated)');
      });
      scope.afterCommit(() => {
        secondHookRan = true; // one bad hook must not starve the rest
      });
      return 'ok';
    });

    expect(result).toBe('ok');
    expect(secondHookRan).toBe(true);
  });
});
