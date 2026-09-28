import type { FastifyRequest } from 'fastify';
import { z, type ZodType } from 'zod';

/**
 * Zod-based validation helpers, called at the top of each handler.
 *
 * Why not Fastify's JSON-Schema validator: these DTOs are shared with the
 * worker, the tests and eventually the web client, and they need
 * *transformations* (trim, lowercase email, clamp `limit`, apply defaults) that
 * JSON Schema cannot express. One zod schema in `@saas/shared` therefore covers
 * the request shape everywhere it appears.
 *
 * Why parse inside the handler instead of a global preHandler hook: the schema
 * is right next to the code that uses the typed result, so a route cannot be
 * added "without validation" by accident — the parameter is required.
 * A `ZodError` thrown here is turned into a 422 + per-field list by
 * `registerErrorHandlers`, so nothing else needs to know about zod.
 */

export function readBody<T>(req: FastifyRequest, schema: ZodType<T>): T {
  return schema.parse(req.body ?? {});
}

export function readQuery<T>(req: FastifyRequest, schema: ZodType<T>): T {
  return schema.parse(req.query ?? {});
}

export function useParams<T>(req: FastifyRequest, schema: ZodType<T>): T {
  return schema.parse(req.params ?? {});
}

/**
 * Turn a zod schema into the JSON Schema that goes into the published OpenAPI
 * document. Draft-7 is what `@fastify/swagger` expects; `unrepresentable: 'any'`
 * keeps a transform-bearing field (e.g. a clamped `limit`) from failing the whole
 * build — it renders as an empty schema, which is honest about being unconstrained.
 *
 * This is documentation only: validation itself is done by the `read*` helpers
 * above, via `passthroughValidatorCompiler`, so the two can never disagree about
 * what is accepted — only about how precisely the document describes it.
 */
export function doc(schema: ZodType): Record<string, unknown> {
  return z.toJSONSchema(schema, { target: 'draft-7', unrepresentable: 'any' }) as Record<
    string,
    unknown
  >;
}
