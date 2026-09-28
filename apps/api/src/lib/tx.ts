import type { FastifyRequest } from 'fastify';
import type { PoolClient } from 'pg';
import type { Database } from '@saas/db';

export interface TxCtx {
  tenantId: string;
  userId?: string;
  role?: string;
  requestId?: string;
  readOnly?: boolean;
}

/**
 * The single way a request touches Postgres.
 *
 * `BEGIN` → three `set_config(..., is_local => true)` calls → work → `COMMIT`.
 * `SET LOCAL` semantics are the whole ballgame on a pooled connection: the GUC
 * is discarded at COMMIT/ROLLBACK, so a connection can never be returned to the
 * pool still carrying tenant A while tenant B borrows it. Using `SET` (without
 * LOCAL) is the classic way to build a cross-tenant bug that only appears under
 * connection reuse, which is why this helper exists instead of per-query SETs.
 *
 * `readOnly` maps to `SET TRANSACTION READ ONLY`, which turns an accidental
 * write on a GET path into an immediate error at development time rather than a
 * silent side effect.
 */
export async function withRequestTenant<T>(
  db: Database,
  req: FastifyRequest,
  fn: (tx: PoolClient) => Promise<T>,
  opts: { readOnly?: boolean } = {},
): Promise<T> {
  if (!req.tenant) {
    throw new Error('withRequestTenant called without a resolved tenant');
  }
  return db.withTenant(
    {
      tenantId: req.tenant.id,
      userId: req.auth?.userId,
      role: req.auth?.role,
      requestId: req.requestId,
      readOnly: opts.readOnly ?? (req.method === 'GET' || req.method === 'HEAD'),
    },
    fn,
  );
}
