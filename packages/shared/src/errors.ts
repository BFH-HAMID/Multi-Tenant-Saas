/**
 * Typed application errors → RFC 7807 `application/problem+json`.
 *
 * Rules the API obeys:
 *   - never leak SQL, table names or stack traces to clients (message is the
 *     client-safe half, `detail`/`cause` stay in the log),
 *   - every error carries a stable machine code (`code`) so clients can branch
 *     on it without string-matching,
 *   - 4xx are logged at `warn` with no stack, 5xx at `error` with stack: it is
 *     the difference between a useful alert and alert fatigue.
 */

export const ERROR_CODES = [
  'BAD_REQUEST',
  'VALIDATION_FAILED',
  'UNAUTHENTICATED',
  'TOKEN_EXPIRED',
  'TOKEN_INVALID',
  'REFRESH_REUSE_DETECTED',
  'FORBIDDEN',
  'NOT_FOUND',
  'CONFLICT',
  'TENANT_NOT_FOUND',
  'TENANT_MEMBERSHIP_REQUIRED',
  'QUOTA_EXCEEDED',
  'PLAN_LIMIT_EXCEEDED',
  'RATE_LIMITED',
  'IDEMPOTENCY_CONFLICT',
  /** 428: a conditional write (If-Match) was attempted without a precondition. */
  'PRECONDITION_REQUIRED',
  /** 412: the precondition was supplied, but the resource has moved on. */
  'PRECONDITION_FAILED',
  'PAYLOAD_TOO_LARGE',
  'UNSUPPORTED_MEDIA_TYPE',
  'DB_UNAVAILABLE',
  'CACHE_UNAVAILABLE',
  'QUEUE_UNAVAILABLE',
  'DEPENDENCY_FAILURE',
  'TIMEOUT',
  'INTERNAL',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export interface ProblemDetails {
  type: string;
  title: string;
  status: number;
  code: ErrorCode;
  detail?: string;
  instance?: string;
  /** Per-field messages for VALIDATION_FAILED. */
  errors?: Array<{ path: string; message: string }>;
  /**
   * Machine-readable extras for the caller to branch on — e.g. `currentVersion`
   * on a 409, so a client can re-read instead of guessing. Only ever present on
   * 4xx: an internal error's details are for the log, not the response.
   */
  details?: Record<string, unknown>;
  /** Present when the request had a tenant resolved — helps support triage. */
  tenantId?: string;
  requestId?: string;
  retryAfter?: number;
}

export class AppError extends Error {
  readonly statusCode: number;
  readonly code: ErrorCode;
  readonly expose: boolean;
  readonly details?: Record<string, unknown>;
  readonly headers?: Record<string, string>;

  constructor(
    code: ErrorCode,
    message: string,
    statusCode: number,
    opts: {
      details?: Record<string, unknown>;
      expose?: boolean;
      cause?: unknown;
      headers?: Record<string, string>;
    } = {},
  ) {
    super(message, 'cause' in opts ? { cause: opts.cause as object } : undefined);
    this.name = 'AppError';
    this.code = code;
    this.statusCode = statusCode;
    this.expose = opts.expose ?? statusCode < 500;
    this.details = opts.details;
    this.headers = opts.headers;
    Error.captureStackTrace?.(this, AppError);
  }

  toProblem(): ProblemDetails {
    return {
      type: `https://docs.saas.dev/errors/${this.code.toLowerCase()}`,
      title: titleFor(this.code),
      status: this.statusCode,
      code: this.code,
      ...(this.expose ? { detail: this.message } : {}),
      ...(this.details?.['errors']
        ? { errors: this.details['errors'] as ProblemDetails['errors'] }
        : {}),
      ...(this.expose && this.details && Object.keys(this.details).length > 0
        ? { details: this.details }
        : {}),
    };
  }
}

const TITLES: Record<ErrorCode, string> = {
  BAD_REQUEST: 'Bad request',
  VALIDATION_FAILED: 'Request validation failed',
  UNAUTHENTICATED: 'Authentication required',
  TOKEN_EXPIRED: 'Access token expired',
  TOKEN_INVALID: 'Access token rejected',
  REFRESH_REUSE_DETECTED: 'Refresh token reuse detected',
  FORBIDDEN: 'Not allowed for this tenant role',
  NOT_FOUND: 'Resource not found',
  CONFLICT: 'Conflict',
  TENANT_NOT_FOUND: 'Tenant not found',
  TENANT_MEMBERSHIP_REQUIRED: 'Tenant membership required',
  QUOTA_EXCEEDED: 'Plan quota exceeded',
  PLAN_LIMIT_EXCEEDED: 'Plan limit exceeded',
  RATE_LIMITED: 'Too many requests',
  IDEMPOTENCY_CONFLICT: 'Idempotency key reused with a different payload',
  PRECONDITION_REQUIRED: 'Precondition required',
  PRECONDITION_FAILED: 'Precondition failed',
  PAYLOAD_TOO_LARGE: 'Payload too large',
  UNSUPPORTED_MEDIA_TYPE: 'Unsupported media type',
  DB_UNAVAILABLE: 'Database unavailable',
  CACHE_UNAVAILABLE: 'Cache unavailable',
  QUEUE_UNAVAILABLE: 'Queue unavailable',
  DEPENDENCY_FAILURE: 'Dependency failure',
  TIMEOUT: 'Upstream timeout',
  INTERNAL: 'Internal server error',
};

export function titleFor(code: ErrorCode): string {
  return TITLES[code];
}

export const badRequest = (msg = 'Malformed request', details?: Record<string, unknown>) =>
  new AppError('BAD_REQUEST', msg, 400, { details });

export const validationFailed = (
  errors: Array<{ path: string; message: string }>,
  msg = 'Request body/params/query did not validate',
) => new AppError('VALIDATION_FAILED', msg, 422, { details: { errors } });

export const unauthenticated = (msg = 'Missing or invalid Authorization header') =>
  new AppError('UNAUTHENTICATED', msg, 401);

export const forbidden = (msg = 'Insufficient role for this tenant') =>
  new AppError('FORBIDDEN', msg, 403);

export const notFound = (what = 'Resource') => new AppError('NOT_FOUND', `${what} not found`, 404);

export const conflict = (msg = 'Conflict', details?: Record<string, unknown>) =>
  new AppError('CONFLICT', msg, 409, details ? { details } : undefined);

export const tenantNotFound = (hint = 'Unknown tenant') =>
  new AppError('TENANT_NOT_FOUND', hint, 404);

export const membershipRequired = (msg = 'Caller is not an active member of this tenant') =>
  new AppError('TENANT_MEMBERSHIP_REQUIRED', msg, 403);

export const quotaExceeded = (msg = 'Plan quota exceeded') =>
  new AppError('QUOTA_EXCEEDED', msg, 402);

export const rateLimited = (retryAfterMs: number, msg = 'Rate limit exceeded') =>
  new AppError('RATE_LIMITED', msg, 429, {
    headers: { 'retry-after': String(Math.max(1, Math.ceil(retryAfterMs / 1000))) },
    details: { retryAfterMs },
  });

export const idempotencyConflict = (
  msg = 'Idempotency-Key was already used with a different request body',
) => new AppError('IDEMPOTENCY_CONFLICT', msg, 409);

export const preconditionRequired = (
  msg = 'This write requires an If-Match precondition',
  details?: Record<string, unknown>,
) => new AppError('PRECONDITION_REQUIRED', msg, 428, details ? { details } : undefined);

/** 412 — the caller named a version, and it is not the current one. */
export const preconditionFailed = (
  msg = 'If-Match did not match the current resource version',
  details?: Record<string, unknown>,
) => new AppError('PRECONDITION_FAILED', msg, 412, details ? { details } : undefined);

export const dbUnavailable = (msg = 'Database is not accepting queries', cause?: unknown) =>
  new AppError('DB_UNAVAILABLE', msg, 503, { cause, expose: false });

export const internal = (msg = 'Internal server error', cause?: unknown) =>
  new AppError('INTERNAL', msg, 500, { cause, expose: false });

export function isAppError(err: unknown): err is AppError {
  return err instanceof AppError;
}

/** Best-effort extraction for logging/error mapping of foreign errors. */
export function describeError(err: unknown): {
  name: string;
  message: string;
  code?: string;
  stack?: string;
} {
  if (err instanceof Error) {
    const anyErr = err as Error & { code?: string; syscall?: string };
    return {
      name: anyErr.name,
      message: anyErr.message,
      code: anyErr.code ?? anyErr.syscall,
      stack: anyErr.stack,
    };
  }
  return { name: 'Unknown', message: String(err) };
}
