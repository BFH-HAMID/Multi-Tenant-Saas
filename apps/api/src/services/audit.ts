import type { FastifyInstance, FastifyRequest } from 'fastify';

export type AuditAction =
  | 'auth.register'
  | 'auth.login'
  | 'auth.login_failed'
  | 'auth.logout'
  | 'auth.refresh'
  | 'auth.refresh_reuse_detected'
  | 'auth.password_changed'
  | 'tenant.created'
  | 'tenant.plan_changed'
  | 'tenant.settings_updated'
  | 'tenant.suspended'
  | 'member.invited'
  | 'member.role_changed'
  | 'member.removed'
  | 'project.created'
  | 'project.updated'
  | 'project.archived'
  | 'project.deleted'
  | 'report.requested'
  | 'report.completed'
  | 'report.failed'
  | 'ratelimit.throttled';

/**
 * Writes go through `app.audit(...)`, a SECURITY DEFINER function, because the
 * tenant's own policy allows *admins* to read audit rows but nobody to update or
 * delete them. A failed audit write is logged and never fails the request: an
 * audit table that can take down a write path gets disabled by the next
 * incident, and then there is no audit trail either.
 */
export async function audit(
  app: FastifyInstance,
  req: FastifyRequest,
  action: AuditAction,
  detail: { targetType?: string; targetId?: string; data?: Record<string, unknown> } = {},
): Promise<void> {
  if (!req.tenant) {
    return;
  }
  try {
    await app.db.query('SELECT app.audit($1,$2,$3,$4::jsonb)', [
      action,
      detail.targetType ?? null,
      detail.targetId ?? null,
      JSON.stringify(detail.data ?? {}),
    ]);
  } catch (err) {
    req.log.warn({ err: String(err), action }, 'audit write failed');
  }
}
