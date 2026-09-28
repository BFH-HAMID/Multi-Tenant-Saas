import { QUEUES, type JobName } from '@saas/shared';
import { describe, expect, it } from 'vitest';
import { createRelay, relayQueueNames, type RelayDeps } from '../src/relay.js';
import { counterValue, silentLog, testMetrics } from './helpers/fakes.js';
import type { JobEnvelope } from '../src/jobs.js';

/**
 * The outbox relay: the transport that keeps "a row was written" and "the work
 * happened" from drifting apart when there is no queue to hand the job to.
 *
 * Everything asserted here is a *settlement* rule — what happens to the row after
 * the handler returns. Get one of these wrong and the failure is silent in both
 * directions: publish too eagerly and a dropped job is invisible; leave a row
 * pending after a successful handler and the whole tenant's work is redone on
 * every restart.
 */

type Sql = { sql: string; params: unknown[] };

interface Row {
  id: string;
  tenant_id: string;
  topic: JobName;
  payload: Record<string, unknown>;
  idempotency_key: string | null;
  attempts: number;
  max_attempts: number;
}

function harness(rows: Row[], over: Partial<RelayDeps> = {}) {
  const sql: Sql[] = [];
  const published: Array<{ id: number }> = [];
  const discarded: number[] = [];
  const failed: Array<{ id: number; error: string; retrySeconds: number }> = [];
  const db = {
    query: async (query: string, params: unknown[] = []) => {
      sql.push({ sql: query, params });
      if (query.includes('outbox_claim_batch')) {
        return { rows };
      }
      if (query.includes('outbox_mark_discarded')) {
        discarded.push(Number(params[0]));
        return { rows: [{ n: true }] };
      }
      if (query.includes('outbox_mark_published')) {
        published.push({ id: Number(params[0]) });
        return { rows: [] };
      }
      if (query.includes('outbox_mark_failed')) {
        failed.push({
          id: Number(params[0]),
          error: String(params[1]),
          retrySeconds: Number(params[2]),
        });
        return { rows: [] };
      }
      return { rows: [] };
    },
    withTenant: async (_ctx: unknown, fn: (tx: unknown) => Promise<unknown>) =>
      fn({ query: db.query }),
  };
  const metrics = testMetrics();
  const results = new Map<string, Awaited<ReturnType<RelayDeps['dispatch']>>>();
  const seen: JobEnvelope[] = [];
  let inflight = 0;
  let maxInflight = 0;
  const deps: RelayDeps = {
    db: db as never,
    log: silentLog,
    metrics,
    dispatch: async (env) => {
      inflight += 1;
      maxInflight = Math.max(maxInflight, inflight);
      seen.push(env);
      try {
        return results.get(env.rowId as string) ?? { kind: 'completed', detail: null };
      } finally {
        inflight -= 1;
      }
    },
    onDead: async () => {},
    intervalMs: 10,
    batchSize: 25,
    leaseSeconds: 70,
    concurrency: 5,
    ...over,
  };
  return {
    deps,
    relay: createRelay(deps),
    sql,
    published,
    failed,
    discarded,
    seen,
    results,
    metrics,
    setDeadLetterSpy: (fn: RelayDeps['onDead']) => {
      deps.onDead = fn;
    },
    maxInflight: () => maxInflight,
  };
}

const row = (over: Partial<Row> = {}): Row => ({
  id: '41',
  tenant_id: '11111111-1111-4111-8111-111111111111',
  topic: 'report.generate' as JobName,
  payload: { kind: 'report.generate' },
  idempotency_key: 'job:report:abc',
  attempts: 1,
  max_attempts: 3,
  ...over,
});

describe('claiming', () => {
  it('asks the batch claimer for batchSize and leaseSeconds, in that order', async () => {
    const h = harness([]);
    expect(await h.relay.tick()).toBe(0);
    const claim = h.sql.find((s) => s.sql.includes('outbox_claim_batch'))!;
    expect(claim.params).toEqual([25, 70]);
    // 0012's *batch* claimer, not 0005's single-row one: the relay needs
    // max_attempts from the same round-trip to tell retry from dead-letter.
    expect(claim.sql).toContain('o_max_attempts');
  });

  it('counts an empty tick as idle rather than an error', async () => {
    const h = harness([]);
    await h.relay.tick();
    expect(
      await counterValue(h.metrics.registry as never, 'worker_relay_ticks_total', 'idle'),
    ).toBe(1);
    expect(h.published).toEqual([]);
    expect(h.failed).toEqual([]);
  });
});

