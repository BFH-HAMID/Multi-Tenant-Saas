import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';

export type LookupResult =
  | { kind: 'new' }
  | { kind: 'replay'; status: number; body: unknown }
  | { kind: 'inflight' }
  | { kind: 'conflict' };

const INFLIGHT_MARKER = '__inflight__';

/**
 * Idempotency for non-idempotent POSTs (the client retried because the network
 * ate the response, or a user double-clicked "generate report").
 *
 * Two tiers, because the guarantees differ:
 *   - Redis (`t:{tenant}:idm:{key}`) is the fast path: a retry landing within
 *     seconds of the original never touches Postgres, and it is where the
 *     in-flight marker lives (so concurrent duplicates are cheap to reject);
 *   - Postgres `idempotency_keys` is the durable path: it survives a Redis flush
 *     or restart, and it stores the response for replays after the Redis TTL.
 *
 * Semantics (Stripe-shaped, which is what clients already implement):
 *   - same key + same request fingerprint → replay the stored response verbatim,
 *     the handler never runs;
 *   - same key + different body → 409 IDEMPOTENCY_CONFLICT (a client bug;
 *     silently replaying the first answer would corrupt the caller's state);
 *   - key reserved, request still running → 409 + `Retry-After: 2`;
 *   - a 5xx *releases* the reservation, so a server-side bug never permanently
 *     poisons a key; the stored TTL bounds how long an abandoned reservation
 *     lasts if the process dies mid-request.
 */
export class IdempotencyService {
  constructor(private readonly app: FastifyInstance) {}

  private get ttlMs(): number {
    return this.app.cfg.env.IDEMPOTENCY_TTL_MS;
  }

  async lookup(req: FastifyRequest, key: string): Promise<LookupResult> {
    const tenantId = req.tenant!.id;
    const fingerprint = requestFingerprint(req);

    const fast = await this.app.cache.rawGet(`idm:${tenantId}:${key}`);
    if (fast !== undefined) {
      if (fast === INFLIGHT_MARKER) {
        return { kind: 'inflight' };
      }
      try {
        const parsed = JSON.parse(fast) as { h: string; s: number; b: unknown };
        if (parsed.h !== fingerprint) {
          return { kind: 'conflict' };
        }
        return { kind: 'replay', status: parsed.s, body: parsed.b };
      } catch {
        await this.app.cache.rawDel(`idm:${tenantId}:${key}`);
      }
    }

    const { rows } = await this.app.db.query<{
      state: string;
      response_status: number | null;
      response_body: unknown;
    }>('SELECT * FROM app.idempotency_lookup($1,$2,$3)', [tenantId, key, fingerprint]);
    const row = rows[0];
    if (!row) {
      return { kind: 'new' };
    }
    switch (row.state) {
      case 'replay':
        return {
          kind: 'replay',
          status: Number(row.response_status ?? 200),
          body: row.response_body,
        };
      case 'inflight':
        return { kind: 'inflight' };
      case 'conflict':
        return { kind: 'conflict' };
      default:
        return { kind: 'new' };
    }
  }

  /** Claim the key. `false` means someone else owns it (retry/concurrency). */
  async reserve(req: FastifyRequest, key: string): Promise<boolean> {
    const tenantId = req.tenant!.id;
    const fingerprint = requestFingerprint(req);
    const { rows } = await this.app.db.query<{ ok: boolean }>(
      'SELECT app.idempotency_reserve($1,$2,$3,$4) AS ok',
      [tenantId, key, fingerprint, Math.ceil(this.ttlMs / 1000)],
    );
    const claimed = rows[0]?.ok === true;
    req.idempotencyReserved = claimed;
    if (claimed) {
      await this.app.cache.rawSet(`idm:${tenantId}:${key}`, INFLIGHT_MARKER, 60_000);
    }
    this.app.metrics.idempotency.inc({ outcome: claimed ? 'reserved' : 'busy' });
    return claimed;
  }

  /** Persist the response for future replays. Best-effort, called from onResponse. */
  async record(req: FastifyRequest, key: string, status: number, body: unknown): Promise<void> {
    const tenantId = req.tenant!.id;
    const payload = JSON.stringify({ h: requestFingerprint(req), s: status, b: body });

    await this.app.cache.rawSet(`idm:${tenantId}:${key}`, payload, Math.min(this.ttlMs, 3_600_000));

    try {
      await this.app.db.query('SELECT app.idempotency_complete($1,$2,$3,$4::jsonb)', [
        tenantId,
        key,
        status,
        JSON.stringify(body ?? null),
      ]);
    } catch (err) {
      // The response is already with the client. A missing durable record means
      // a much-later retry re-executes; the outbox key still dedupes its side
      // effects, so the queue-level guarantee holds regardless.
      req.log.debug({ err: String(err) }, 'idempotency durable record failed');
    }
    this.app.metrics.idempotency.inc({ outcome: 'recorded' });
  }

  async release(req: FastifyRequest, key: string): Promise<void> {
    const tenantId = req.tenant!.id;
    await this.app.cache.rawDel(`idm:${tenantId}:${key}`);
    try {
      await this.app.db.query('SELECT app.idempotency_release($1,$2)', [tenantId, key]);
    } catch (err) {
      req.log.debug({ err: String(err) }, 'idempotency release failed');
    }
    this.app.metrics.idempotency.inc({ outcome: 'released' });
  }
}

/**
 * The fingerprint covers method + path + body. Headers are deliberately
 * excluded except through the body: authorisation and trace headers change every
 * retry, and a key that only replays when *everything* matched is not an
 * idempotency key, it is a cache miss generator.
 */
function requestFingerprint(req: FastifyRequest): string {
  const body = req.body === undefined ? '' : JSON.stringify(req.body);
  return createHash('sha256')
    .update(`${req.method} ${req.url.split('?')[0]}\n${body}`, 'utf8')
    .digest('hex')
    .slice(0, 32);
}
