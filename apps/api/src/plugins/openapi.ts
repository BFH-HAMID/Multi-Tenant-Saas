import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import type { FastifyInstance } from 'fastify';
import type { AppConfig } from '../config/index.js';

/**
 * OpenAPI from the route table.
 *
 * The important design decision is *where validation happens*. Route options
 * carry a JSON Schema derived from the same zod object the handler uses
 * (`z.toJSONSchema`, `x-zod: true`), and Fastify's validator is replaced below
 * with a no-op for exactly those schemas. So:
 *   - the document cannot drift from the runtime contract (one source),
 *   - zod stays the single validation layer, including the coercions and
 *     defaults AJV would fight (`?limit=25` arrives as a string; JSON Schema
 *     says number),
 *   - and the escape hatch is explicit: a route without `x-zod` still gets AJV,
 *     so nothing silently loses validation if a schema is removed.
 *
 * `/docs` is only mounted when ENABLE_SWAGGER=true (never in production
 * manifests), and the internal port carries no UI at all.
 */
export async function registerOpenApi(app: FastifyInstance, cfg: AppConfig): Promise<void> {
  await app.register(swagger, {
    openapi: {
      openapi: '3.0.3',
      info: {
        title: 'Multi-Tenant SaaS API',
        version: cfg.env.BUILD_VERSION,
        description: [
          'Tenant-scoped REST API on a shared database with row-level security.',
          '',
          '**Tenancy** — send `X-Tenant-Id`, `X-Tenant-Slug`, or use the tenant subdomain;',
          'an access token is bound to one workspace and cannot be pointed at another.',
          '',
          '**Rate limits** — per tenant, per route class, sized by plan. Every response',
          'carries `ratelimit-limit`/`ratelimit-remaining`; 429 carries `retry-after`.',
          '',
          '**Safe retries** — POSTs that accept an `Idempotency-Key` replay the original',
          'response instead of repeating the side effect.',
        ].join('\n'),
      },
      servers: [{ url: '/', description: 'this instance' }],
      components: {
        schemas: {
          ProblemDetails: {
            type: 'object',
            required: ['type', 'title', 'status', 'code'],
            properties: {
              type: { type: 'string', description: 'URI reference to the problem type' },
              title: { type: 'string' },
              status: {
                type: 'integer',
                description: 'HTTP status, mirrored for proxies that drop the body',
              },
              code: { type: 'string', description: 'Stable machine-readable error code' },
              detail: { type: 'string' },
              instance: { type: 'string', description: 'Request path' },
              requestId: {
                type: 'string',
                description: 'Correlates with `x-request-id` and the logs',
              },
              tenantId: {
                type: 'string',
                description: 'Workspace the request resolved to, when it resolved',
              },
              errors: {
                type: 'array',
                description: 'Field-level failures for VALIDATION_FAILED',
                items: {
                  type: 'object',
                  properties: { path: { type: 'string' }, message: { type: 'string' } },
                },
              },
              details: {
                type: 'object',
                description:
                  'Machine-readable extras to branch on, e.g. `currentVersion` on a 409. ' +
                  'Never present on 5xx, where the details belong in the log.',
                additionalProperties: true,
              },
              retryAfter: {
                type: 'integer',
                description: "Seconds until this tenant's rate-limit bucket refills",
              },
            },
          },
        },
        securitySchemes: {
          bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
        },
        responses: {
          Problem: {
            description: 'Error (application/problem+json)',
            content: {
              'application/problem+json': {
                schema: {
                  type: 'object',
                  properties: {
                    type: { type: 'string' },
                    title: { type: 'string' },
                    status: { type: 'integer' },
                    code: { type: 'string' },
                    detail: { type: 'string' },
                    instance: { type: 'string' },
                  },
                },
              },
            },
          },
        },
      },
      security: [{ bearerAuth: [] }],
      tags: [
        { name: 'auth', description: 'Tokens, sessions, identity' },
        { name: 'tenants', description: 'Workspaces, plans, members' },
        { name: 'projects', description: 'The tenant-scoped business resource' },
        { name: 'reports', description: 'Async jobs (queue-backed)' },
        { name: 'ops', description: 'Health and status' },
      ],
    },
    // The routes carry their documentation intent on `config` (role, rate class,
    // idempotency policy, summary) because that is where the *runtime* needs it.
    // @fastify/swagger only reads `schema`, so without this transform every
    // carefully declared operationId and summary would silently vanish from the
    // published document — and the standard error responses would not appear
    // either, which is the half of an API contract clients actually implement.
    transform: (ctx) => {
      const url = ctx.url;
      if (url.startsWith('/documentation')) {
        return { schema: { hide: true }, url };
      }
      const route = ctx.route as unknown as {
        config?: Record<string, unknown>;
        method?: string | string[];
      };
      const rc = (route.config ?? {}) as {
        auth?: string;
        role?: string;
        selfScoped?: boolean;
        idempotency?: string;
        noCache?: boolean;
        operationId?: string;
        summary?: string;
        routeClass?: string;
      };
      const schema: Record<string, unknown> = {
        ...(ctx.schema as Record<string, unknown> | undefined),
      };
      // Internal marker: it tells the validator compiler to stand down, and it
      // has no business appearing in a document we publish.
      delete schema['x-zod'];

      const declared = route.method ?? 'GET';
      const method = (Array.isArray(declared) ? (declared[0] ?? 'GET') : declared).toUpperCase();

      schema.operationId = rc.operationId ?? `${method.toLowerCase()}${pascalCase(url)}`;
      if (rc.summary) {
        schema.summary = rc.summary;
      }
      const notes: string[] = [];
      if (rc.idempotency) {
        notes.push(
          rc.idempotency === 'required'
            ? 'Requires an `Idempotency-Key` header; a retry with the same key replays the original response.'
            : 'Accepts an optional `Idempotency-Key` header; a retry with the same key replays the original response instead of repeating the side effect.',
        );
      }
      if (rc.role) {
        notes.push(`Requires the \`${rc.role}\` role (or higher) in the resolved workspace.`);
      } else if (rc.selfScoped) {
        notes.push('Scoped to the authenticated caller; no workspace role is required.');
      }
      if (rc.routeClass) {
        notes.push(`Charged to the \`${rc.routeClass}\` rate-limit bucket for this tenant's plan.`);
      }
      if (notes.length) {
        const existing = typeof schema.description === 'string' ? `${schema.description}\n\n` : '';
        schema.description = `${existing}${notes.map((n) => `- ${n}`).join('\n')}`;
      }
      // Without this, Swagger UI shows a padlock on `/v1/auth/login` and clients
      // conclude they need a token to log in. `'optional'` means *either* — which
      // is exactly what an array of alternatives expresses in OpenAPI.
      schema.security =
        rc.auth === 'none'
          ? []
          : rc.auth === 'optional'
            ? [{}, { bearerAuth: [] }]
            : [{ bearerAuth: [] }];

      schema.responses = {
        ...standardResponses(method, url, rc),
        ...((schema.responses as Record<string, unknown> | undefined) ?? {}),
      };
      return { schema, url };
    },
  });

  if (cfg.env.ENABLE_SWAGGER) {
    await app.register(swaggerUi, {
      routePrefix: '/documentation',
      uiConfig: { docExpansion: 'list', deepLinking: true },
      staticCSP: true,
      transformSpecification: (spec: Record<string, unknown>) => spec,
    });
  }
}

