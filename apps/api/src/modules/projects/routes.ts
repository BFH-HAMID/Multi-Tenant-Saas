import {
  createProjectSchema,
  listProjectsQuery,
  notFound,
  projectParamsSchema,
  updateProjectSchema,
} from '@saas/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { API_PREFIX } from '../../config/constants.js';
import { readBody, useParams, readQuery, doc } from '../../lib/validate.js';
import type { Requester } from '../../types.js';
import { versionEtag } from '../../lib/paginate.js';

/**
 * The CRUD face of the sample resource. Read routes demonstrate the caching
 * contract (private, version-scoped, ETag-revalidatable); write routes
 * demonstrate the transaction shape (tenant GUC + quota trigger + audit + outbox
 * in one commit).
 *
 * Cache headers on the read path are as much a part of the design as the Redis
 * layer: `cache-control: private, max-age=0, must-revalidate` plus an ETag means
 * a browser/proxy revalidates instead of resending 30 KB of JSON, and `private`
 * keeps tenant data out of any shared cache that might be in front of the API
 * (a CDN is not our tenant boundary).
 */
export function projectRoutes(app: FastifyInstance): void {
  const base = `${API_PREFIX}/projects`;

  app.get(
    base,
    {
      config: {
        role: 'viewer',
        routeClass: 'read',
        summary: 'List projects in this workspace',
        operationId: 'listProjects',
      },
      schema: { tags: ['projects'], querystring: doc(listProjectsQuery), 'x-zod': true },
    },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const query = readQuery(req, listProjectsQuery);
      const force = req.headers['cache-control']?.includes('no-cache') === true;
      const page = await app.projects.list(req.tenant!, query, { forceRefresh: force });

      reply
        .header('cache-control', 'private, max-age=0, must-revalidate')
        .header('vary', 'x-tenant-id, x-tenant-slug, accept-encoding')
        .header('etag', page.etag)
        .header('x-cache', page.cacheOutcome);
      // Honour conditional requests on lists too, not just single resources:
      // `must-revalidate` *asks* every client to come back with If-None-Match,
      // and a 304 (≈150 bytes) instead of a 25 KB page is the whole point of
      // emitting the validator. The etag covers the row set, and the cursor is
      // derived from the last row, so the pair is self-consistent.
      const inm = req.headers['if-none-match'];
      if (typeof inm === 'string' && matchesEtag(inm, page.etag)) {
        return reply.code(304).send();
      }
      return { data: page.data, meta: page.meta };
    },
  );

  app.post(
    base,
    {
      config: {
        role: 'member',
        routeClass: 'write',
        idempotency: 'optional',
        summary: 'Create a project (quota enforced by the database)',
        operationId: 'createProject',
      },
      schema: { tags: ['projects'], body: doc(createProjectSchema), 'x-zod': true },
    },
    async (req, reply) => {
      const body = readBody(req, createProjectSchema);
      const project = await app.projects.create(req.tenant!, requester(req), body, {
        requestId: req.requestId,
      });
      return reply
        .code(201)
        .header('location', `${base}/${project.id}`)
        .header('etag', versionEtag(project.version))
        .removeHeader('cache-control')
        .send(project);
    },
  );

  app.get(
    `${base}/:id`,
    {
      config: {
        role: 'viewer',
        routeClass: 'read',
        summary: 'Fetch one project',
        operationId: 'getProject',
      },
      schema: { tags: ['projects'], params: doc(projectParamsSchema), 'x-zod': true },
    },
    async (req, reply) => {
      const { id } = useParams(req, projectParamsSchema);
      const project = await app.projects.get(req.tenant!, id);
      // The item ETag is the row version, because it doubles as the If-Match
      // token for writes; the page ETag below stays a content hash.
      const etag = versionEtag(project.version);
      if (matchesEtag(String(req.headers['if-none-match'] ?? ''), etag)) {
        app.metrics.cacheLookups.inc({ outcome: 'hit', entity: 'project' });
        return reply.code(304).header('etag', etag).send();
      }
      return reply
        .header('cache-control', 'private, max-age=0, must-revalidate')
        .header('etag', etag)
        .send(project);
    },
  );

  app.patch(
    `${base}/:id`,
    {
      config: {
        role: 'member',
        routeClass: 'write',
        idempotency: 'optional',
        summary: 'Update a project (If-Match optimistic concurrency)',
        description:
          'Requires `If-Match` set to the etag from `GET /v1/projects/:id` ' +
          '(`W/"v<version>"`). A missing precondition is 428, an unparseable one ' +
          '412, and a version that has moved on 409 with `currentVersion`.',
        operationId: 'updateProject',
      },
      schema: {
        tags: ['projects'],
        params: doc(projectParamsSchema),
        body: doc(updateProjectSchema),
        'x-zod': true,
      },
    },
    async (req, reply) => {
      const { id } = useParams(req, projectParamsSchema);
      const body = readBody(req, updateProjectSchema);
      const project = await app.projects.update(req.tenant!, requester(req), id, body, {
        ifMatch: req.headers['if-match'] as string | undefined,
      });
      return reply.code(200).header('etag', versionEtag(project.version)).send(project);
    },
  );

  app.delete(
    `${base}/:id`,
    {
      config: {
        role: 'admin',
        routeClass: 'write',
        rateLimitCost: 2,
        summary: 'Delete a project',
        operationId: 'deleteProject',
      },
      schema: { tags: ['projects'], params: doc(projectParamsSchema), 'x-zod': true },
    },
    async (req, reply) => {
      const { id } = useParams(req, projectParamsSchema);
      await app.projects.remove(req.tenant!, requester(req), id);
      return reply.code(204).send();
    },
  );

  // Bulk-ish read used by the noisy-neighbour scenario: a whole tenant's list in
  // one call, deliberately charged to the `bulk` route class (capacity 2, one
  // refill per minute on free) so one tenant cannot fill the pool with scans.
  app.get(
    `${base}/-/export`,
    {
      config: {
        role: 'member',
        routeClass: 'bulk',
        summary: 'Export every project in this workspace (expensive, tightly limited)',
        operationId: 'exportProjects',
      },
      schema: { tags: ['projects'] },
    },
    async (req) => {
      const data = await app.projects.export(req.tenant!);
      if (data.length === 0) {
        throw notFound('Project');
      }
      return { count: data.length, data };
    },
  );
}

function requester(req: {
  auth?: { userId: string; role: 'owner' | 'admin' | 'member' | 'viewer' };
}): Requester {
  const auth = req.auth!;
  return { userId: auth.userId, role: auth.role };
}

/** RFC 9110: `If-None-Match` may be a comma-separated list or `*`. Weak/strong
 *  comparison per spec — a `W/` validator matches its strong form and vice versa.
 */
function matchesEtag(header: string, etag: string): boolean {
  if (header.trim() === '*') {
    return true;
  }
  const norm = (v: string) => v.trim().replace(/^W\//, '');
  return header.split(',').some((candidate) => norm(candidate) === norm(etag));
}
