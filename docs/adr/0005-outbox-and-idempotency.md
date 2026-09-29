# ADR-0005: Transactional outbox, at-least-once delivery, idempotency

**Status:** accepted
**Context:** "send the welcome email" / "generate the report" must happen
exactly once _effectively_, across process crashes, Redis blips and pod
rollouts.

## Context

The classic dual-write hazard: `INSERT …; queue.add(…)` — the DB commit and
the Redis publish are two systems. Commit-then-crash loses the job; publish-
then-rollback fires a job for work that never happened. You cannot have a
transaction across Postgres and Redis, so one of the writes must be derived
from the other.

## Decision

**Transactional outbox.** Producers write `report_jobs` (the user-visible
record) and an `outbox` row **in the same transaction** — the job is durable
the instant the 2xx is durable. Then:

1. a best-effort `queue.add()` registered as an **after-commit hook** — it runs
   the moment COMMIT returns and never inside the transaction. Publishing from
   inside it is a dual-write in disguise: the worker can consume the job before
   the row it describes is visible, and (if "no row" is treated as success)
   silently lose it — that exact race dropped ~14% of report jobs before this
   rule existed, which is why `withTenant` exposes `afterCommit` at all; and
2. the worker's **relay** (`FOR UPDATE SKIP LOCKED`, lease 120s, batch 50,
   250ms tick) publishes anything the fast path missed and settles it.

If (1) fails, nothing is lost; if the relay's lease expires (crashed worker),
another worker re-claims — re-publish is safe because of what follows.

**At-least-once, embraced.** Every consumer step is idempotent:

- **Claim table**: handler starts with `INSERT INTO job_claims (tenant, key)
ON CONFLICT DO NOTHING` — a second delivery of the same `idempotencyKey`
  is a no-op _before_ any work runs.
- **Report state machine**: `pending → running → completed/failed` guarded by
  `WHERE status IN ('pending','running')`; a redelivery finds `completed` and
  returns "skipped" (visible as `queue_job_results_total{outcome="skipped"}`).
- **Job ids** are deterministic (`tenant:idempotencyKey`), so BullMQ itself
  deduplicates re-enqueues of the same logical job.

**Dead letters.** Exhausted retries are parked in the `dead-letter` queue (a
BullMQ queue, so standard tooling works) _and_ recorded durably as the outbox
row's `discarded` state with `last_error` — the two views are reconciled by
the `outbox_pending_messages` / `queue_dead_letter_depth` metrics. `/dlq`
lists, `/dlq/replay` re-enqueues with the payload and idempotency key
untouched, so replay cannot double-execute.

## Consequences

- `QUEUE_DRIVER=outbox` (no Redis at all) is a supported mode: the relay
  becomes the only transport, which is exactly how the system runs in CI
  unit tests and on a bare laptop — and why "Redis down" degrades to slower
  delivery instead of lost work.
- The outbox must be drained and watched: `OutboxNotDraining` (publishes = 0
  while pending > 0) and `WorkerRelayNotTicking` exist because a stalled relay
  fails _quietly_.
- Retries can reorder work (attempt 2 of job A may run after job B). Order
  is not a guarantee this design offers; consumers must tolerate it (they
  already must tolerate redelivery).
