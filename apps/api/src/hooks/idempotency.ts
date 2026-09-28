import { badRequest, conflict, idempotencyConflict } from '@saas/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { IDEMPOTENCY_HEADER } from '../config/constants.js';

/**
 * `Idempotency-Key` support for POSTs (Stripe-shaped, which is what clients
 * already implement):
 *
 *   preHandler  → look the key up; replay a stored response verbatim, 409 if it
 *                 is still in flight, 409 if the same key carries a different
 *                 body;
 *   onSend      → settle the key: store (status + body) for 2xx/4xx, release on
 *               5xx. The Redis write is the fast path, Postgres the durable one.
 *
 * 5xx responses are deliberately *not* recorded: a server-side bug must remain
 * retryable, otherwise one bad deploy permanently poisons those keys.
 */
export function registerIdempotency(app: FastifyInstance): void {
  app.addHook('preHandler', async (req: FastifyRequest, reply: FastifyReply) => {
    const mode = req.routeOptions.config.idempotency;
    if (!mode) {
      return;
    }
    const raw = req.headers[IDEMPOTENCY_HEADER];
    const key = Array.isArray(raw) ? raw[0] : raw;

    if (!key) {
      // 400 for 'required' only: a client that believes it is safe to retry must
      // be told when it forgot the key. 'optional' endpoints exist so that a
      // simple client is not forced to invent a key store to do a first write.
      if (mode === 'required') {
        throw badRequest(`This endpoint requires an ${IDEMPOTENCY_HEADER} header`);
      }
      return;
    }
    if (key.length < 8 || key.length > 128 || !/^[A-Za-z0-9._:-]+$/.test(key)) {
      throw badRequest('Idempotency-Key must be 8-128 characters of [A-Za-z0-9._:-]');
    }

    req.idempotencyKey = key;
    const outcome = await app.idempotency.lookup(req, key);

    switch (outcome.kind) {
      case 'replay':
        req.log.info({ idempotencyKey: key }, 'replaying idempotent response');
        reply.header('idempotency-replay', 'true');
        // Hand the stored answer back unchanged; the handler never runs.
        return reply.code(outcome.status).send(outcome.body);
      case 'conflict':
        throw idempotencyConflict();
      case 'inflight':
        reply.header('retry-after', '2');
        throw conflict('A request with this Idempotency-Key is still running');
      case 'new':
      default: {
        // Claim it now, outside the business transaction: the alternative
        // (reserve inside the handler's tx) couples every POST to one specific
        // transaction shape. A crash between claim and completion is bounded by
        // the TTL, and the `onResponse` hook releases on 5xx.
        const claimed = await app.idempotency.reserve(req, key);
        if (!claimed) {
          const again = await app.idempotency.lookup(req, key);
          if (again.kind === 'replay') {
            reply.header('idempotency-replay', 'true');
            return reply.code(again.status).send(again.body);
          }
          reply.header('retry-after', '2');
          throw conflict('A request with this Idempotency-Key is still running');
        }
        return undefined;
      }
    }
  });

  /**
   * The reply is settled here rather than in `onResponse`, on purpose: `onSend`
   * receives the *final serialized* payload (so the stored response is exactly
   * what a replay must return, byte for byte) and it always runs, while
   * `onResponse` is skipped whenever a reply is hijacked — which is what a
   * compression/streaming plugin may do. Recording the key from `onSend` costs a
   * little durability (the write happens before the client has the answer, so a
   * crash in between leaves the key unreplayable and the retry re-executes);
   * recovering in `onResponse` would cost correctness on every hijacked reply,
   * and a silently-never-recorded key is the worse failure.
   */
  app.addHook('onSend', async (req: FastifyRequest, reply: FastifyReply, payload) => {
    const key = req.idempotencyKey;
    if (key) {
      if (!req.idempotencyReserved) {
        // Either a replay of a stored response or one of the pre-handler
        // conflicts (in-flight / key-reuse). Neither is the *operation's*
        // outcome, so recording it would poison the key: a client that retries
        // the request whose 409 we stored would get that 409 forever.
        return payload;
      }
      if (reply.statusCode >= 500) {
        // Free the key: a server-side bug must stay retryable.
        void app.idempotency
          .release(req, key)
          .catch((err: unknown) =>
            req.log.warn({ err: String(err) }, 'idempotency release failed'),
          );
      } else {
        const body = parseMaybeJson(payload);
        void app.idempotency
          .record(req, key, reply.statusCode, body)
          .catch((err: unknown) => req.log.warn({ err: String(err) }, 'idempotency record failed'));
      }
    }
    return payload;
  });
}

/** The payload reaching `onSend` is normally the serialized JSON string; a stream
 *  or Buffer is stored as-is so a replay still returns identical bytes. */
function parseMaybeJson(payload: unknown): unknown {
  if (typeof payload !== 'string' || payload.length === 0) {
    return payload ?? null;
  }
  try {
    return JSON.parse(payload) as unknown;
  } catch {
    return payload;
  }
}