/**
 * Fastify's AJV layer is deliberately neutered: validation belongs to zod, and
 * the JSON Schema attached to each route exists for the OpenAPI document.
 *
 * Why not both? Because the two layers disagree where coercion is involved —
 * `?limit=25` is a string on the wire and `z.coerce.number()` turns it into a
 * number, while a JSON Schema `type: number` would reject the same request at
 * the framework boundary. Two validators means two error formats and two
 * chances to be inconsistent; one owner (zod) plus a doc-only schema is
 * boring in the right way. `tests/routeContracts.unit.test.ts` asserts every
 * documented route is marked, so a route cannot quietly ship without either.
 */
function pascalCase(path: string): string {
  return path
    .split('/')
    .filter((seg) => seg.length > 0 && !seg.startsWith(':') && !seg.startsWith('{'))
    .map((seg) =>
      seg
        .replace(/[^A-Za-z0-9]+/g, ' ')
        .trim()
        .split(/\s+/)
        .map((w) => w[0]!.toUpperCase() + w.slice(1))
        .join(''),
    )
    .join('');
}

/**
 * The error envelope every route can produce, derived from what the route
 * declared rather than hand-written per route (32 routes × 6 responses is a
 * maintenance story that ends with a stale document). A route can still override
 * or add to these via `schema.response`.
 */
function standardResponses(
  method: string,
  url: string,
  rc: { auth?: string; role?: string; idempotency?: string },
): Record<string, unknown> {
  const problem = (description: string, headers?: Record<string, unknown>) => ({
    description,
    ...(headers ? { headers } : {}),
    content: {
      'application/problem+json': { schema: { $ref: '#/components/schemas/ProblemDetails' } },
    },
  });
  const out: Record<string, unknown> = {
    '400': problem('Malformed request body, query or header'),
    '429': problem('Rate limit for this tenant and route class is exhausted', {
      'Retry-After': {
        description: 'Seconds to wait before retrying',
        schema: { type: 'integer' },
      },
    }),
    '500': problem('Unexpected failure; the response carries `requestId` for correlation'),
  };
  if (rc.auth !== 'none') {
    out['401'] = problem('Missing, expired or rejected access token');
  }
  if (rc.role) {
    out['403'] = problem('Authenticated, but the workspace role is insufficient');
  }
  if (url.includes('{') || url.includes(':')) {
    out['404'] = problem("Not found in this workspace (also the answer for another tenant's id)");
  }
  if (rc.idempotency || method === 'PATCH' || method === 'PUT') {
    out['409'] = problem(
      'Conflict: version moved under you, or the idempotency key was reused with a different payload',
    );
  }
  if (method === 'PATCH' && url.includes('/projects/')) {
    out['428'] = problem(
      'No `If-Match` header: a blind overwrite of a shared resource is refused, not applied',
    );
    out['412'] = problem('`If-Match` is not an etag of the form `W/"v<version>"`');
  }
  if (method === 'post' && url.endsWith('/projects')) {
    out['402'] = problem('Plan quota exceeded; the whole write was rolled back');
  }
  return out;
}

export const passthroughValidatorCompiler = () => (data: unknown) => ({ value: data });
