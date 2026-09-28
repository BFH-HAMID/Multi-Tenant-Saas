import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { REQUEST_ID_HEADER } from '../config/constants.js';

/**
 * Correlation, before anything else can fail:
 *   - trust an inbound `x-request-id` only if it looks like ours (a client that
 *     sends `../../etc/passwd` as a request id must not have it echoed into logs
 *     and into the response header),
 *   - bind `requestId` into the child logger so every line of the request is
 *     greppable by one token,
 *   - echo it on the response so a user can quote it.
 *
 * Also stamps `startedAt` for the access log, which measures the whole
 * lifecycle (queueing in the HTTP server included) unlike the app-level timer.
 */
const SAFE_REQUEST_ID = /^[A-Za-z0-9._~-]{8,64}$/;

export function registerRequestContext(app: FastifyInstance): void {
  app.addHook('onRequest', (req, reply, done) => {
    const incoming = req.headers[REQUEST_ID_HEADER];
    const candidate = Array.isArray(incoming) ? incoming[0] : incoming;
    req.requestId = candidate && SAFE_REQUEST_ID.test(candidate) ? candidate : randomUUID();
    reply.header(REQUEST_ID_HEADER, req.requestId);
    req.log = req.log.child({ requestId: req.requestId });
    done();
  });
}