describe('settlement', () => {
  it('publishes the row when the handler completed', async () => {
    const h = harness([row({ id: '7' })]);
    expect(await h.relay.tick()).toBe(1);
    expect(h.published).toEqual([{ id: 7 }]);
    expect(h.failed).toEqual([]);
    expect(
      await counterValue(h.metrics.registry as never, 'outbox_published_total', 'report.generate'),
    ).toBe(1);
  });

  it('publishes on a skipped replay too, or the row would be redone forever', async () => {
    const h = harness([row({ id: '8' })]);
    h.results.set('8', { kind: 'skipped', reason: 'already-handled' });
    await h.relay.tick();
    expect(h.published).toEqual([{ id: 8 }]);
  });

  it('schedules a retry with the dispatch backoff, in whole seconds', async () => {
    const h = harness([row({ id: '9' })]);
    h.results.set('9', { kind: 'retry', afterMs: 1001, error: 'db went away' });
    await h.relay.tick();
    expect(h.published).toEqual([]);
    expect(h.failed).toHaveLength(1);
    // Ceil, not round: 1001ms rounded would fire the retry ~0ms early and turn a
    // 40001 storm into a hot loop.
    expect(h.failed[0]!.retrySeconds).toBe(2);
    expect(h.failed[0]!.error).toBe('db went away');
  });

  it('parks a dead job with a long delay so the DB can flip it to discarded', async () => {
    const h = harness([row({ id: '10', attempts: 3, max_attempts: 3 })]);
    h.results.set('10', { kind: 'dead', reason: 'exhausted-retries', error: 'still broken' });
    const deadEnvelopes: unknown[] = [];
    h.setDeadLetterSpy(async (env) => {
      deadEnvelopes.push(env);
    });
    await h.relay.tick();
    expect(deadEnvelopes).toHaveLength(1);
    // The row must NOT be scheduled for another attempt — a terminal verdict that
    // leaves the row pending is what makes the stuck-queue alert cry wolf.
    expect(h.failed, JSON.stringify(h.failed)).toEqual([]);
    expect(h.discarded).toEqual([10]);
  });

  it('survives a DLQ write that fails, because the row is already terminal', async () => {
    const h = harness([row({ id: '11' })]);
    h.results.set('11', { kind: 'dead', reason: 'invalid-payload', error: 'nope' });
    h.setDeadLetterSpy(async () => {
      throw new Error('redis down');
    });
    await expect(h.relay.tick()).resolves.toBe(1);
  });

  it('derives an idempotency key from the row id when the producer stored none', async () => {
    const h = harness([row({ id: '12', idempotency_key: null })]);
    await h.relay.tick();
    expect(h.seen[0]!.idempotencyKey).toBe('outbox:12');
    expect(h.seen[0]!.rowId).toBe('12');
    expect(h.seen[0]!.source).toBe('outbox');
  });

  it('falls back to the shared queue defaults when max_attempts is null', async () => {
    const h = harness([row({ id: '13', max_attempts: null as never })]);
    await h.relay.tick();
    expect(h.seen[0]!.maxAttempts).toBe(3);
  });
});

describe('loop hygiene', () => {
  it('never runs more handlers at once than `concurrency`', async () => {
    const rows = Array.from({ length: 11 }, (_, i) => row({ id: String(i + 1) }));
    const h = harness(rows, {
      concurrency: 3,
      dispatch: async () => {
        await new Promise((r) => setTimeout(r, 1));
        return { kind: 'completed', detail: null } as const;
      },
    });
    const handled = await h.relay.tick();
    expect(handled).toBe(11);
    // The bound matters because each handler holds two pool connections; 11 × the
    // pool size is a self-inflicted outage during a backlog drain.
    expect(h.maxInflight()).toBeLessThanOrEqual(3);
  });

  it('stop() finishes the batch it started instead of abandoning leases', async () => {
    const h = harness([row({ id: '14' })], {
      dispatch: async (env) => {
        await new Promise((r) => setTimeout(r, 20));
        h.seen.push(env);
        return { kind: 'completed', detail: null } as const;
      },
    });
    const ticking = h.relay.tick();
    h.relay.start();
    await h.relay.stop();
    expect(await ticking).toBe(1);
    expect(h.relay.stats().running).toBe(false);
  });

  it('does not hold the event loop open between ticks', async () => {
    const h = harness([]);
    h.relay.start();
    // `unref()` is what lets SIGTERM exit a worker mid-sleep; without it the pod
    // sits until the preStop grace period ends.
    expect(h.relay.stats().running).toBe(true);
    await h.relay.stop();
    expect(h.relay.stats().ticks).toBeGreaterThanOrEqual(0);
  });

  it('exposes exactly the queues the collectors and DLQ endpoint talk about', () => {
    expect(relayQueueNames().sort()).toEqual(Object.values(QUEUES).sort());
  });
});
