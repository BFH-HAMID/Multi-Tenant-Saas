import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Broker } from './broker.js';
import type { Relay } from './relay.js';
import type { WorkerMetrics } from './metrics.js';
import type { Database } from '@saas/db';

/**
 * The worker's internal listener: `/metrics`, the three probes, and a tiny
 * dead-letter API.
 *
 * Plain `node:http` on a separate port, deliberately not Fastify:
 *
 *   - the scrape endpoint has one job, and a framework would add a second
 *     request pipeline whose latency the HPA would then read as worker load;
 *   - nothing here is exposed through the ingress. Probes come from kubelet and
 *     metrics from Prometheus, both in-cluster; the DLQ endpoints exist so an
 *     operator with `kubectl port-forward` can drain a backlog without exec'ing
 *     into a pod, and they are therefore *read-mostly* and rate-free — which is
 *     only acceptable because the port is not routable from outside the cluster.
 *
 * Readiness is the interesting one: a worker that cannot reach Postgres is not
 * "unready" in the API's sense (it holds no user-facing socket), but if it is
 * *also* not consuming, a rolling update must not remove the pods that still
 * are. So /readyz is "db reachable AND (relay running OR broker connected)",
 * which keeps the Deployment from ending up with zero consumers during a rollout
 * into a Postgres failover.
 */
export interface InternalDeps {
  metrics: WorkerMetrics;
  db: Database;
  relay: Relay;
  broker: Broker | null;
  version: string;
  readinessStaleMs: number;
  log: {
    info(o: object, m?: string): void;
    warn(o: object, m?: string): void;
    error(o: object, m?: string): void;
  };
  onProbe?: () => Promise<void>;
}

export interface InternalServer {
  server: Server;
  listen(port: number, host: string): Promise<void>;
  close(): Promise<void>;
}

export function createInternalServer(deps: InternalDeps): InternalServer {
  const started = Date.now();
  let lastProbeOk = true;
  let lastProbeAt = 0;

  const probe = async (): Promise<{ ok: boolean; latencyMs: number; error?: string }> => {
    if (Date.now() - lastProbeAt > 5_000) {
      const h = await deps.db.healthcheck();
      lastProbeOk = h.ok;
      lastProbeAt = Date.now();
      void deps.onProbe?.().catch(() => undefined);
      return h;
    }
    return { ok: lastProbeOk, latencyMs: Date.now() - lastProbeAt };
  };

  const send = (
    res: ServerResponse,
    status: number,
    body: string,
    type = 'application/json; charset=utf-8',
  ): void => {
    res.writeHead(status, {
      'content-type': type,
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    });
    res.end(body);
  };

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://internal');
    const path = url.pathname;
    void (async () => {
      switch (path) {
        case '/livez':
          // Liveness must never depend on a dependency: a Postgres outage that
          // makes /livez fail turns a database incident into a pod-restart storm.
          return send(
            res,
            200,
            JSON.stringify({ ok: true, uptimeSec: Math.round((Date.now() - started) / 1000) }),
          );
        case '/healthz':
        case '/readyz': {
          const health = await probe();
          const relay = deps.relay.stats();
          const consuming = deps.broker !== null || relay.running;
          const ok = health.ok && consuming;
          const body = {
            ok,
            checks: {
              db: {
                ok: health.ok,
                latencyMs: health.latencyMs,
                ...(health.error ? { error: health.error } : {}),
              },
              relay: {
                running: relay.running,
                ticks: relay.ticks,
                claimed: relay.claimed,
                errors: relay.errors,
                lastTickMs: Math.round(relay.lastTickMs),
              },
              broker: deps.broker
                ? { driver: 'bullmq', depth: await deps.broker.dlqDepth().catch(() => -1) }
                : { driver: 'outbox' },
            },
          };
          deps.metrics.ready.set(ok ? 1 : 0);
          return send(res, ok ? 200 : 503, JSON.stringify(body));
        }
        case '/metrics': {
          const body = await deps.metrics.registry.metrics();
          return send(res, 200, body, 'text/plain; version=0.0.4; charset=utf-8');
        }
        case '/dlq': {
          if (!deps.broker) {
            return send(
              res,
              200,
              JSON.stringify({
                mode: 'outbox',
                note: 'no broker in this deployment; the dead-letter set is `outbox.status = discarded`',
                rows: await outboxDeadLetters(deps.db).catch(() => []),
              }),
            );
          }
          const limit = Number(url.searchParams.get('limit') ?? 25);
          const rows = await deps.broker.listDeadLetters(Number.isFinite(limit) ? limit : 25);
          return send(
            res,
            200,
            JSON.stringify({ mode: 'bullmq', rows, depth: await deps.broker.dlqDepth() }),
          );
        }
        case '/dlq/replay': {
          if (req.method !== 'POST') {
            return send(res, 405, JSON.stringify({ error: 'method-not-allowed' }));
          }
          if (!deps.broker) {
            return send(
              res,
              409,
              JSON.stringify({
                error: 'replay-requires-bullmq',
                note: 'in outbox mode, reset the rows: UPDATE outbox SET status=$$pending$$, attempts=0 WHERE status=$$discarded$$',
              }),
            );
          }
          const raw = await readBody(req);
          const ids = (JSON.parse(raw || '{}') as { ids?: string[] }).ids ?? [];
          if (!Array.isArray(ids) || ids.length === 0 || ids.length > 500) {
            return send(
              res,
              422,
              JSON.stringify({ error: 'ids must be a non-empty array (max 500)' }),
            );
          }
          const n = await deps.broker.replayDeadLetters(ids.map(String));
          deps.log.info({ replayed: n }, 'dead-letter replay requested');
          return send(res, 200, JSON.stringify({ replayed: n }));
        }
        default:
          return send(
            res,
            404,
            JSON.stringify({
              error: 'not-found',
              routes: ['/livez', '/healthz', '/readyz', '/metrics', '/dlq', '/dlq/replay'],
            }),
          );
      }
    })().catch((err: unknown) => {
      deps.metrics.errors.inc({ where: 'internal' });
      send(
        res,
        500,
        JSON.stringify({
          error: 'internal',
          detail: String(err instanceof Error ? err.message : err),
        }),
      );
    });
  });

  server.keepAliveTimeout = 5_000;
  server.headersTimeout = 10_000;

  return {
    server,
    listen(port, host) {
      return new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => resolve());
      });
    },
    close() {
      return new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      });
    },
  };
}

async function outboxDeadLetters(db: Database): Promise<Array<Record<string, unknown>>> {
  // `discarded` rows are only visible to their tenant (RLS), so the internal
  // endpoint reports the count the database will share and points at the tool
  // that can see everything: the migration/admin role.
  const res = await db.query<{
    pending: string;
    failed: string;
    discarded: string;
    oldest: string;
  }>(
    'SELECT pending::text, failed::text, discarded::text, oldest_pending_seconds::text FROM app.outbox_depth',
  );
  const row = res.rows[0] ?? { pending: '0', failed: '0', discarded: '0', oldest: '0' };
  return [{ summary: row }];
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 64 * 1024) {
      throw new Error('body too large');
    }
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}
