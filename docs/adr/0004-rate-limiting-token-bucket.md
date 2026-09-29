# ADR-0004: Per-tenant rate limiting with a Redis token bucket

**Status:** accepted
**Context:** a shared-database multi-tenant platform must make one tenant's
load _measurably_ someone else's non-problem.

## Context

Requirements: per-**tenant** (not per-IP, not global) limits; per-**plan**
geometry; burst tolerance (a user clicking around generates legitimate
bursts); atomicity across N API replicas; and a failure mode that does not
turn "Redis is down" into "everyone is unlimited".

Options: fixed windows (jarring at boundaries, no burst semantics), sliding
windows in a list (O(n) memory per key), **token bucket** (O(1) state: two
fields, natural burst semantics, refill rate = sustained rate, capacity =
burst), local in-memory buckets (per-pod limits = plan limit × replicas —
wrong by design), or a gateway-only limiter (cannot see tenant or plan).

## Decision

**Token bucket, in Redis, computed atomically by Lua** (one
`EVALSHA` — read state, advance by elapsed time, charge the cost, write back;
the script is mirrored by a pure-TS model in `packages/shared` with a
randomized parity test, so the Lua and the documented semantics cannot drift).

Key: `rl:{tenantId}:{routeClass}` — bucket per tenant _per route class_
(`read`/`write`/`auth`/`bulk`), so a tenant hammering exports does not eat its
own read budget, and cardinality stays tenants × 4. Geometry comes from
`packages/shared/src/plans.ts`:

| plan       | read               | write           | auth          | bulk         |
| ---------- | ------------------ | --------------- | ------------- | ------------ |
| free       | burst 120, 300/min | 30, 60/min      | 10, 20/min    | 2, 2/min     |
| pro        | 1200, 6000/min     | 300, 1200/min   | 60, 120/min   | 20, 30/min   |
| enterprise | 12000, 60000/min   | 3000, 12000/min | 600, 1200/min | 200, 300/min |

Anonymous credential endpoints additionally get an IP-scoped mirror
(`rl:ip:{ip}:auth`, ADR-0003). The edge keeps a coarser per-IP brake that must
stay looser than these (a request the edge rejects is invisible to
`ratelimit_decisions_total`, and mixing the two makes the throttling graph
fiction).

**Failure mode:** if Redis is unreachable, the limiter degrades to per-pod
in-process buckets (`RATE_LIMIT_FALLBACK_MEMORY`) — enforcement continues at
reduced precision (effective global limit = plan limit × replicas), the state
is exported (`outcome="fallback"`, `RateLimiterInFallbackMode` alert,
`X-RateLimit-Source` header), and it half-open probes Redis for recovery.
Fail-**closed** (503) was rejected: an outage of the _fairness_ mechanism
should not become an outage of the product; fail-**open** (no limits) was
rejected harder: a cache tier dying must not unthrottle everyone into
Postgres.

Every decision is counted (`ratelimit_decisions_total{outcome=allow|throttle|fallback,plan}`)
— and counted _around_ the degradation wrapper, a bug class this repo actually
hit: wrapping only the fallback backend left the Redis path uncounted and the
`throttlePct` load-test gate at a permanent 0/0.

## Consequences

- Buckets are ephemeral by design (TTL ≈ refill-to-full); a Redis restart
  resets limits — acceptable, five minutes of reset limits is not an incident.
- Requires the cache Redis (evictable) — losing a rate bucket to LRU under
  memory pressure is a _correct_ trade vs losing cached payloads or queue
  keys; documented in ADR-0006.
- The load tests gate on throttling _happening_ (`server.throttlePct` has a
  **floor**, not just a ceiling): a run where nothing was limited proves
  nothing about the bucket.
