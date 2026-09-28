import Fastify, { type FastifyInstance } from 'fastify';
import type { Database } from '@saas/db';
import { AppError, badRequest } from '@saas/shared';
import { loggerConfig } from './config/logger.js';
import { loadConfig, type AppConfig } from './config/index.js';
import { registerDb } from './plugins/db.js';
import { registerRedis } from './plugins/redis.js';
import { registerMetrics } from './plugins/metrics.js';

import { registerCache } from './plugins/cache.js';
import { registerLimiter } from './plugins/limiter.js';
import { registerSecurity, registerDefaultHeaders } from './plugins/security.js';
import { passthroughValidatorCompiler, registerOpenApi } from './plugins/openapi.js';
import { registerRequestContext } from './hooks/requestContext.js';
import { registerAuth } from './hooks/auth.js';
import { registerTenantResolution } from './hooks/tenant.js';
import { registerRateLimit } from './hooks/rateLimit.js';
import { registerIdempotency } from './hooks/idempotency.js';
import { registerErrorHandlers } from './lib/errors.js';
import { registerServices } from './plugins/services.js';
import { registerCollectors } from './metrics/collectors.js';
import { authRoutes } from './modules/auth/routes.js';
import { tenantRoutes } from './modules/tenants/routes.js';
import { userRoutes } from './modules/users/routes.js';
import { projectRoutes } from './modules/projects/routes.js';
import { reportRoutes } from './modules/reports/routes.js';
import { healthRoutes } from './modules/health/routes.js';

export interface BuildOptions {
  config?: AppConfig;
  /** Test seam: an already-open Database (see apps/api/tests/helpers/app.ts). */
  dbOverride?: Database;
  logger?: boolean;
}

/**
 * Assembly order is part of the design, not an accident:
 *
 *   1. metrics         — its onRequest/onResponse hooks must see everything after
 *                        them, including rejections from later hooks.
 *   2. db / redis      — connections; both fail the boot if unreachable in prod.
 *   3. cache, limiter  — built on the Redis handles; both tolerate memory mode.
 *   4. security        — helmet/CORS/compress, plus `private, no-store` defaults.
 *   5. services        — pure objects; the BullMQ producer connects here.
 *   6. hooks, in the order requests must meet them:
 *        requestContext → auth → tenant → rateLimit → idempotency
 *      (auth before tenant so the tenant funnel can cross-check the verified
 *      `tid` claim; rateLimit after tenant so bucket geometry comes from the plan;
 *      idempotency last so a replay short-circuits before any handler work)
 *   7. routes, then error handlers (registered last so they see all routes).
 *
 * `disableRequestLogging` is on because the access log is the onResponse hook:
 * one line per request, with the tenant, route template, status and duration
 * already correlated — Fastify's built-in line would be a second, less useful one.
 */
