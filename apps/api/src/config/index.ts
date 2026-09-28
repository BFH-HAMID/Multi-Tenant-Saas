import { z } from 'zod';
import { parseEnv, bool, redisUrl, postgresUrl } from '@saas/shared';

/**
 * Every knob the API has is declared here — one schema, one error message, and
 * `printConfig()` at boot so a prod incident can start from "what was this pod
 * actually configured with". Nothing in the app reads process.env directly.
 */
const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  SERVICE_NAME: z.string().default('api'),
  BUILD_VERSION: z.string().default('dev'),
  BUILD_SHA: z.string().default('unknown'),

  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  /** Metrics/health listener: never fronted by the public ingress. */
  METRICS_PORT: z.coerce.number().int().min(1).max(65535).default(9464),
  /**
   * Set false in tests (and for a pod scraped only through a loopback sidecar):
   * the probes/metrics objects are still built, and the readiness collector
   * still runs — only the socket is not opened, which is what lets two test
   * files run against one port without EADDRINUSE.
   */
  INTERNAL_LISTENER_ENABLED: bool.default(true),

  DATABASE_URL: postgresUrl,
  /** Admin URL is only read by the migration/seed CLI, never by the API. */
  DATABASE_URL_ADMIN: postgresUrl.optional(),
  PG_POOL_MAX: z.coerce.number().int().min(1).max(200).default(12),
  PG_POOL_MIN: z.coerce.number().int().min(0).max(50).default(2),
  PG_STATEMENT_TIMEOUT_MS: z.coerce.number().int().min(100).max(60_000).default(5_000),
  PG_SLOW_QUERY_MS: z.coerce.number().int().min(10).default(250),

  REDIS_CACHE_URL: redisUrl.default('memory://'),
  REDIS_QUEUE_URL: redisUrl.default('memory://'),
  /** Redis op budget for the request path. A slow Redis must not become a slow API. */
  REDIS_TIMEOUT_MS: z.coerce.number().int().min(50).max(5_000).default(250),
  REDIS_KEY_PREFIX: z.string().max(16).default(''),

  JWT_SECRET: z
    .string()
    .min(16, 'JWT_SECRET must be at least 16 chars (use openssl rand -base64 48)'),
  JWT_ISSUER: z.string().default('saas-api'),
  /** Only meaningful once you rotate signing keys; included in the JWT header. */
  JWT_KEY_ID: z.string().max(32).optional(),
  JWT_AUDIENCE: z.string().default('saas-app'),
  ACCESS_TOKEN_TTL: z.coerce.number().int().min(60).max(3600).default(900),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().min(1).max(365).default(30),

  /** Public base domain(s) used for subdomain tenant resolution. */
  TENANT_BASE_DOMAINS: z
    .string()
    .default('localhost,api.saas.test')
    .transform((s) =>
      s
        .split(',')
        .map((d) => d.trim().toLowerCase())
        .filter(Boolean),
    ),
  REQUIRE_TENANT_HEADER: bool.default(false),

  CACHE_ENABLED: bool.default(true),
  CACHE_DEFAULT_TTL_MS: z.coerce.number().int().min(100).default(15_000),
  CACHE_LIST_TTL_MS: z.coerce.number().int().min(100).default(10_000),

  RATE_LIMIT_ENABLED: bool.default(true),
  /** When Redis is unreachable, limit per-pod instead of not at all. */
  RATE_LIMIT_FALLBACK_MEMORY: bool.default(true),

  /** 'bullmq' | 'outbox' — outbox keeps jobs in Postgres only (dev/no-Redis). */
  QUEUE_DRIVER: z.enum(['bullmq', 'outbox']).default('outbox'),
  QUEUE_NAME_PREFIX: z.string().max(24).default('saas'),

  IDEMPOTENCY_TTL_MS: z.coerce.number().int().min(60_000).default(86_400_000),
  MAX_BODY_BYTES: z.coerce
    .number()
    .int()
    .min(1024)
    .default(512 * 1024),

  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  LOG_PRETTY: bool.default(false),
  CORS_ORIGINS: z.string().default(''),
  ENABLE_SWAGGER: bool.default(false),
  ENABLE_COMPRESSION: bool.default(true),
  /** Trust X-Forwarded-For/Proto (only ever true behind the ingress). */
  TRUST_PROXY: bool.default(false),
  SHUTDOWN_GRACE_MS: z.coerce.number().int().min(0).max(60_000).default(10_000),
  /** Max requests per keep-alive connection; matches the ingress default. */
  KEEP_ALIVE_TIMEOUT_MS: z.coerce.number().int().min(1000).default(72_000),
  HEADERS_TIMEOUT: z.coerce.number().int().min(1000).default(15_000),
  CONNECTION_TIMEOUT: z.coerce.number().int().min(1000).default(30_000),
  REQUEST_TIMEOUT: z.coerce.number().int().min(1000).default(30_000),
  /** Readiness gate: /readyz fails if the DB has been unhealthy this long. */
  READINESS_STALE_MS: z.coerce.number().int().min(1000).default(15_000),
});

