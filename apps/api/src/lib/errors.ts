import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ZodError } from 'zod';
import { AppError, describeError, isAppError, titleFor, type ProblemDetails } from '@saas/shared';
import { mapPgError } from '@saas/db';

/**
 * One error path for the whole API, producing `application/problem+json`.
 *
 * Mapping order (first match wins), and each step exists because of a concrete
 * failure mode we do not want to log as a 500:
 *   1. AppError          → its own status/code.
 *   2. ZodError          → 422 with per-field messages (validation is a client bug,
 *                          not a server error; conflating them poisons the 5xx alert).
 *   3. Fastify 4xx       → body/schema errors (FST_ERR_VALIDATION, 415, 413) → 400-class.
 *   4. Postgres SQLSTATE → via mapPgError: 23505→409, 23514→402, 42501→403,
 *                          40001→409, 57014→504, connection codes→503. This is how a
 *                          RLS denial stays a 403 instead of a 500, which matters for
 *                          both the client contract and the alert routing.
 *   5. everything else   → 500, message replaced by a generic one, stack logged.
 */
export function registerErrorHandlers(app: FastifyInstance): void {
  app.setErrorHandler(
    async (err: FastifyError | Error, req: FastifyRequest, reply: FastifyReply) => {
      const problem = toProblem(err, req);
      const log = req.log;

      if (problem.status >= 500) {
        log.error(
          {
            err: describeError(err),
            status: problem.status,
            code: problem.code,
            route: req.routeOptions?.url,
          },
          'request failed',
        );
      } else if (problem.status === 429) {
        log.debug({ code: problem.code, retryAfter: problem.retryAfter }, 'rate limited');
      } else {
        log.warn(
          {
            status: problem.status,
            code: problem.code,
            detail: problem.detail,
            // When a Postgres error was mapped into a 4xx, its SQLSTATE has to stay
            // in the log: an RLS denial surfaced as "Missing tenant context" is
            // otherwise undiagnosable in production, and 42501 vs 23505 vs 23514
            // are three different incidents with three different owners.
            ...pgContext(err),
          },
          'request rejected',
        );
      }

      for (const [k, v] of Object.entries(headersFor(err))) {
        reply.header(k, v);
      }
      if (req.requestId) {
        reply.header('x-request-id', req.requestId);
      }

      return reply.type('application/problem+json').code(problem.status).send(problem);
    },
  );

  app.setNotFoundHandler((req: FastifyRequest, reply: FastifyReply) => {
    const problem: ProblemDetails = {
      type: 'https://docs.saas.dev/errors/not-found',
      title: 'Resource not found',
      status: 404,
      code: 'NOT_FOUND',
      detail: `No route matches ${req.method} ${req.url.split('?')[0]}`,
      requestId: req.requestId,
    };
    return reply.type('application/problem+json').code(404).send(problem);
  });
}

interface PgShaped {
  code?: string;
  message?: string;
  where?: string;
  routine?: string;
}

/**
 * Pull the SQLSTATE diagnostics out of either a raw `pg` error or an AppError
 * that wrapped one. `where`/`routine` are the fields that say *which trigger or
 * policy* rejected the statement, which is the difference between "the API set
 * the wrong GUC" and "this role genuinely lacks a grant".
 */
function pgContext(err: unknown): Record<string, string> {
  const e = err as PgShaped & { cause?: PgShaped };
  const src = typeof e?.code === 'string' && /^[0-9A-Z]{5}$/.test(e.code) ? e : e?.cause;
  if (!src?.code) {
    return {};
  }
  return {
    pgCode: src.code,
    pgMessage: String(src.message ?? '').slice(0, 300),
    ...(src.where ? { pgWhere: String(src.where).split('\n').slice(0, 3).join(' | ') } : {}),
    ...(src.routine ? { pgRoutine: src.routine } : {}),
  };
}

export function toProblem(err: unknown, req: FastifyRequest): ProblemDetails {
  const base = {
    requestId: req.requestId,
    tenantId: req.tenant?.id,
  };

  if (isAppError(err)) {
    const problem = err.toProblem();
    return { ...problem, ...base, instance: req.url.split('?')[0] };
  }

  if (err instanceof ZodError) {
    return {
      type: 'https://docs.saas.dev/errors/validation-failed',
      title: titleFor('VALIDATION_FAILED'),
      status: 422,
      code: 'VALIDATION_FAILED',
      detail: 'Request did not validate',
      errors: err.issues.map((issue) => ({
        path: issue.path.join('.') || '(root)',
        message: issue.message,
      })),
      ...base,
    };
  }

  const fastifyErr = err as FastifyError;
  if (fastifyErr.code === 'FST_ERR_VALIDATION') {
    return {
      type: 'https://docs.saas.dev/errors/validation-failed',
      title: titleFor('VALIDATION_FAILED'),
      status: 400,
      code: 'VALIDATION_FAILED',
      detail: stripAjvDetails(fastifyErr.message),
      ...base,
    };
  }
  if (fastifyErr.code === 'FST_ERR_CTP_INVALID_MEDIA_TYPE' || fastifyErr.statusCode === 415) {
    return {
      type: 'https://docs.saas.dev/errors/unsupported-media-type',
      title: titleFor('UNSUPPORTED_MEDIA_TYPE'),
      status: 415,
      code: 'UNSUPPORTED_MEDIA_TYPE',
      detail: 'Content-Type must be application/json',
      ...base,
    };
  }
  if (fastifyErr.code === 'FST_ERR_CTP_BODY_TOO_LARGE' || fastifyErr.statusCode === 413) {
    return {
      type: 'https://docs.saas.dev/errors/payload-too-large',
      title: titleFor('PAYLOAD_TOO_LARGE'),
      status: 413,
      code: 'PAYLOAD_TOO_LARGE',
      detail: 'Request body exceeds the configured limit',
      ...base,
    };
  }

  const mapped = mapPgError(err);
  if (mapped) {
    return {
      type: `https://docs.saas.dev/errors/${mapped.code.toLowerCase()}`,
      title: titleFor(mapped.code as never),
      status: mapped.statusCode,
      code: mapped.code as never,
      // 503 keeps a generic message; 4xx/402/409 messages come from SQLSTATE and
      // are safe (our RAISE texts never contain data values).
      detail: mapped.statusCode >= 500 ? undefined : mapped.message,
      ...base,
    };
  }

  return {
    type: 'https://docs.saas.dev/errors/internal',
    title: titleFor('INTERNAL'),
    status: 500,
    code: 'INTERNAL',
    ...base,
  };
}

function headersFor(err: unknown): Record<string, string> {
  if (err instanceof AppError && err.headers) {
    return err.headers;
  }
  if ((err as { code?: string }).code === 'FST_ERR_CTP_BODY_TOO_LARGE') {
    return {};
  }
  return {};
}

/** Fastify's Ajv messages embed the schema; drop it, keep the human part. */
function stripAjvDetails(message: string): string {
  return message.replace(/must have.*$/, 'failed schema validation').slice(0, 300);
}
