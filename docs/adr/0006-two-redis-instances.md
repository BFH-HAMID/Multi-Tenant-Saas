# ADR-0006: Two Redis instances — evictable cache vs durable queue

**Status:** accepted

## Context

Redis is used for two things with **opposite** failure models:

|                       | cache (project lists, tenant lookups, idempotency short-TTL, rate buckets) | queue (BullMQ jobs, locks, outbox-published markers) |
| --------------------- | -------------------------------------------------------------------------- | ---------------------------------------------------- |
| Losing a key          | miss → one Postgres read                                                   | **a user's report never runs**                       |
| Under memory pressure | eviction is the _feature_                                                  | eviction is **data loss**                            |
| Persistence           | none needed (all keys are rebuildable or resettable)                       | AOF everysec                                         |

`maxmemory-policy` is per-instance, not per-key. One instance must therefore
choose between `allkeys-lru` (queue keys evicted under pressure — silent job
loss) and `noeviction` (writes fail under pressure — the cache pins memory
until the whole instance refuses writes). Both are wrong for a mixed workload.

## Decision

Two instances, split by purpose, both wired in code
(`REDIS_CACHE_URL` / `REDIS_QUEUE_URL` are separate config keys — there is no
mode where they are silently the same URL):

- **redis-cache**: `maxmemory=256mb` (lab sizing; production sizes from tenant
  count), `allkeys-lru`, **no RDB/AOF** — every key is either a cache entry
  (rebuildable from Postgres) or a token bucket (a 5-minute outage may reset
  limits; see ADR-0004). Persisting it buys nothing and costs a `fork()` per
  save cycle.
- **redis-queue**: `maxmemory=512mb`, **`noeviction`**, `appendonly yes`,
  `appendfsync everysec` — Redis answers with an error instead of evicting a
  job, and the outbox (ADR-0005) already treats a failed publish as "the
  relay will get it".

Client discipline to match: the cache client is built for fail-fast
(`enableOfflineQueue: false`, bounded `commandTimeout`, maxRetries 2 — a
cache outage must not become a request-queue outage), the queue client for
BullMQ semantics (`maxRetriesPerRequest: null`, so a blocking command is
never re-issued behind the lock protocol).

## Consequences

- Cost: one more thing to run. In the lab it is two compose services; in
  production, two small managed instances (or one instance + a second logical
  DB only if the provider's eviction policy can be set per-DB — most cannot).
- Metrics make the split visible: `redis_up{dependency="cache_redis"|"queue_redis"}`
  fires separate alerts with different runbooks (cache down = slower but
  correct; queue down = outbox grows — bounded, watched, and _not_ silently
  evicted).
- The compose lab sizes both small (256/512 MiB) on purpose: eviction
  pressure and its consequences are observable on a laptop, not a story about
  production someday.