export type EnvConfig = z.infer<typeof envSchema>;

export interface AppConfig {
  env: EnvConfig;
  isProd: boolean;
  isTest: boolean;
  baseDomains: string[];
  /** 3000 in the pod, 9464 for Prometheus — see docs/ARCHITECTURE.md. */
  metricsPath: string;
}

export function loadConfig(overrides: Partial<NodeJS.ProcessEnv> = {}): AppConfig {
  const env = parseEnv(envSchema, { ...process.env, ...overrides }) as EnvConfig;
  return {
    env,
    isProd: env.NODE_ENV === 'production',
    isTest: env.NODE_ENV === 'test',
    baseDomains: env.TENANT_BASE_DOMAINS,
    metricsPath: '/metrics',
  };
}

/** Boot-time config dump with secrets reduced to a fingerprint. */
export function printableConfig(cfg: AppConfig): Record<string, unknown> {
  const { env } = cfg;
  return {
    nodeEnv: env.NODE_ENV,
    listen: `${env.HOST}:${env.PORT}`,
    metrics: `${env.HOST}:${env.METRICS_PORT}`,
    version: `${env.BUILD_VERSION}@${env.BUILD_SHA}`,
    db: {
      url: mask(env.DATABASE_URL),
      poolMax: env.PG_POOL_MAX,
      statementTimeoutMs: env.PG_STATEMENT_TIMEOUT_MS,
      slowQueryMs: env.PG_SLOW_QUERY_MS,
    },
    redis: {
      cache: env.REDIS_CACHE_URL.startsWith('memory') ? 'memory://' : mask(env.REDIS_CACHE_URL),
      queue: env.REDIS_QUEUE_URL.startsWith('memory') ? 'memory://' : mask(env.REDIS_QUEUE_URL),
      timeoutMs: env.REDIS_TIMEOUT_MS,
      keyPrefix: env.REDIS_KEY_PREFIX || '(none)',
    },
    cache: {
      enabled: env.CACHE_ENABLED,
      defaultTtlMs: env.CACHE_DEFAULT_TTL_MS,
      listTtlMs: env.CACHE_LIST_TTL_MS,
    },
    rateLimit: {
      enabled: env.RATE_LIMIT_ENABLED,
      fallbackMemory: env.RATE_LIMIT_FALLBACK_MEMORY,
    },
    queue: { driver: env.QUEUE_DRIVER, prefix: env.QUEUE_NAME_PREFIX },
    auth: {
      issuer: env.JWT_ISSUER,
      audience: env.JWT_AUDIENCE,
      accessTtlSec: env.ACCESS_TOKEN_TTL,
      refreshTtlDays: env.REFRESH_TOKEN_TTL_DAYS,
      jwtSecretFingerprint: fingerprint(env.JWT_SECRET),
    },
    tenancy: { baseDomains: cfg.baseDomains, requireHeader: env.REQUIRE_TENANT_HEADER },
    server: {
      bodyLimitBytes: env.MAX_BODY_BYTES,
      trustProxy: env.TRUST_PROXY,
      gracefulShutdownMs: env.SHUTDOWN_GRACE_MS,
      swagger: env.ENABLE_SWAGGER,
      compression: env.ENABLE_COMPRESSION,
    },
  };
}

function mask(url: string): string {
  return url.replace(/\/\/([^:@/]+):[^@]*@/, '//$1:***@');
}

function fingerprint(v: string): string {
  let h = 2166136261;
  for (let i = 0; i < v.length; i++) {
    h = Math.imul(h ^ v.charCodeAt(i), 16777619);
  }
  return (h >>> 0).toString(16);
}
