import {
  PLANS,
  changePlanSchema,
  createTenantSchema,
  inviteSchema,
  listMembersQuery,
  updateMemberSchema,
  updateTenantSchema,
  badRequest,
  type PlanId,
} from '@saas/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { API_PREFIX } from '../../config/constants.js';
import { readBody, useParams, readQuery, doc } from '../../lib/validate.js';
import { audit } from '../../services/audit.js';
import type { Requester } from '../../types.js';

const ACCEPT_INVITE = z.object({ token: z.string().min(20).max(256) });
const USER_ID = z.object({ userId: z.string().uuid() });

/**
 * Workspace management. `POST /v1/tenants` is deliberately *not* tenant-scoped:
 * creating a workspace is how you get one, so it runs with just an access token.
 * Everything else under `/tenants/current` operates on the request's resolved
 * tenant and is guarded by role + RLS.
 */
export function tenantRoutes(app: FastifyInstance): void {
  app.get(
    `${API_PREFIX}/plans`,
    {
      config: {
        auth: 'none',
        publicTenantless: true,
        routeClass: 'read',
        summary: 'Plan catalogue',
        operationId: 'listPlans',
      },
      schema: { tags: ['tenants'] },
    },
    async () => ({
      data: (Object.keys(PLANS) as PlanId[]).map((id) => ({
        id,
        maxMembers: PLANS[id].maxMembers,
        maxProjects: PLANS[id].maxProjects,
        maxConcurrentJobs: PLANS[id].maxConcurrentJobs,
        cacheTtlScale: PLANS[id].cacheTtlScale,
        workerConcurrency: PLANS[id].workerConcurrency,
        // The bucket geometry is published on purpose: a client that can see
        // capacity/refill can back off intelligently instead of discovering the
        // 429 by experiment.
        rateLimits: PLANS[id].routes,
      })),
    }),
  );

  app.get(
    `${API_PREFIX}/tenants`,
    {
      config: {
        routeClass: 'read',
        selfScoped: true,
        publicTenantless: true,
        summary: 'Workspaces the caller belongs to',
        operationId: 'listTenants',
      },
      schema: { tags: ['tenants'] },
    },
    async (req) => ({ data: await app.tenants.listForUser(req.auth!.userId) }),
  );

  app.post(
    `${API_PREFIX}/tenants`,
    {
      config: {
        summary: 'Create an additional workspace for the caller',
        selfScoped: true,
        operationId: 'createTenant',
        routeClass: 'write',
        rateLimitCost: 2,
        idempotency: 'optional',
      },
      schema: { tags: ['tenants'], body: doc(createTenantSchema), 'x-zod': true },
    },
    async (req, reply) => {
      const body = readBody(req, createTenantSchema);
      const created = await app.tenants.create(req.auth!.userId, body);
      await audit(app, req, 'tenant.created', {
        targetType: 'tenant',
        targetId: created.id,
        data: { plan: created.plan },
      });
      return reply.code(201).send(created);
    },
  );

  app.get(
    `${API_PREFIX}/tenants/current`,
    {
      config: {
        role: 'viewer',
        routeClass: 'read',
        summary: 'This workspace, its counters and its limits',
        operationId: 'getCurrentTenant',
      },
      schema: { tags: ['tenants'] },
    },
    async (req) => app.tenants.current(req.tenant!),
  );

  app.patch(
    `${API_PREFIX}/tenants/current`,
    {
      config: {
        role: 'admin',
        routeClass: 'write',
        summary: 'Update workspace settings',
        operationId: 'updateCurrentTenant',
      },
      schema: { tags: ['tenants'], body: doc(updateTenantSchema), 'x-zod': true },
    },
    async (req, reply) => {
      const body = readBody(req, updateTenantSchema);
      await app.tenants.updateSettings(req.tenant!, requester(req), body);
      return reply.send(await app.tenants.current(req.tenant!));
    },
  );

  app.post(
    `${API_PREFIX}/tenants/current/plan`,
    {
      config: {
        role: 'owner',
        routeClass: 'write',
        rateLimitCost: 2,
        summary: 'Change the workspace plan (owner only; quotas are checked)',
        operationId: 'changePlan',
      },
      schema: { tags: ['tenants'], body: doc(changePlanSchema), 'x-zod': true },
    },
    async (req, reply) => {
      const { plan } = readBody(req, changePlanSchema);
      const result = await app.tenants.changePlan(req.tenant!, plan as PlanId, requester(req));
      await audit(app, req, 'tenant.plan_changed', {
        targetType: 'tenant',
        targetId: req.tenant!.id,
        data: { plan },
      });
      return reply.send(result);
    },
  );

  app.get(
    `${API_PREFIX}/tenants/current/members`,
    {
      config: {
        role: 'member',
        routeClass: 'read',
        summary: 'List workspace members',
        operationId: 'listMembers',
      },
      schema: { tags: ['tenants'], querystring: doc(listMembersQuery), 'x-zod': true },
    },
    async (req) => {
      const q = readQuery(req, listMembersQuery);
      return {
        data: await app.users.listMembers(req.tenant!.id, { limit: q.limit, role: q.role }),
      };
    },
  );

  app.post(
    `${API_PREFIX}/tenants/current/members`,
    {
      config: {
        role: 'admin',
        routeClass: 'write',
        rateLimitCost: 2,
        summary: 'Invite a member (or grant an existing user access)',
        operationId: 'inviteMember',
      },
      schema: { tags: ['tenants'], body: doc(inviteSchema), 'x-zod': true },
    },
    async (req, reply) => {
      const body = readBody(req, inviteSchema);
      const result = await app.users.invite({
        tenantId: req.tenant!.id,
        tenantSlug: req.tenant!.slug,
        email: body.email,
        role: body.role,
        actor: requester(req),
      });
      return reply.code(result.status === 'invited' ? 202 : 201).send({
        status: result.status,
        ...(result.inviteToken ? { inviteToken: result.inviteToken } : {}),
      });
    },
  );

  app.patch(
    `${API_PREFIX}/tenants/current/members/:userId`,
    {
      config: {
        role: 'admin',
        routeClass: 'write',
        summary: "Change a member's role",
        operationId: 'updateMember',
      },
      schema: {
        tags: ['tenants'],
        params: doc(USER_ID),
        body: doc(updateMemberSchema),
        'x-zod': true,
      },
    },
    async (req, reply) => {
      const { userId } = useParams(req, USER_ID);
      const body = readBody(req, updateMemberSchema);
      if (userId === req.auth!.userId) {
        throw badRequest(
          'Change your own role from another session — you cannot demote yourself out of existence',
        );
      }
      await app.users.changeRole(req.tenant!.id, userId, body.role, requester(req));
      return reply.send({ userId, role: body.role });
    },
  );

  app.delete(
    `${API_PREFIX}/tenants/current/members/:userId`,
    {
      config: {
        role: 'admin',
        routeClass: 'write',
        summary: 'Remove a member',
        operationId: 'removeMember',
      },
      schema: { tags: ['tenants'], params: doc(USER_ID), 'x-zod': true },
    },
    async (req, reply) => {
      const { userId } = useParams(req, USER_ID);
      await app.users.removeMember(req.tenant!.id, userId, requester(req));
      return reply.code(204).send();
    },
  );

  app.post(
    `${API_PREFIX}/tenants/invitations/accept`,
    {
      config: {
        routeClass: 'write',
        rateLimitCost: 2,
        summary: 'Accept an invitation token into this account',
        selfScoped: true,
        operationId: 'acceptInvitation',
      },
      schema: { tags: ['tenants'], body: doc(ACCEPT_INVITE), 'x-zod': true },
    },
    async (req) => {
      const { token } = readBody(req, ACCEPT_INVITE);
      const result = await app.users.acceptInvitation(req.auth!.userId, token);
      return {
        tenantId: result.tenantId,
        role: result.role,
        hint: `Send X-Tenant-Id: ${result.tenantId} to work in it`,
      };
    },
  );
}

function requester(req: {
  auth?: { userId: string; role: 'owner' | 'admin' | 'member' | 'viewer' };
}): Requester {
  const auth = req.auth!;
  return { userId: auth.userId, role: auth.role };
}
