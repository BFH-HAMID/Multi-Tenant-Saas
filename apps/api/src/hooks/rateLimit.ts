import { rateLimited, retryAfterSeconds, type PlanId } from '@saas/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { RATE_LIMIT_SOURCE_HEADER, routeClassFor, type RouteClass } from '../config/constants.js';

/**
 * Per-tenant token bucket, applied after tenant+auth resolution (so the bucket
 * geometry can come from the tenant's *plan*) and before any handler work.
 *
 * Two buckets are consulted:
 *   1. `rl:{tenantId}:{routeClass}` — the plan limit; the fairness primitive.
 *   2. for unauthenticated credential routes, `rl:ip:{clientIp}:auth` — a
 *      coarse credential-stuffing brake that works even when the caller has no
 *      tenant at all. Edge-level limiting (ingress limit-rps) is the first
 *      line; this is the second, because the edge is not always in the path
 *      (internal calls, direct NLB, tests).
 *
 * Headers: `RateLimit-Limit/Remaining` (draft-7 style, no reset-time guessing)
 * plus `Retry-After` on 429, and `X-RateLimit-Source: redis|memory` so a
 * degraded limiter is visible from a laptop with curl instead of only in a
 * dashboard nobody is looking at.
 *
 * A rejected request costs one Redis round trip and zero Postgres — which is
 * the entire point of putting the limiter in front of the handlers.
 */
export function registerRateLimit(app: FastifyInstance): void {
  app.addHook('preHandler', async (req: FastifyRequest, reply: FastifyReply) => {
    if (!app.limiterConfig.enabled) {
      reply.header(RATE_LIMIT_SOURCE_HEADER, 'disabled');
      return;
    }

    const routeClass: RouteClass = (req.routeClass ??= routeClassFor(
      req.method,
      req.url,
      req.routeOptions.config.routeClass as RouteClass | undefined,
    ));
    const cost = req.rateLimitCost ?? req.routeOptions.config.rateLimitCost ?? 1;

    // Anonymous brake on credential endpoints.
    if (req.routeOptions.config.auth === 'none' && !req.tenant) {
      const ip = clientIp(req);
      const anon = await app.limiter.consume({
        tenantId: `ip:${ip}`,
        plan: 'free' as PlanId,
        routeClass: 'auth',
        cost: 1,
      });
      if (!anon.allowed) {
        throw rateLimited(anon.retryAfterMs, 'Too many attempts from this address');
      }
    }

    if (!req.tenant) {
      // Tenantless platform routes (health, /plans, docs) are unthrottled here
      // on purpose; they are cheap, read-only and mostly internal.
      reply.header(RATE_LIMIT_SOURCE_HEADER, app.limiter.kind);
      return;
    }

    const decision = await app.limiter.consume({
      tenantId: req.tenant.id,
      plan: req.tenant.plan,
      routeClass,
      cost,
    });

    reply.header('ratelimit-limit', String(decision.limit));
    reply.header('ratelimit-remaining', String(decision.remaining));
    reply.header(
      RATE_LIMIT_SOURCE_HEADER,
      app.limiterState.degraded ? `${decision.backend}+degraded` : decision.backend,
    );

    if (!decision.allowed) {
      const seconds = retryAfterSeconds(decision.retryAfterMs);
      reply.header('retry-after', String(seconds));
      req.log.debug(
        { routeClass, limit: decision.limit, retryAfter: seconds, plan: req.tenant.plan },
        'rate limit exceeded',
      );
      throw rateLimited(decision.retryAfterMs);
    }
  });
}

/**
 * `X-Forwarded-For` is only trusted when TRUST_PROXY=true, i.e. when the pod is
 * behind the ingress that sets it. Trusting it unconditionally would let a
 * client choose its own rate-limit bucket by changing a header — which converts
 * the limiter from a protection into an bypass.
 */
export function clientIp(req: FastifyRequest): string {
  // `req.ips` is only populated when Fastify's trustProxy option is on, which is
  // exactly the gate we want; `req.ip` is the socket address otherwise.
  const forwarded = req.ips?.[0];
  return forwarded || req.ip || 'unknown';
}
