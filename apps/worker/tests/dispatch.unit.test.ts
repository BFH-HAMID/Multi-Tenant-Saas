import { JOBS, QUEUES, type JobName } from '@saas/shared';
import { describe, expect, it } from 'vitest';
import {
  backoffMs,
  dispatch,
  isPermanent,
  queueOf,
  type DispatchResult,
  type JobEnvelope,
} from '../src/jobs.js';
import { counterValue, silentLog, testMetrics, type RegistryLike } from './helpers/fakes.js';

/**
 * The dispatch contract, with no broker and no database.
 *
 * `dispatch()` is the one place a message becomes a handler call, and both
 * transports funnel through it — so everything that decides *whether a tenant's
 * work runs twice, never, or in the DLQ* is testable here without Redis or
 * Postgres. These are the behaviours that are invisible until an incident:
 * a replay that double-emails a customer, a poison message that eats the
 * concurrency budget of every other tenant, a claim-table outage that stops the
 * queue.
 */

type Call = { sql: string; params: unknown[] };

interface FakeDb {
  calls: Call[];
  /** Scripted answers, matched by substring, in order. */
  on(needle: string, answer: unknown[] | (() => never)): FakeDb;
  /** Throw for any statement matching `needle` (Postgres-style error codes). */
  fail(needle: string, code?: string): FakeDb;
}

function fakeDb(): FakeDb & {
  query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }>;
} {
  const calls: Call[] = [];
  // Defaults are the happy path of the claim protocol: nothing recorded yet,
  // then the reservation succeeds. A fake whose reserve answers `undefined`
  // makes every dispatch look "in flight elsewhere", which is why these two
  // are defaults rather than per-test stubs.
  const answers: Array<[string, unknown[] | (() => never)]> = [
    ['app.tenant_by_id', [{ name: 'Acme' }]],
    ['idempotency_reserve', [{ ok: true }]],
  ];
  const failures: Array<[string, string]> = [];
  const throwFor = (needle: string, code?: string) => {
    if (code) {
      failures.push([needle, code]);
    } else {
      answers.push([needle, []]);
    }
    return api;
  };
  const query = async (sql: string, params: unknown[] = []) => {
    calls.push({ sql, params });
    const failure = failures.find(([needle]) => sql.includes(needle));
    if (failure) {
      const err = new Error(`Database error ${failure[1]}`) as Error & { code: string };
      err.code = failure[1];
      throw err;
    }
    const answer = answers.find(([needle]) => sql.includes(needle));
    if (answer && typeof answer[1] === 'function') {
      (answer[1] as () => never)();
    }
    return { rows: (answer?.[1] as unknown[]) ?? [] };
  };
  const api = {
    calls,
    query,
    // `audit()` runs inside a scoped transaction; reuse the same stubbing.
    withTenant: async (_ctx: unknown, fn: (tx: { query: typeof query }) => Promise<unknown>) =>
      fn({ query }),
    on(needle: string, answer: unknown[] | (() => never)) {
      // Prepend: a per-test stub overrides the happy-path default for the same needle.
      answers.unshift([needle, answer]);
      return api;
    },
    fail: throwFor,
  };
  return api;
}

const TENANT = '11111111-1111-4111-8111-111111111111';
const USER = '33333333-3333-4333-8333-333333333333';

function env(over: Partial<JobEnvelope> = {}): JobEnvelope {
  return {
    topic: JOBS.emailWelcome,
    tenantId: '11111111-1111-4111-8111-111111111111',
    payload: {
      kind: JOBS.emailWelcome,
      tenantId: TENANT,
      tenantSlug: 'acme',
      userId: USER,
      email: 'owner@acme.test',
      displayName: 'Ada',
      idempotencyKey: 'job:email:abc',
      requestedAt: '2026-09-29T00:00:00.000Z',
    },
    idempotencyKey: 'job:email:abc',
    attempts: 1,
    maxAttempts: 3,
    source: 'outbox',
    ...over,
  };
}

function deps(over: Partial<Parameters<typeof dispatch>[0]> = {}) {
  const sent: Array<{ to: string; subject: string; text: string }> = [];
  const mail = {
    kind: 'dry-run' as const,
    send: async (msg: { to: string; subject: string; text: string; html?: string }) => {
      sent.push({ to: msg.to, subject: msg.subject, text: msg.text });
      return { messageId: 'mid-1' };
    },
    close: async () => {},
  };
  const db = fakeDb();
  const metrics = testMetrics();
  return {
    d: {
      db: db as never,
      log: silentLog,
      metrics,
      mail: mail as never,
      report: { maxRows: 100, workMultiplier: 1, inlineMaxBytes: 1024 },
      claimTtlSeconds: 60,
      acceptBaseUrl: 'https://app.test',
      ...over,
    },
    db,
    mail,
    sent,
    metrics,
  };
}

