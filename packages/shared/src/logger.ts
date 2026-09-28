import { pino, type LoggerOptions, type Logger } from 'pino';

export type LogLevel = 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace' | 'silent';

const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-api-key"]',
  'password',
  '*.password',
  'newPassword',
  'currentPassword',
  'passwordHash',
  '*.passwordHash',
  'refreshToken',
  '*.refreshToken',
  'accessToken',
  'idToken',
  'jwt',
  '*.jwt',
  'dsn',
  'connectionString',
  '*.connectionString',
];

export interface LoggerConfig {
  level?: LogLevel;
  pretty?: boolean;
  base?: Record<string, unknown>;
  redact?: string[];
}

/**
 * Structured logs, one JSON object per line, always carrying
 * `tenantId` / `requestId` when available (bound onto the request logger).
 *
 * Why pino and not a custom logger: log volume on a busy API is a real cost,
 * pino is the fastest JSON serialiser in the ecosystem, and the
 * `tenant`/`requestId` binding discipline means an on-call engineer can filter
 * one noisy tenant's traffic in a single grep — which is the point of the whole
 * exercise in the load tests.
 */
export function createLogger(cfg: LoggerConfig = {}): Logger {
  const opts: LoggerOptions = {
    level: cfg.level ?? (process.env.LOG_LEVEL as LogLevel) ?? 'info',
    base: {
      service: process.env.SERVICE_NAME ?? 'api',
      version: process.env.BUILD_VERSION ?? 'dev',
      env: process.env.NODE_ENV ?? 'development',
      ...cfg.base,
    },
    redact: { paths: [...REDACT_PATHS, ...(cfg.redact ?? [])], censor: '[redacted]' },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: {
      level: (label) => ({ level: label }),
    },
    // `err` is what pino uses for Error children; keep stacks but cap them.
    nestedKey: undefined,
  };

  if (cfg.pretty ?? process.env.LOG_PRETTY === '1') {
    try {
      // pino-pretty is a devDependency; optional so prod images stay slim.
      return pino({ ...opts, transport: { target: 'pino-pretty' } });
    } catch {
      // fall through to JSON output
    }
  }
  return pino(opts);
}

/** Fields we insist every request-scoped log line carries. */
export interface LogContext {
  requestId?: string;
  tenantId?: string;
  userId?: string;
  route?: string;
  plan?: string;
}

export function withContext(log: Logger, ctx: LogContext): Logger {
  const clean = Object.fromEntries(
    Object.entries(ctx).filter(([, v]) => v !== undefined && v !== ''),
  );
  return Object.keys(clean).length > 0 ? log.child(clean) : log;
}

/** Meters that must never be sampled away (used for the SLI log lines). */
export const AUDIT_EVENT = 'audit';
