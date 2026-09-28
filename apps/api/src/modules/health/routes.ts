import type { FastifyInstance } from 'fastify';
import { API_PREFIX } from '../../config/constants.js';

/**
 * Public health surface, intentionally shallow.
 *
 * The *authoritative* probes live on the internal port (`/healthz`, `/livez`,
 * `/readyz` in plugins/metrics.ts) where they can be scraped and probed without
 * being reachable from a client. What belongs on the public API is (a) something
 * a load balancer in front of the app can use if it does not speak to pod ports,
 * and (b) a version/build note for humans.
 *
 * `/v1/status` is a *self-service* endpoint: it exposes the same dependency
 * booleans the readiness gate uses, but never a connection string or a pool
 * password — a status endpoint that leaks DSNs is a common pentest win.
 */
export function healthRoutes(app: FastifyInstance): void {
  app.get(
    `${API_PREFIX}/health`,
    {
      config: {
        auth: 'none',
        publicTenantless: true,
        routeClass: 'read',
        noCache: true,
        summary: 'Shallow liveness',
        operationId: 'health',
      },
      schema: { tags: ['ops'] },
    },
    async (req, reply) => {
      reply.header('cache-control', 'no-store');
      return {
        status: 'ok',
        service: app.cfg.env.SERVICE_NAME,
        version: app.cfg.env.BUILD_VERSION,
        build: app.cfg.env.BUILD_SHA,
        uptimeSec: Math.round(process.uptime()),
        requestId: req.requestId,
      };
    },
  );

  app.get(
    `${API_PREFIX}/status`,
    {
      config: {
        auth: 'none',
        publicTenantless: true,
        routeClass: 'read',
        noCache: true,
        summary: 'Dependency status',
        operationId: 'status',
      },
      schema: { tags: ['ops'] },
    },
    async (req, reply) => {
      const report = (await app.readinessProbe?.()) ?? { ok: true, checks: {} };
      reply.header('cache-control', 'no-store');
      return {
        ready: report.ok,
        checks: report.checks,
        limiter: { degraded: app.limiterState.degraded, backend: app.limiter.kind },
        queue: { driver: app.cfg.env.QUEUE_DRIVER },
      };
    },
  );
}