describe('claim handling', () => {
  it('runs the handler and settles the claim with status 200 on success', async () => {
    const { d, db, sent } = deps();
    const result = await dispatch(d, env());
    expect(result.kind).toBe('completed');
    expect(sent).toEqual([
      {
        to: 'owner@acme.test',
        subject: 'Your workspace is ready',
        text: expect.stringContaining('Acme'),
      },
    ]);
    // claim → reserve → handler → complete, in that order
    const sql = db.calls.map((c) => c.sql).join('\n');
    expect(sql.indexOf('idempotency_lookup')).toBeLessThan(sql.indexOf('idempotency_reserve'));
    expect(sql.indexOf('idempotency_reserve')).toBeLessThan(sql.indexOf('idempotency_complete'));
    const complete = db.calls.find((c) => c.sql.includes('idempotency_complete'))!;
    expect(complete.params[2]).toBe(200);
  });

  it('treats a replay as a no-op that the broker must not retry', async () => {
    const { d, db, sent } = deps();
    db.on('idempotency_lookup', [{ state: 'replay', response_status: 200 }]);
    const result = await dispatch(d, env());
    expect(result).toEqual<DispatchResult>({ kind: 'skipped', reason: 'already-handled' });
    expect(sent).toHaveLength(0); // ← no second e-mail
    expect(db.calls.some((c) => c.sql.includes('idempotency_reserve'))).toBe(false);
  });

  it('dead-letters a key reused with different bytes instead of guessing', async () => {
    const { d, db, sent } = deps();
    db.on('idempotency_lookup', [{ state: 'conflict', response_status: 200 }]);
    const result = await dispatch(d, env());
    expect(result.kind).toBe('dead');
    expect(result).toMatchObject({ reason: 'idempotency-conflict' });
    expect(sent).toHaveLength(0);
  });

  it('retries while another pod holds the claim, and does not release a claim it never took', async () => {
    const { d, db, sent } = deps();
    db.on('idempotency_lookup', [{ state: 'inflight', response_status: null }]);
    const result = await dispatch(d, env());
    expect(result.kind).toBe('retry');
    expect(result).toMatchObject({ error: 'in-flight-elsewhere' });
    expect(sent).toHaveLength(0);
    expect(db.calls.some((c) => c.sql.includes('idempotency_release'))).toBe(false);
  });

  it('degrades to at-least-once when the claim table itself is unreachable', async () => {
    const { d, db, sent } = deps();
    db.fail('idempotency_lookup', '25P02');
    const result = await dispatch(d, env());
    // Stopping every queue because one auxiliary table is down is the worse
    // failure; the handlers are individually idempotent, so we keep going.
    expect(result.kind).toBe('completed');
    expect(sent).toHaveLength(1);
    expect(
      await counterValue(
        d.metrics.registry as unknown as RegistryLike,
        'worker_errors_total',
        'claim',
      ),
    ).toBe(1);
  });

  it('fingerprints the payload independently of key order', async () => {
    const a = deps();
    await dispatch(a.d, env({ payload: { tenantId: 't', email: 'e@x.test', displayName: 'Ada' } }));
    const b = deps();
    await dispatch(b.d, env({ payload: { displayName: 'Ada', email: 'e@x.test', tenantId: 't' } }));
    const hashA = a.db.calls.find((c) => c.sql.includes('idempotency_reserve'))!.params[2];
    const hashB = b.db.calls.find((c) => c.sql.includes('idempotency_reserve'))!.params[2];
    // jsonb round-trips lose insertion order, so a different order must NOT read
    // as "same key, different payload".
    expect(hashB).toBe(hashA);
  });
});

