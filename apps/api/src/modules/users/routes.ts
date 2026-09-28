import { updateProfileSchema } from '@saas/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { API_PREFIX } from '../../config/constants.js';
import { readBody, readQuery, doc } from '../../lib/validate.js';

/**
 * The caller's own identity endpoints. `PATCH /users/me` writes the *global*
 * users row (name only) — email changes are a separate, verified flow and are
 * intentionally not offered here, because changing the login identifier while
 * sessions are live is a support-and-security problem, not a CRUD field.
 */
export function userRoutes(app: FastifyInstance): void {
  app.get(
    `${API_PREFIX}/users/me`,
    {
      config: {
        routeClass: 'read',
        selfScoped: true,
        summary: 'Caller profile',
        operationId: 'getMe',
      },
      schema: { tags: ['users'] },
    },
    async (req) => app.users.profile(req.auth!.userId, req.auth!.tenantId),
  );

  app.patch(
    `${API_PREFIX}/users/me`,
    {
      config: {
        routeClass: 'write',
        summary: 'Update the caller profile',
        selfScoped: true,
        operationId: 'updateMe',
      },
      schema: { tags: ['users'], body: doc(updateProfileSchema), 'x-zod': true },
    },
    async (req, reply) => {
      const body = readBody(req, updateProfileSchema);
      await app.users.updateProfile(req.auth!.userId, req.auth!.tenantId, body);
      return reply.send(await app.users.profile(req.auth!.userId, req.auth!.tenantId));
    },
  );

  const statsQuery = z.object({ days: z.coerce.number().int().min(1).max(365).default(30) });

  app.get(
    `${API_PREFIX}/users/me/usage`,
    {
      config: {
        routeClass: 'read',
        selfScoped: true,
        summary: 'This caller’s recent request/limit posture (self-service debugging)',
        operationId: 'getUsage',
      },
      schema: { tags: ['users'], querystring: doc(statsQuery), 'x-zod': true },
    },
    async (req) => {
      const q = readQuery(req, statsQuery);
      const summary = await app.usageSummary(req.tenant!, q.days);
      return {
        tenant: req.tenant!.slug,
        plan: req.tenant!.plan,
        limits: req.tenant!.planLimits,
        ...(summary as object),
      };
    },
  );
}
