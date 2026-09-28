import type { LoggerOptions } from 'pino';
import type { AppConfig } from './index.js';

/**
 * pino configuration, and the reason the access log is ours:
 *
 * In a multi-tenant service, a log line that cannot answer "which tenant, which
 * route template, which status, how long, was it throttled, was the limiter
 * degraded" is not an operational log. Fastify's default line has none of that,
 * and a second framework emitting its own version of the same request is worse.
 *
 * Redactions are structural, not after-the-fact: `authorization`,
 * `cookie`, `password*`, `refreshToken`, `x-api-key` and the DSN parts of any
 * `url` never reach the sink — including in the `err` objects of caught
 * exceptions, which is where secrets usually leak from.
 *
 * JSON in production (a log pipeline parses it), pretty in development, and
 * `silent` under test unless someone flips LOG_LEVEL=debug to look at something.
 */
export function loggerConfig(cfg: AppConfig): LoggerOptions {
  const level = cfg.isTest ? (process.env['LOG_LEVEL'] ?? 'silent') : cfg.env.LOG_LEVEL;
  return {
    level,
    base: {
      service: cfg.env.SERVICE_NAME,
      version: cfg.env.BUILD_VERSION,
      env: cfg.env.NODE_ENV,
    },
    redact: {
      paths: [
        'req.headers.authorization',
        'req.headers.cookie',
        'password',
        '*.password',
        'newPassword',
        'currentPassword',
        'refreshToken',
        '*.refreshToken',
        'accessToken',
        '*.accessToken',
        'inviteToken',
        '*.inviteToken',
        'xApiKey',
        'connectionString',
        '*.connectionString',
        'err.stack',
      ],
      censor: '[redacted]',
    },
    transport:
      cfg.env.LOG_PRETTY && !cfg.isProd
        ? // `pino-pretty` is a devDependency; if it is absent (prod image), pino
          // falls back to JSON, which is what the collector wants anyway.
          { target: 'pino/file', options: { destination: 1 } }
        : undefined,
  };
}

/** One access-log line per request, written by the onResponse hook. */
export function accessLogFields(input: {
  method: string;
  route: string;
  status: number;
  durationMs: number;
  tenantSlug?: string | undefined;
  requestId?: string | undefined;
  userId?: string | undefined;
  routeClass?: string | undefined;
  throttled?: boolean | undefined;
  cacheOutcome?: string | undefined;
  contentLength?: number | undefined;
}): Record<string, unknown> {
  return {
    msg: 'request',
    method: input.method,
    route: input.route,
    status: input.status,
    durationMs: Math.round(input.durationMs * 100) / 100,
    ...(input.tenantSlug ? { tenant: input.tenantSlug } : {}),
    ...(input.userId ? { userId: input.userId } : {}),
    ...(input.requestId ? { requestId: input.requestId } : {}),
    ...(input.routeClass ? { routeClass: input.routeClass } : {}),
    ...(input.throttled ? { throttled: true } : {}),
    ...(input.cacheOutcome ? { cache: input.cacheOutcome } : {}),
    ...(input.contentLength !== undefined ? { bytes: input.contentLength } : {}),
  };
}