describe('failure policy', () => {
  const reportEnv = (over: Partial<JobEnvelope> = {}): JobEnvelope =>
    env({
      topic: JOBS.reportGenerate,
      payload: {
        kind: JOBS.reportGenerate,
        tenantId: TENANT,
        jobId: '22222222-2222-4222-8222-222222222222',
        requestedBy: null,
        idempotencyKey: 'job:report:abc',
        options: { format: 'csv' },
        requestedAt: '2026-09-29T00:00:00.000Z',
      },
      ...over,
    });

  it('kills a poison message on the first attempt, with no database calls for the handler', async () => {
    const { d, db } = deps();
    const result = await dispatch(d, reportEnv({ payload: { nope: true } as never }));
    expect(result.kind).toBe('dead');
    expect(result).toMatchObject({ reason: 'invalid-payload' });
    // The claim is settled 500 so a replay is still recognised as this same failure.
    expect(db.calls.find((c) => c.sql.includes('idempotency_complete'))!.params[2]).toBe(500);
    expect(db.calls.some((c) => c.sql.includes('FROM report_jobs'))).toBe(false);
  });

  it('retries a serialization failure with exponential backoff and releases the claim', async () => {
    const { d, db } = deps();
    db.fail('FROM report_jobs', '40001');
    const result = await dispatch(d, reportEnv());
    expect(result).toMatchObject({ kind: 'retry', afterMs: backoffMs(2) });
    expect(db.calls.some((c) => c.sql.includes('idempotency_release'))).toBe(true);
    expect(db.calls.some((c) => c.sql.includes('idempotency_complete'))).toBe(false);
  });

  it('gives up on the last attempt and audits it', async () => {
    const { d, db } = deps();
    db.fail('FROM report_jobs', '40001');
    const result = await dispatch(d, reportEnv({ attempts: 3, maxAttempts: 3 }));
    expect(result).toMatchObject({ kind: 'dead', reason: 'exhausted-retries' });
    const auditCall = db.calls.find((c) => c.sql.includes('app.audit('));
    expect(auditCall!.params[0]).toBe('job.failed');
  });

  it('classifies what may retry, once, for both transports', () => {
    const err = (code: string) => Object.assign(new Error('boom'), { code });
    expect(isPermanent(err('40001')).permanent).toBe(false); // serialization
    expect(isPermanent(err('40P01')).permanent).toBe(false); // deadlock
    expect(isPermanent(err('57P01')).permanent).toBe(false); // admin shutdown
    expect(isPermanent(new Error('unrecognized key(s) in object'))).toEqual({
      permanent: true,
      reason: 'invalid-payload',
    });
    const zodish = Object.assign(new Error('Invalid input'), { name: 'ZodError' });
    expect(isPermanent(zodish).permanent).toBe(true);
  });

  it('backs off exponentially and caps at five minutes', () => {
    expect([backoffMs(1), backoffMs(2), backoffMs(3), backoffMs(4)]).toEqual([
      500, 1000, 2000, 4000,
    ]);
    expect(backoffMs(40)).toBe(300_000);
    // Monotonic: a retry must never be scheduled sooner than the one before it.
    for (let a = 1; a < 30; a++) {
      expect(backoffMs(a + 1)).toBeGreaterThanOrEqual(backoffMs(a));
    }
  });
});

describe('topic → queue mapping', () => {
  it('routes every job name to exactly one queue', () => {
    expect(queueOf(JOBS.reportGenerate)).toBe(QUEUES.reports);
    expect(queueOf(JOBS.emailWelcome)).toBe(QUEUES.email);
    expect(queueOf(JOBS.emailMemberInvite)).toBe(QUEUES.email);
    const all: JobName[] = [JOBS.emailWelcome, JOBS.emailMemberInvite, JOBS.reportGenerate];
    expect(new Set(all.map(queueOf)).size).toBe(2);
  });
});

describe('e-mail handlers', () => {
  it('sends the invite with an accept URL built from config, not from the payload', async () => {
    const { d, sent } = deps();
    await dispatch(
      { ...d, acceptBaseUrl: 'https://app.example' },
      env({
        topic: JOBS.emailMemberInvite,
        payload: {
          kind: JOBS.emailMemberInvite,
          tenantId: TENANT,
          tenantSlug: 'acme',
          invitedEmail: 'new@acme.test',
          inviteToken: 'tok-123',
          invitedBy: 'owner@acme.test',
          idempotencyKey: 'job:invite:abc',
          requestedAt: '2026-09-29T00:00:00.000Z',
        },
      }),
    );
    expect(sent[0]!.to).toBe('new@acme.test');
    expect(sent[0]!.text).toContain('https://app.example/accept?token=tok-123');
    // The token must never reach the audit trail or the metrics…
    expect(JSON.stringify(sent)).toContain('tok-123'); // …but it is in the message body, by design.
  });

  it('falls back to the tenant id prefix when the tenant lookup fails', async () => {
    const { d, db, sent } = deps();
    db.on('app.tenant_by_id', []);
    const result = await dispatch(d, env());
    expect(result.kind).toBe('completed');
    expect(sent[0]!.text).toContain('11111111');
  });
});