export async function buildApp(opts: BuildOptions = {}): Promise<FastifyInstance> {
  const cfg = opts.config ?? loadConfig();

  const app: FastifyInstance = Fastify({
    logger: buildLogger(cfg, opts.logger),
    // One access line per request, from our onResponse hook. Fastify 5.x
    // deprecates this top-level flag in favour of `logController` (a class you
    // must supply); we keep the flag because supplying a custom controller just
    // to silence a duplicate line is more surface than it is worth, and the
    // deprecation is scoped to fastify@6.
    disableRequestLogging: true,
    // Trusting XFF is a security decision, not a convenience: it is only on when
    // a proxy we control rewrites the header (see the ingress annotations).
    trustProxy: cfg.env.TRUST_PROXY,
    bodyLimit: cfg.env.MAX_BODY_BYTES,
    // 30s of handler work is the pod's contract with the ingress timeout; the
    // request must be aborted rather than finish into a closed socket.
    requestTimeout: cfg.env.REQUEST_TIMEOUT,
    keepAliveTimeout: cfg.env.KEEP_ALIVE_TIMEOUT_MS,
    // 'idle' would be gentler during a rollout, but it can leave a keep-alive
    // socket open past the drain deadline; `true` + grace period is bounded.
    forceCloseConnections: true,
    // One content type, and no schema-based coercion at the framework boundary —
    // see setValidatorCompiler below. `application/x-www-form-urlencoded` writes
    // would be a CSRF-shaped accident, so they are refused, not parsed.
    genReqId: () => '', // replaced by the requestContext hook (one source of truth)
    return503OnClosing: true,
  });

  // Validation belongs to zod (see plugins/openapi.ts): the JSON Schema on each
  // route is for the OpenAPI document, and a second validator at the framework
  // boundary would disagree with zod about query coercion (`?limit=25` is a
  // string on the wire).
  app.setValidatorCompiler(passthroughValidatorCompiler);

  // Fastify 5 exposes requestTimeout/keepAliveTimeout but not headersTimeout, so
  // the slow-loris guard on *headers* is set on the underlying Node server
  // before it starts accepting. Node requires headersTimeout > requestTimeout, so
  // it is clamped above ours rather than taken verbatim from config.
  const rawServer = app.server as unknown as { headersTimeout?: number };
  rawServer.headersTimeout = Math.max(cfg.env.HEADERS_TIMEOUT, cfg.env.REQUEST_TIMEOUT + 1000);

  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_req, body, done) => {
    const buf = body as Buffer;
    if (buf.length === 0) {
      return done(null, undefined);
    }
    try {
      done(null, JSON.parse(buf.toString('utf8')));
    } catch (err) {
      done(badRequest('Request body is not valid JSON', { cause: String(err) }), undefined);
    }
  });

  // Anything else is refused before the handler sees a body it cannot use.
  app.addContentTypeParser('*', (_req, _body, done) => {
    done(
      new AppError('UNSUPPORTED_MEDIA_TYPE', 'This API accepts application/json only', 415),
      undefined,
    );
  });

  const db = await registerDb(app, cfg, opts.dbOverride);
  const redisHandles = await registerRedis(app, cfg);
  const { metrics, internal } = await registerMetrics(app, cfg);
  // The pool is created before the registry (readiness probes need it at boot), so the
  // query observer is attached here rather than passed into `registerDb`. This is the
  // only reason `db_query_duration_seconds` has any data at all — an unattached observer
  // leaves the metric registered, exposed and empty, which is how a panel becomes fiction.
  db.setQueryObserver?.(({ ms, kind }) => {
    metrics.dbQueryDuration.observe({ kind }, ms / 1000);
    if (ms >= cfg.env.PG_SLOW_QUERY_MS) {
      metrics.dbSlowQueries.inc({ kind });
    }
  });
  registerCache(app, redisHandles, metrics, cfg);
  const limiter = registerLimiter(app, cfg, metrics, redisHandles);
  registerDefaultHeaders(app);
  await registerSecurity(app, cfg);
  await registerOpenApi(app, cfg);
  await registerServices(app, cfg);

  registerRequestContext(app);
  registerAuth(app);
  registerTenantResolution(app, cfg);
  registerRateLimit(app);
  registerIdempotency(app);

  healthRoutes(app);
  authRoutes(app);
  tenantRoutes(app);
  userRoutes(app);
  projectRoutes(app);
  reportRoutes(app);

  app.addHook('onResponse', (req, reply, done) => {
    const durationMs = performance.now() - (req.auditStartMs ?? performance.now());
    req.log.info(
      {
        msg: 'request',
        method: req.method,
        route: req.routeOptions?.url ?? 'unmatched',
        status: reply.statusCode,
        durationMs: Math.round(durationMs * 100) / 100,
        ...(req.tenant ? { tenant: req.tenant.slug, plan: req.tenant.plan } : {}),
        ...(req.auth ? { userId: req.auth.userId } : {}),
        ...(req.routeClass ? { routeClass: req.routeClass } : {}),
        ...(req.requestId ? { requestId: req.requestId } : {}),
        bytes: Number(reply.getHeader('content-length') ?? 0),
      },
      'request',
    );
    done();
  });

  app.get('/', async () => ({
    service: cfg.env.SERVICE_NAME,
    docs: cfg.env.ENABLE_SWAGGER ? '/documentation' : undefined,
    openapi: cfg.env.ENABLE_SWAGGER ? '/documentation/json' : undefined,
    health: '/v1/health',
  }));

  registerErrorHandlers(app);

  const collectors = registerCollectors({ app, cfg, metrics, db });
  internal.readinessProbe = collectors.readiness;
  app.readinessProbe = collectors.readiness;
  app.decorate('internalListener', internal);

  const internalPort = cfg.env.METRICS_PORT;
  app.addHook('onReady', async () => {
    // Separate listener: the scrape never competes with traffic on 3000 and is
    // not reachable through the ingress at all.
    if (cfg.env.INTERNAL_LISTENER_ENABLED) {
      await internal.instance.listen({ port: internalPort, host: cfg.env.HOST });
      app.log.info(
        { port: internalPort, paths: ['/metrics', '/readyz', '/livez', '/healthz'] },
        'internal metrics listener up',
      );
    } else {
      app.log.info(
        { port: internalPort },
        'internal metrics listener not bound (INTERNAL_LISTENER_ENABLED=false)',
      );
    }
    // The probe runs either way: readiness is derived from it, and a disabled
    // socket must not quietly turn /readyz into "always ready".
    await collectors.probe();
  });

  // The db/redis plugins own their own close hooks; this one only unwinds what
  // app.ts created: the collector interval, the metrics listener and the limiter.
  app.addHook('onClose', async () => {
    collectors.stop();
    await internal.close();
    await limiter.close();
  });

  return app;
}

function buildLogger(cfg: AppConfig, enabled?: boolean) {
  return enabled === false ? false : loggerConfig(cfg);
}
