# ADR-0002: BullMQ for async work

**Status:** accepted
**Context:** welcome/invite emails, report generation — anything the request
path should not wait for. (Also see ADR-0005 for the delivery guarantees; this
ADR is about the _transport_ choice.)

## Context

Requirements: retries with backoff, a dead-letter path, per-queue concurrency,
delayed jobs, and observability of depth/age — with Node/TypeScript first-class.

Options:

1. **Do it inline in the request** — rejected: a report over 400 projects is
   seconds of CPU; the request path must stay O(1)-ish, and SMTP is a
   grey-listing adventure you do not want in your latency budget.
2. **cron + database polling** — no backoff semantics, no per-job attempts,
   the poller becomes a second scheduler to reason about. (The outbox _relay_
   below is deliberately a much dumber version of exactly this, and only as a
   fallback.)
3. **Kafka/RabbitMQ** — heavy new infrastructure for ~3 job kinds; RabbitMQ
   gives routing we do not need, Kafka gives ordering/log semantics we do not
   need, and both add a failure domain the team must operate.
4. **BullMQ on Redis** — mature, Lua-based, first-class TypeScript, delayed
   jobs, stalled-job detection, per-worker concurrency, and the operational
   surface is a Redis we already run (albeit a second instance — ADR-0006).

## Decision

BullMQ, three queues — `email`, `reports`, `dead-letter` — with a namespace
prefix (`QUEUE_NAME_PREFIX`, default `saas`) passed to BullMQ as its `prefix`
_option_. (Queue _names_ stay bare: BullMQ rejects `:` in names, and baking
the namespace into the name was a real bug this repo fixed — the producer, the
worker and the depth probe must all address the same Redis keys
`{prefix}:{queue}:…`.)

Shared contract in `packages/shared/src/queues.ts`: both sides import the same
queue names, job names, per-queue defaults (`attempts: 3`, exponential backoff
500ms, `lockDuration: 30s`, `maxStalledCount: 2`) and the same zod payload
schemas — a producer and consumer that disagree about a payload is a runtime
failure otherwise discovered in production.

Producer behavior (see ADR-0005): the outbox row is the durable record; the
immediate `queue.add()` is an optimization, never a dependency.

## Consequences

- Redis (queue instance) is on the critical path of _eventual_ work, not
  requests: with it down, the outbox absorbs and the relay publishes later —
  degradation, not loss (ADR-0006).
- Worker concurrency is a fairness knob: each in-flight job holds a pooled
  Postgres connection inside a tenant transaction. `CONCURRENCY=4` is the
  tested default; raising it trades throughput for cross-tenant tail latency
  (that is precisely what the isolation load test measures).
- The DLQ is a BullMQ queue, so standard tooling (CLI, dashboards, the
  worker's `/dlq` + `/dlq/replay` endpoints) works on it; the durable record
  of the same event remains the outbox `discarded` row, reconciled by the
  `outbox_pending_messages` metric.
