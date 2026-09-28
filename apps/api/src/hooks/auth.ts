import { AppError, hasRole, unauthenticated, type Role } from '@saas/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { API_PREFIX } from '../config/constants.js';
import { TokenError } from '../modules/auth/tokens.js';

/**
 * Authentication + workspace RBAC, registered *before* tenant resolution:
 *
 *   1. `config.auth === 'none'` → nothing to do (register/login/refresh/health).
 *   2. verify the bearer JWT (signature, exp, iss, aud) — no DB round trip.
 *   3. look up membership (10s memoised) — this is the authorisation source.
 *   4. require `config.role` rank when the route declares one.
 *
 * Two subtleties worth calling out:
 *   - the *role used for authorisation is the database's*, not the token's, so a
 *     role downgrade takes effect within the memo window; a token's role claim is
 *     only a statement about the past;
 *   - after this hook, `req.auth` is trustworthy but `req.tenant` is not yet set:
 *     `hooks/tenant.ts` resolves the tenant from headers/subdomain/token-claim
 *     and rejects any disagreement between them. A valid token for tenant A can
 *     therefore never be used to read tenant B, because the tenant the request
 *     resolves to must equal the token's `tid`, and every query then runs under
 *     `app.tenant_id` with RLS as the backstop.
 */
export function registerAuth(app: FastifyInstance): void {
  app.addHook('preHandler', async (req: FastifyRequest) => {
    // Default-deny *for the API surface*: a route under `/v1` is authenticated
    // unless it explicitly opts out with `config.auth = 'none'`. Anything else
    // (the service banner, `/documentation` when Swagger is enabled) is outside
    // the tenant data plane and is public by construction — the OpenAPI document
    // carries no rows, and both disappear in production via `ENABLE_SWAGGER`.
    // `tests/routeContracts` asserts every `/v1` route declares `role` +
    // `routeClass`, which is what stops a new endpoint from shipping unguarded.
    const declared = req.routeOptions.config.auth;
    const mode = declared ?? (req.routeOptions.url?.startsWith(API_PREFIX) ? 'required' : 'none');
    const token = bearer(req.headers.authorization);

    if (!token) {
      if (mode === 'none' || mode === 'optional') {
        return;
      }
      throw unauthenticated();
    }

    let actor;
    try {
      actor = await app.tokens.verify(token);
    } catch (err) {
      const expired = err instanceof TokenError && err.kind === 'expired';
      app.metrics.authEvents.inc({ event: expired ? 'token_expired' : 'token_invalid' });
      throw new AppError(
        expired ? 'TOKEN_EXPIRED' : 'TOKEN_INVALID',
        expired ? 'Access token expired' : 'Access token rejected',
        401,
        { cause: err },
      );
    }

    const membership = await app.membership.lookup(actor.userId, actor.tenantId);
    if (!membership) {
      app.metrics.authEvents.inc({ event: 'membership_missing' });
      throw new AppError(
        'TENANT_MEMBERSHIP_REQUIRED',
        'You are not an active member of this workspace',
        403,
      );
    }
    if (membership.tenantStatus !== 'active') {
      throw new AppError('FORBIDDEN', `Workspace is ${membership.tenantStatus}`, 403);
    }

    // Authoritative role/plan, from the DB, replace the token's claims.
    req.auth = { ...actor, role: membership.role };

    const required = req.routeOptions.config.role as Role | undefined;
    if (required && !hasRole(membership.role, required)) {
      app.metrics.authEvents.inc({ event: 'rbac_denied' });
      throw new AppError('FORBIDDEN', `This endpoint requires the ${required} role`, 403, {
        details: { required, held: membership.role },
      });
    }
  });
}

function bearer(header: string | undefined): string | null {
  if (!header) {
    return null;
  }
  const [scheme, value] = header.split(' ');
  if (!value || scheme?.toLowerCase() !== 'bearer') {
    return null;
  }
  return value.trim();
}
