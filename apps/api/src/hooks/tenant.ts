import {
  AppError,
  extractTenantHint,
  planLimits,
  tenantNotFound,
  type PlanId,
  type TenantStatus,
} from '@saas/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AppConfig } from '../config/index.js';
import { TENANT_CACHE_TTL_MS } from '../config/constants.js';

export interface TenantRow {
  tenant_id: string;
  slug: string;
  name: string;
  plan: PlanId;
  status: TenantStatus;
  retention_days: number;
}

const NEGATIVE_MARKER = '__neg__';
const NEGATIVE_TTL_MS = 5_000;

/**
 * The single funnel through which a tenant enters this process.
 *
 * Precedence (see @saas/shared/src/tenant.ts): `X-Tenant-Id` → `X-Tenant-Slug` →
 * `{slug}.base-domain` → the JWT's `tid` claim. Resolution is memoised in the
 * cache (60s positive / 5s negative — negative caching matters because a typo'd
 * or enumerated subdomain would otherwise be a free Postgres query per hit).
 *
 * Invariants enforced here:
 *   - if an authenticated caller's token names a tenant, the resolved tenant
 *     MUST be that tenant: no header trick can move a valid token into another
 *     workspace (403 rather than a silent switch);
 *   - non-active tenants are refused before any handler work;
 *   - `planLimits` is resolved once per request so the limiter and the cache TTL
 *     scaling never re-read a table.
 */
export function registerTenantResolution(app: FastifyInstance, cfg: AppConfig): void {
  app.addHook('preHandler', async (req: FastifyRequest, reply: FastifyReply) => {
    if (req.routeOptions.config.publicTenantless || req.tenant) {
      return;
    }

    const hint = extractTenantHint(
      {
        headerTenantId: headerValue(req, 'x-tenant-id'),
        headerSlug: headerValue(req, 'x-tenant-slug'),
        host: req.headers.host,
        tokenTenantId: req.auth?.tenantId,
      },
      { baseDomains: cfg.baseDomains, allowLocalhostLabel: !cfg.isProd },
    );

    if (hint.kind === 'none') {
      if (req.auth) {
        // Authenticated but nothing named a tenant: the token's own `tid` is the
        // only acceptable answer, and `extractTenantHint` already used it. A
        // request that reaches here has a token whose tid is unusable.
        throw tenantNotFound('Token carries no workspace; send X-Tenant-Id');
      }
      if (cfg.env.REQUIRE_TENANT_HEADER && req.routeOptions.config.auth !== 'none') {
        throw tenantNotFound('Provide X-Tenant-Id, X-Tenant-Slug or a tenant subdomain');
      }
      return;
    }

    const tenant = await resolveTenant(
      app,
      cfg,
      hint.kind === 'slug' ? { slug: hint.value } : { id: hint.value },
    );

    if (req.auth && req.auth.tenantId !== tenant.tenant_id) {
      app.metrics.authEvents.inc({ event: 'tenant_mismatch' });
      req.log.warn(
        { tokenTenant: req.auth.tenantId, requestedTenant: tenant.tenant_id, source: hint.source },
        'access token used against a different workspace',
      );
      throw new AppError(
        'FORBIDDEN',
        'This access token was issued for a different workspace',
        403,
      );
    }

    if (tenant.status !== 'active') {
      throw new AppError('FORBIDDEN', `Workspace "${tenant.slug}" is ${tenant.status}`, 403, {
        details: { status: tenant.status },
      });
    }

    req.tenant = {
      id: tenant.tenant_id,
      slug: tenant.slug,
      name: tenant.name,
      plan: tenant.plan,
      status: tenant.status,
      resolvedVia: hint.source,
      planLimits: planLimits(tenant.plan),
    };
    reply.header('x-tenant', tenant.slug);
  });
}

export async function resolveTenant(
  app: FastifyInstance,
  cfg: AppConfig,
  which: { id: string } | { slug: string },
): Promise<TenantRow> {
  const key = 'id' in which ? `tenant:id:${which.id}` : `tenant:slug:${which.slug}`;
  const cached = await app.cache.rawGet(key);
  if (cached !== undefined) {
    if (cached === NEGATIVE_MARKER) {
      throw tenantNotFound();
    }
    return JSON.parse(cached) as TenantRow;
  }

  // SECURITY DEFINER on both paths: `tenants` is protected by
  // `id = app.current_tenant_id()`, which is precisely the GUC we are trying to
  // establish, so a plain SELECT here would legitimately return zero rows.
  const { rows } =
    'id' in which
      ? await app.db.query<TenantRow>('SELECT * FROM app.tenant_by_id($1)', [which.id])
      : await app.db.query<TenantRow>('SELECT * FROM app.tenant_by_slug($1)', [which.slug]);

  const row = rows[0];
  if (!row) {
    await app.cache.rawSet(key, NEGATIVE_MARKER, cfg.isProd ? NEGATIVE_TTL_MS : 1_000);
    throw tenantNotFound();
  }
  await app.cache.rawSet(key, JSON.stringify(row), TENANT_CACHE_TTL_MS);
  return row;
}

function headerValue(req: FastifyRequest, name: string): string | undefined {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
}
