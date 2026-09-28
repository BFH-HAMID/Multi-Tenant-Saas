import {
  changePasswordSchema,
  loginSchema,
  logoutSchema,
  refreshSchema,
  registerSchema,
  badRequest,
  type LoginRequest,
  type RegisterRequest,
} from '@saas/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { API_PREFIX } from '../../config/constants.js';
import { doc, readBody, readQuery } from '../../lib/validate.js';
import { withRequestTenant } from '../../lib/tx.js';

/**
 * Auth surface. Note what is *not* here: no password reset email flow (the
 * worker's email job is the template for it), no OAuth (a federation layer would
 * be a separate module issuing the same token shape).
 *
 * Every route here is `auth: 'none'` + `publicTenantless` + `routeClass: 'auth'`,
 * i.e. the tightest limiter geometry per tenant (free: 5 rps-ish equivalent) plus
 * the IP brake in hooks/rateLimit.ts, and `Cache-Control: no-store`.
 */
export function authRoutes(app: FastifyInstance): void {
  const base = `${API_PREFIX}/auth`;

  app.post(
    `${base}/register`,
    {
      config: {
        auth: 'none',
        publicTenantless: true,
        routeClass: 'auth',
        rateLimitCost: 2,
        summary: 'Create a workspace and its owner in one call',
        operationId: 'register',
      },
      schema: { tags: ['auth'], body: doc(registerSchema), 'x-zod': true },
    },
    async (req, reply) => {
      const body = readBody(req, registerSchema) as RegisterRequest;
      const started = Date.now();

      const { tokens, tenant } = await app.auth.register({
        tenant: body.tenant,
        user: body.user,
        signupSource: body.signupSource,
        ip: clientIpOf(req),
        userAgent: req.headers['user-agent']?.toString(),
      });

      app.metrics.authEvents.inc({ event: 'register_success' });
      req.log.info(
        { tenantId: tokens.tenant.id, slug: tenant.slug, ms: Date.now() - started },
        'workspace registered',
      );

      return reply
        .code(201)
        .header('cache-control', 'no-store')
        .send({
          ...tokens,
          // The token payload is authoritative for role; the tenant row adds the
          // display name. A client must not have to decode its own JWT to learn
          // whether it is an owner.
          tenant: { ...tokens.tenant, name: tenant.name },
        });
    },
  );

  app.post(
    `${base}/login`,
    {
      config: {
        auth: 'none',
        publicTenantless: true,
        routeClass: 'auth',
        summary: 'Exchange credentials for an access + refresh token pair',
        operationId: 'login',
      },
      schema: { tags: ['auth'], body: doc(loginSchema), 'x-zod': true },
    },
    async (req, reply) => {
      const body = readBody(req, loginSchema) as LoginRequest;
      try {
        const result = await app.auth.login({
          email: body.email,
          password: body.password,
          tenantSlug: body.tenantSlug,
          ip: clientIpOf(req),
          userAgent: req.headers['user-agent']?.toString(),
        });
        app.metrics.authEvents.inc({ event: 'login_success' });
        if ('needsTenantChoice' in result) {
          // 300-shaped answer rather than a guess: picking the first tenant for a
          // user with three workspaces is how support tickets start.
          return reply
            .code(200)
            .header('cache-control', 'no-store')
            .send({ needsTenantChoice: result.needsTenantChoice });
        }
        return reply.code(200).header('cache-control', 'no-store').send(result.tokens);
      } catch (err) {
        app.metrics.authEvents.inc({ event: 'login_failure' });
        throw err;
      }
    },
  );

  app.post(
    `${base}/refresh`,
    {
      config: {
        auth: 'none',
        publicTenantless: true,
        routeClass: 'auth',
        summary: 'Rotate a refresh token and mint a new access token',
        operationId: 'refreshTokens',
      },
      schema: { tags: ['auth'], body: doc(refreshSchema), 'x-zod': true },
    },
    async (req, reply) => {
      const { refreshToken } = readBody(req, refreshSchema);
      try {
        const { tokens } = await app.auth.refresh({
          refreshToken,
          ip: clientIpOf(req),
          userAgent: req.headers['user-agent']?.toString(),
        });
        app.metrics.authEvents.inc({ event: 'refresh' });
        return reply.code(200).header('cache-control', 'no-store').send(tokens);
      } catch (err) {
        const reused = (err as { code?: string }).code === 'REFRESH_REUSE_DETECTED';
        app.metrics.authEvents.inc({ event: reused ? 'reuse_detected' : 'refresh_failure' });
        if (reused) {
          // Loud on purpose: this is the "someone else has your token" signal.
          req.log.error({ ip: clientIpOf(req) }, 'refresh token reuse detected — family revoked');
        }
        throw err;
      }
    },
  );

  app.post(
    `${base}/logout`,
    {
      config: {
        auth: 'optional',
        publicTenantless: true,
        routeClass: 'auth',
        summary: 'Revoke this session (or every session for this user)',
        operationId: 'logout',
      },
      schema: { tags: ['auth'], body: doc(logoutSchema), 'x-zod': true },
    },
    async (req, reply) => {
      const body = readBody(req, logoutSchema);
      const { revoked } = await app.auth.logout({
        refreshToken: body.refreshToken,
        allDevices: body.allDevices ?? false,
        userId: req.auth?.userId,
        tenantId: req.auth?.tenantId,
      });
      app.metrics.authEvents.inc({ event: 'logout' });
      // 200 with a count rather than 204: the client is showing the user how many
      // sessions ended, and that answer must not be cacheable — a replayed
      // "revoked 3" would be a lie about the caller's own state.
      return reply.code(200).header('cache-control', 'no-store').send({ revoked });
    },
  );

  app.get(
    `${base}/sessions`,
    {
      config: {
        routeClass: 'read',
        selfScoped: true,
        summary: 'List active sessions for the caller in this workspace',
        operationId: 'listSessions',
      },
      schema: { tags: ['auth'] },
    },
    async (req) => {
      const auth = req.auth!;
      return { data: await app.auth.sessions(auth.userId, auth.tenantId, auth.sessionId) };
    },
  );

  app.post(
    `${base}/password`,
    {
      config: {
        routeClass: 'auth',
        rateLimitCost: 2,
        summary: 'Change the caller’s password (revokes every session)',
        selfScoped: true,
        operationId: 'changePassword',
      },
      schema: { tags: ['auth'], body: doc(changePasswordSchema), 'x-zod': true },
    },
    async (req, reply) => {
      const body = readBody(req, changePasswordSchema);
      const auth = req.auth!;

      await withRequestTenant(app.db, req, async (tx) => {
        const current = await tx.query<{ password_hash: string }>(
          'SELECT password_hash FROM users WHERE id = $1',
          [auth.userId],
        );
        const row = current.rows[0];
        if (!row) {
          throw badRequest('Account not found');
        }
        const ok = await app.passwords.verify(row.password_hash, body.currentPassword);
        if (!ok) {
          app.metrics.authEvents.inc({ event: 'password_change_denied' });
          throw badRequest('Current password is not correct');
        }
        const fresh = await app.passwords.hash(body.newPassword);
        await tx.query('UPDATE users SET password_hash = $2, password_params = $3 WHERE id = $1', [
          auth.userId,
          fresh,
          app.passwords.params,
        ]);
        await tx.query('SELECT app.audit($1,$2,$3,$4::jsonb)', [
          'auth.password_changed',
          'user',
          auth.userId,
          '{}',
        ]);
        // The AFTER UPDATE trigger on users revokes every refresh token for this
        // user, so the change is felt everywhere at once — that is the point.
        return undefined;
      });

      app.metrics.authEvents.inc({ event: 'password_changed' });
      await app.membership.invalidate(auth.userId, auth.tenantId);
      // 204 by design: the client's tokens are now dead, so there is nothing
      // useful to hand back except "re-authenticate".
      return reply.code(204).header('cache-control', 'no-store').send();
    },
  );

  app.get(
    `${API_PREFIX}/me`,
    {
      config: {
        routeClass: 'read',
        selfScoped: true,
        summary: 'Caller identity, workspace and role',
        operationId: 'me',
      },
      schema: { tags: ['auth'] },
    },
    async (req) => {
      const auth = req.auth!;
      const tenant = req.tenant!;
      const profile = await app.users.profile(auth.userId, tenant.id);
      return {
        user: profile,
        tenant: {
          id: tenant.id,
          slug: tenant.slug,
          name: tenant.name,
          plan: tenant.plan,
          status: tenant.status,
        },
        role: auth.role,
        sessionId: auth.sessionId,
        tokenExpiresAt: new Date(auth.exp * 1000).toISOString(),
        limits: tenant.planLimits,
      };
    },
  );

  // Audit trail is admin-visible, tenant-scoped and read-only.
  app.get(
    `${API_PREFIX}/audit`,
    {
      config: {
        role: 'admin',
        routeClass: 'read',
        summary: 'Read this workspace’s audit trail',
        operationId: 'listAudit',
      },
      schema: {
        tags: ['auth'],
        querystring: doc(auditQuerySchema),
        'x-zod': true,
      },
    },
    async (req) => {
      const q = readQuery(req, auditQuerySchema);
      const rows = await withRequestTenant(
        app.db,
        req,
        async (tx) =>
          (
            await tx.query<{
              id: string;
              action: string;
              actor_user_id: string | null;
              target_type: string | null;
              target_id: string | null;
              detail: Record<string, unknown>;
              request_id: string | null;
              created_at: Date;
            }>(
              `SELECT id, action, actor_user_id, target_type, target_id, detail, request_id, created_at
                 FROM audit_log
                WHERE ($1::text IS NULL OR action = $1)
                ORDER BY created_at DESC, id DESC
                LIMIT $2`,
              [q.action ?? null, q.limit],
            )
          ).rows,
        { readOnly: true },
      );
      return {
        data: rows.map((r) => ({
          id: r.id,
          action: r.action,
          actorUserId: r.actor_user_id,
          targetType: r.target_type,
          targetId: r.target_id,
          detail: r.detail,
          requestId: r.request_id,
          createdAt: r.created_at.toISOString(),
        })),
      };
    },
  );
}

function clientIpOf(req: {
  headers: Record<string, unknown>;
  ip: string;
  ips?: string[];
}): string | undefined {
  const fwd = req.ips?.[0];
  return fwd || req.ip || undefined;
}

const auditQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  action: z.string().max(64).optional(),
});
