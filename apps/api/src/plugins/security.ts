import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import compress from '@fastify/compress';
import type { FastifyInstance } from 'fastify';
import type { AppConfig } from '../config/index.js';

/**
 * HTTP hardening for a multi-tenant API, with the choices that actually matter:
 *
 *  - **helmet with CSP off for the API origin.** A JSON API has no documents to
 *    protect from injected scripts; a strict CSP on it is noise. What *is*
 *    enabled: `nosniff` (stops a stored SVG/HTML body being rendered), frame
 *    embeddings off, referrer-policy, and HSTS only in production.
 *  - **`cross-origin-resource-policy: same-site`** so a random website cannot
 *    read `/v1/status` or a cached project response through a `<img>`/fetch
 *    side channel even if a CORS rule is later loosened by mistake.
 *  - **CORS with an explicit origin allowlist from config**, credentials off:
 *    auth is a bearer token in a header, so there is no cookie to smuggle and no
 *    reason to allow credentials. `origin: true` (reflect-any) is never used.
 *  - **compression** with a small minimum: compressing 200-byte error JSON is
 *    pure CPU, and compression + secret-bearing responses is the BREACH class of
 *    attack — mitigated here by never reflecting secrets in bodies and by the
 *    `private, no-store` defaults on auth endpoints.
 *  - **body limit** at the Fastify level (512 KiB default) rather than only at
 *    the edge, because pod-to-pod calls bypass the ingress.
 */
export async function registerSecurity(app: FastifyInstance, cfg: AppConfig): Promise<void> {
  await app.register(helmet, {
    global: true,
    contentSecurityPolicy: false,
    crossOriginResourcePolicy: { policy: 'same-site' },
    referrerPolicy: { policy: 'no-referrer' },
    hsts: cfg.isProd ? { maxAge: 31_536_000, includeSubDomains: true, preload: true } : false,
  });

  const allowList = cfg.env.CORS_ORIGINS.split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  await app.register(cors, {
    // Empty list ⇒ no cross-origin access at all. Same-origin web clients work
    // because the browser only enforces CORS for cross-origin requests.
    origin: allowList.length > 0 ? allowList : false,
    credentials: false,
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'authorization',
      'content-type',
      'x-request-id',
      'x-tenant-id',
      'x-tenant-slug',
      'idempotency-key',
      'if-match',
      'cache-control',
    ],
    exposedHeaders: [
      'x-request-id',
      'x-tenant',
      'x-cache',
      'x-ratelimit-source',
      'ratelimit-limit',
      'ratelimit-remaining',
      'retry-after',
      'etag',
      'location',
    ],
    maxAge: 600,
    preflightContinue: false,
    optionsSuccessStatus: 204,
  });

  if (cfg.env.ENABLE_COMPRESSION) {
    await app.register(compress, {
      // `threshold` is the whole policy: below ~1 KiB compression costs more CPU
      // than it saves bandwidth, and every error response lives below it. Brotli
      // first because list payloads are repetitive JSON, where it beats gzip by
      // roughly a third at quality 5 (the default here).
      encodings: ['br', 'gzip'],
      threshold: 1024,
    });
  }
}

/**
 * Every response is `private` by default: in a shared-database multi-tenant
 * service a shared cache is a data-leak risk and the only caches we trust are
 * the ones we own (Redis, tenant-namespaced).
 */
export function registerDefaultHeaders(app: FastifyInstance): void {
  app.addHook('onRequest', (_req, reply, done) => {
    reply.header('cache-control', 'private, no-store');
    reply.header('x-content-type-options', 'nosniff');
    done();
  });
}
