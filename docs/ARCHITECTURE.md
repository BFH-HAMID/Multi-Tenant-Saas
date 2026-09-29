# Architecture

**Multi-Tenant SaaS — TypeScript · Fastify · PostgreSQL (RLS) · Redis · BullMQ · Kubernetes · Prometheus/Grafana · k6**

This document explains the design, the trade-offs, and the _measured_ behaviour — including the load-test numbers and what the gates caught while earning them. Each major decision has an ADR in [`docs/adr/`](adr/); diagrams live in [`docs/diagrams/`](diagrams/).

---

## 1. Tenancy model: one database, Row-Level Security

Three options were on the table; the choice is a bet on the tenant distribution (many small, few huge):

|                                        | DB-per-tenant                                                  | Schema-per-tenant                                  | **Shared DB + RLS (chosen)**            |
| -------------------------------------- | -------------------------------------------------------------- | -------------------------------------------------- | --------------------------------------- |
| Connection cost                        | pool per tenant — impractical past ~50 tenants on one Postgres | one pool, but catalog bloat, O(tenants) migrations | **one pool, O(1)**                      |
| Migration story                        | N applies, version skew forever                                | N schema applies, invisible drift                  | **one apply, checksummed**              |
| Cross-tenant features (admin, billing) | ETL problem on day one                                         | UNION across schemas                               | plain SQL                               |
| Noisy neighbour                        | impossible by construction                                     | CPU/disk still shared                              | **must be engineered** — see §4 and §10 |
| Blast radius of a bad migration        | one tenant                                                     | one schema                                         | every tenant                            |
| Offboarding                            | `DROP DATABASE`                                                | `DROP SCHEMA`                                      | delete rows (cascades)                  |

Everything hinges on RLS being _actually enforced_, so it is enforced in layers (each layer is asserted against the catalog by `db/tests/schemaInvariants.int.test.ts`, not merely by app tests):

1. Every tenant table has RLS **enabled and FORCED** (a policy an owner can skip is not a policy).
2. The API/worker connect as `app_user`: DML only, **no DDL, no `BYPASSRLS`**, owns nothing.
3. Each request opens a transaction and does `SET LOCAL app.tenant_id / user_id / tenant_role` — `SET LOCAL`, never `SET`, so a pooled connection cannot carry tenant A's context into tenant B's query. Policies compare `tenant_id` with `app.current_tenant_id()`; a missing predicate means **no rows**, not "all rows".
4. Triggers enforce `tenant_id` and plan quotas even against raw SQL that bypasses the app.
5. The only RLS escape is a small, reviewed `SECURITY DEFINER` surface (registration, tenant resolution, login lookup) owned by a non-login `BYPASSRLS` role, each function pinning `search_path`.

A cross-tenant leak therefore needs three simultaneous failures: a forgotten `WHERE`, a defeated policy, and a review that missed both. The escape hatch for thousands of tenants is hash-partitioning by `tenant_id` — a migration _within_ the model, not a rewrite of it.

## 2. Request lifecycle

Order is load-bearing (`apps/api/src/app.ts`, diagram in `docs/diagrams/request-lifecycle.mmd`):

```
onRequest     metrics start · request id
preHandler    auth (JWT verify) → tenant resolve (X-Tenant-Id → X-Tenant-Slug →
              {slug}.host → token tid) → cross-check token tid == resolved tenant
              → rate limit (bucket geometry from the tenant's plan) → idempotency
handler       BEGIN; SET LOCAL app.tenant_id…; (RLS filters every statement); COMMIT
onResponse    latency/status histograms · tenant_requests_total · one access line
```

- **Auth before tenant**: the token's `tid` must match the resolved tenant — no header trick can aim a valid token at another workspace (403, `tenant_mismatch` counter).
- **Rate limit after tenant**: per-tenant bucket geometry comes from the plan; it also means a 429 costs **one Redis round trip and zero Postgres** — the whole point of ordering it before the handler.
- **Idempotency last**: a replayed `Idempotency-Key` short-circuits before any handler work.
- Tenant resolution is cached (60s positive, 5s negative — negative caching matters: a typo'd subdomain must not be a free Postgres query per hit).

## 3. Auth, sessions, RBAC

- **Access tokens**: JWT HS256, 15 min, claims `sub`/`tid`/`role`. No session table on the hot path.
- **Refresh tokens**: 30 days, argon2id-hashed at rest, **rotated on every use**, with **reuse detection** — presenting an already-rotated token revokes the whole family (`auth_events_total{event="reuse_detected"}`, a critical alert). That is the textbook stolen-token response, and it is why refresh state lives in Postgres, not in the JWT.
- **Passwords**: argon2id (19 MiB, t=2, p=1) via `@node-rs/argon2`; login compares against a dummy hash for unknown users so response time does not oracle account existence.
- **RBAC**: `owner > admin > member > viewer` per tenant, stored in `tenant_members` and surfaced to SQL as `app.tenant_role`, so triggers can enforce role rules too. Every route declares its requirement; a contract test walks the route tree and fails any route that forgot.

## 4. Rate limiting: per-tenant token buckets in Redis

A token bucket (capacity = burst, refill = sustained rate) per **tenant per route class**, evaluated atomically by a Lua script (one `EVALSHA`), mirrored by a pure-TS model with a randomized parity test — the Lua and the documented semantics cannot drift.

Key: `rl:{tenantId}:{routeClass}` (classes: `read` / `write` / `auth` / `bulk`). Geometry from `packages/shared/src/plans.ts`:

| plan       | read                | write              | auth            | bulk          | projects | members | in-flight jobs |
| ---------- | ------------------- | ------------------ | --------------- | ------------- | -------- | ------- | -------------- |
| free       | 120 burst / 300 min | 30 / 60 min        | 10 / 20 min     | 2 / 2 min     | 10       | 5       | 1              |
| pro        | 1,200 / 6,000 min   | 300 / 1,200 min    | 60 / 120 min    | 20 / 30 min   | 250      | 50      | 5              |
| enterprise | 12,000 / 60,000 min | 3,000 / 12,000 min | 600 / 1,200 min | 200 / 300 min | 100k     | 5,000   | 50             |

Three layers, deliberately ordered so their rejections never mask each other: the **edge** (nginx limit-rps / ingress annotation, per-IP, coarser than anything here — an edge 429 never enters `ratelimit_decisions_total`), the **app plan buckets**, and an **IP-scoped mirror on credential endpoints** (`rl:ip:{ip}:auth`) for attackers who have no tenant at all. All three answer with the same problem+json shape and `X-RateLimit-Source` says which layer spoke.

**When Redis is unreachable** the limiter fails _neither_ open nor closed: it degrades to per-pod in-process buckets (`outcome="fallback"`, its own critical alert). Effective global limit becomes plan × replicas — degraded precision, enforcement continues. Full reasoning in [ADR-0004](adr/0004-rate-limiting-token-bucket.md).

## 5. Caching: cache-aside, tenant-prefixed, O(1) invalidation

- Keys: `t:{tenantId}:c:{entity}:v{version}:…` — the tenant prefix is what makes a key-layout bug a _cross-tenant leak_, so it is built in exactly one module (`packages/shared/src/keys.ts`) and every key is greppable.
- **Versioned invalidation**: lists reference a per-entity monotonic version; a write bumps the version and old entries fall out on TTL — O(1) writes instead of `SCAN`-and-delete.
- TTLs with ±10% jitter (a warm cache populated in a burst must not expire in a burst), per entity: project item 30s, list 10s, tenant 60s, members 20s — **scaled by plan** (×1 free, ×2 pro, ×4 enterprise).
- Single-flight coalescing on fills (`cache_lookups_total{outcome="coalesced"}` counts as a hit).
- 304 support on conditional GETs, `Cache-Control: private, no-store` on every write response (enforced by the route contract test).

## 6. Queues: BullMQ + a transactional outbox, at-least-once, idempotent

The dual-write hazard (`INSERT…; queue.add(…)` spans two systems) is solved by making the Postgres write the durable one (ADR-0005):

```
POST /reports → BEGIN → INSERT report_jobs + INSERT outbox (same tx) → COMMIT
             → best-effort queue.add()          ← after COMMIT, never inside the tx
worker relay  → claim batch (FOR UPDATE SKIP LOCKED, lease 120s) → publish → settle
```

- **At-least-once is the contract**; consumers are idempotent by construction: a claim table (`INSERT … ON CONFLICT DO NOTHING` on `tenant:idempotencyKey`), a guarded state machine (`pending → running → completed`, `WHERE status IN ('pending','running')`), and deterministic BullMQ job ids (re-enqueue of the same logical job dedupes).
- Retries: 3 attempts, exponential backoff, stalled-job re-claim. Exhausted jobs land in the `dead-letter` queue _and_ the outbox row is marked `discarded` with the error — two reconciled views (`queue_dead_letter_depth` / `outbox_pending_messages`). `/dlq` lists, `/dlq/replay` re-enqueues with payload + idempotency key untouched, so replay cannot double-execute.
- `QUEUE_DRIVER=outbox` runs the whole system with **no Redis at all** (the relay is the only transport) — which is how CI unit-tests run it, and why Redis-down degrades to _slower delivery_, not lost work.
- Queue namespace goes in as BullMQ's `prefix` **option**; queue names stay bare (`Queue name cannot contain ':'` — a real bug this repo fixed in three places).

## 7. Scaling

**Stateless API tier.** All shared state lives in Postgres (RLS rows) or Redis (cache/buckets per ADR-0006's split), so horizontal scaling is just replicas: `HPA 3..20` on CPU (70%) + memory (80%), fast up / slow down (5 min stabilization, 1 pod/min), PDBs at 2, `maxUnavailable: 0` rollouts. RPS-driven scaling is prepared, not enabled — a custom metric that stops being served turns an HPA into a fixed replica count, so it ships as a commented block with the prometheus-adapter instructions (`infra/k8s/base/hpa.yaml`).

**Worker tier.** Separate Deployment (different memory profile, different scaling signal, different blast radius). Concurrency 4/pod is a _fairness_ knob: every in-flight job holds a pooled Postgres connection inside a tenant transaction. No HPA in the base — queue **age** (`queue_oldest_pending_job_seconds`) and relay-tick alerts drive scaling until the custom-metrics pipeline exists.

**The database is the plan's bottleneck**, and it is arithmetic before it is heroics:

```
Postgres max_connections = 200
API pods × PG_POOL_MAX (12) + workers × PG_POOL_MAX (10)  <  200
```

At the HPA ceiling (20 × 12 + 6 × 10 = 300) that inequality breaks — which is precisely the boundary where PgBouncer (transaction mode; `SET LOCAL` survives it, prepared statements need `max_prepared_statements` on 1.21+) and read replicas enter, before more pods do. The load tests below measure the read path at 99%+ cache hit; replicas are for the miss storms, not the steady state.

## 8. Failure modes

What actually happens, per failure (each row is observable — metric or header — not folklore):

| Failure                    | Behaviour                                                                                                                                                     | Why it is OK (and what is not)                                                                                       |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| **redis-cache down**       | Reads go to Postgres (cache ops fail-open as misses); limiter degrades to per-pod buckets (`outcome="fallback"` alert, `X-RateLimit-Source: memory+degraded`) | Correct, slower, _enforcement continues_; per-pod limit precision is the accepted regression                         |
| **redis-queue down**       | `queue.add` fails; outbox absorbs (rows accumulate, `outbox_pending_messages` grows, `OutboxNotDraining` pages); relay publishes on recovery                  | Degraded-to-delayed, no loss; bounded by queue-Redis disk (noeviction — it refuses writes rather than evicting jobs) |
| **Postgres down**          | `/readyz` fails → pods leave rotation; 5xx on in-flight; liveness stays green (no crash loop)                                                                 | The API holds nothing durable; recovery is re-entering rotation                                                      |
| **Worker crash mid-job**   | Lease (120s) expires, another worker re-claims; idempotent claim makes redelivery a no-op if it had completed                                                 | At-least-once honoured; the one visible artefact is a `skipped` job result, which is counted                         |
| **A pod dies mid-rollout** | Readiness flip + `preStop sleep 5` + grace bounded drain (SHUTDOWN_GRACE_MS); `maxUnavailable: 0` keeps capacity                                              | In-flight requests drain or fail cleanly; no connection-reset window                                                 |
| **Redis memory pressure**  | cache instance evicts LRU by design; queue instance refuses writes (noeviction)                                                                               | Opposite failure models are why they are two instances (ADR-0006)                                                    |
| **Poison job**             | 3 attempts → dead-letter queue + `discarded` outbox row; `/dlq/replay` after fix                                                                              | A bad payload pages once, not forever                                                                                |

## 9. Observability

- **Metric names are a contract**: `packages/shared/src/metrics.ts` lists every metric and its owner; unit tests on _both_ apps fail if a registered metric is not exposed or an exposed metric is unregistered. Dashboards and alert rules consume only contract names — the "green dashboard, empty series" failure is designed out.
- **Cardinality budget**: never a tenant label on a histogram. Per-tenant triage uses `tenant_requests_total{tenant, route_class, outcome}` behind a top-N allow-list. Route labels are route _templates_ (`/v1/projects/:id`), never URLs.
- **Scrape surface**: `/metrics`, `/readyz`, `/livez`, `/healthz` on a second port (9464/9465) the ingress never fronts; the public listener exposes only shallow `/v1/health` and dependency booleans `/v1/status` (no DSNs).
- **Alerts encode healthy-but-loud states**: a 429 storm is explicitly _not_ the 5xx alert; throttling is the limiter succeeding. Rules are identical in the compose lab and the cluster (ADR-0007).

## 10. Load test results

### Method

- **Tooling**: the dependency-free runner (`tools/loadgen`) — closed-loop VUs, per-tenant sampling, _and_ server-side numbers by diffing `/metrics` before/after the run. Each config also emits an equivalent **k6 script** (`loadtests/{smoke,load,tenant-isolation}.js`, generated, never hand-edited; CI runs the k6 variant in the compose-smoke job and fails the build if the two drift).
- **Environment (all numbers below)**: a 2 vCPU / 4 GB host, everything co-located: PostgreSQL 18.4, redis-cache (allkeys-lru), redis-queue (noeviction+AOF), **one** API process (`NODE_ENV=production`, pool 12), **one** worker (concurrency 4, relay 250 ms/50), client on the same host, direct to the API port (the edge is exercised separately in CI). Thresholds are per-config gates — a run either holds all of them or exits non-zero.
- All three runs below were re-measured **after** the delivery-race fix in §10.4 (the first item), back-to-back on one host; the isolation row is the same run recorded in `docs/assets/isolation-capture.gif` (a live `/metrics` capture — `make capture-gif` regenerates it).
- Reproduce: `make lab && make compose-seed && make load-smoke load-run load-isolation` (or `make load-k6`).

### 10.1 Smoke — does the funnel work under a little load? (6 s, 4 VUs)

|                             |                     |
| --------------------------- | ------------------- |
| Requests / throughput       | 703 @ 115.4 rps     |
| Client p95 (worst scenario) | 5.8 ms              |
| Server p95 / p99            | 4.8 ms / 5.0 ms     |
| Cache hit ratio             | 99.7% (136 lookups) |
| 5xx                         | **0**               |
| Gates                       | 3/3 held            |

### 10.2 Capacity — one workspace per plan, mixed read/write (45 s, 24 VUs)

| Tenant  | Plan       | Req   | p50    | p95     | p99     | max     | 429   | Offered |
| ------- | ---------- | ----- | ------ | ------- | ------- | ------- | ----- | ------- |
| load-…0 | free       | 8,249 | 1.7 ms | 6.8 ms  | 17.0 ms | 42.5 ms | 95%   | 183 rps |
| load-…1 | pro        | 8,001 | 2.3 ms | 10.7 ms | 24.4 ms | 69.4 ms | 18.9% | 178 rps |
| load-…2 | enterprise | 7,877 | 2.5 ms | 13.6 ms | 26.3 ms | 80.6 ms | 0%    | 175 rps |

Server-side (this run only): **535.6 rps offered, 24,127 requests, p95 7.3 ms, p99 19.6 ms, 0 5xx, cache hit 99.66% (11,339 lookups), throttled 38.73%, queue pending 0.** Slowest scenarios are the write paths (`POST …/reports` and `POST /v1/projects`) — the correct order for a design where reads are cached and writes are transactional. Across all runs on this host, 154,701 DB queries: 99.4% under 5 ms and every one under 100 ms; pool `waiting` never left 0; the RLS predicate is not measurable in the latency budget.

Note the **floor** gates in this config: `throttlePct ≥ 1%` and `cacheHitRatio ≥ 25%` — a run where _nothing was limited_ proves nothing about the bucket, and a run where the cache never hits proves the layer is decoration. The free workspace was throttled at 95% _at its own plan boundary_ (offered 183 rps against a ~5 rps sustained read budget), which is the entitlement doing its job, while its admitted requests still ran at p95 6.8 ms.

### 10.3 Noisy neighbour — one enterprise floods, four free plans behave like people (60 s, 25 VUs)

| Tenant              | Role     | Req    | rps   | p95     | p99     | 429   | 5xx |
| ------------------- | -------- | ------ | ----- | ------- | ------- | ----- | --- |
| iso-…0 (enterprise) | attacker | 46,619 | 772.4 | 14.4 ms | 22.2 ms | 28.9% | 0   |
| iso-…1 (free)       | victim   | 937    | 15.5  | 9.7 ms  | 22.3 ms | 55.4% | 0   |
| iso-…2 (free)       | victim   | 942    | 15.6  | 9.7 ms  | 19.2 ms | 55.6% | 0   |
| iso-…3 (free)       | victim   | 934    | 15.5  | 8.8 ms  | 16.4 ms | 55.3% | 0   |
| iso-…4 (free)       | victim   | 943    | 15.6  | 9.6 ms  | 18.4 ms | 55.8% | 0   |

Server-side: **834.6 rps offered, 50,375 requests, p95 7.6 ms, p99 9.8 ms, 0 5xx, cache hit 99.7% (20,565 lookups), throttled 30.88%, queue pending 0.** The whole run is visible as a 63-frame live capture (`docs/assets/isolation-capture.gif`): the attacker's rps ramp, the victims' flat p95, the throttle percentage, and the outbox-pending counter pinned at 0.

Reading it honestly:

- The attacker's flood was **contained by its own buckets**: of 13,969 report-enqueue attempts, the enterprise `bulk` bucket (200 burst / 300 per min) admitted **499** — the queue never even noticed (`queue pending = 0` throughout).
- The victims' p95 stayed at **8.8–9.7 ms — _faster_ than the attacker's own 14.4 ms** — against a 500 ms gate. Their ~55% 429 rate is _their own_ free-plan bucket (offered 15.6 rps against a ~5 rps sustained read budget), not the attacker's noise: same plan, same throttle, on a quiet system. That distinction (contained attacker, victims limited only by their own entitlement, zero 5xx) is the narrow claim the config was written to falsify, and it held.
- Server p95 (7.6 ms) and the client-observed p95 (up to 14.4 ms for the attacker) differ because the load generator shares the 2 vCPU host with everything else — the server was never the slow party, and the victims' client-observed p95 stayed single-digit anyway.
- **Delivery under fire**: every report job enqueued during these runs completed — 0 `job-row-missing`, 0 stuck in `queued`, 0 dead-lettered (this is the fix in §10.4 being load-tested, not a claim).

### 10.4 What the gates caught (the tests are not decorative)

- **The outbox fast path was a dual-write in disguise** — found by a manual end-to-end check, not by a green dashboard. The producer published the BullMQ job from _inside_ the enqueue transaction; the worker could consume it before `COMMIT` made `report_jobs` visible, read "no row", and return `skipped` — which `dispatch()` counted as `completed` and used to settle the idempotency claim. The relay's later delivery then hit the claim and no-op'd ("replay"). Net effect: **~14% of report jobs sat in `queued` forever with every metric green** (203 lost out of 1,442 in the DB this was discovered against). Fixed at three layers — `withTenant` grew `afterCommit` hooks, the producer now publishes only after `COMMIT`, and the consumer treats a missing row as a _retry_ (handler-level `skipped`/`retry` signals are classified honestly instead of being folded into `completed`) — with regression tests on both sides (`apps/worker/tests/dispatch.unit.test.ts`, `db/tests/transaction.int.test.ts`).
- The `server.throttlePct ≥ 1%` floor **failed its first capacity run** with `0/0`: `ratelimit_decisions_total` was registered but never emitted — the counting wrapper sat inside the limiter's _fallback_ path, so the Redis path (the one production runs) was uncounted. Fixed (`apps/api/src/ratelimit/service.ts`); the gate now holds and would catch the same class of regression.
- Bringing the stack up live (instead of trusting the compose file) surfaced a **BullMQ namespace bug**: queue names built as `prefix:name` throw (`Queue name cannot contain ':'`), breaking any deployment that sets `QUEUE_NAME_PREFIX`. Fixed across producer, worker and depth probe, with the namespace moved to BullMQ's `prefix` option.
- A boot race (Redis `ping()` issued before connection handshake with `enableOfflineQueue: false`) produced spurious "degraded mode" logs — fixed by waiting for `ready` (bounded) before the boot probe.

### 10.5 What changes at 10×

At ~5,500 rps offered (10× these runs) on this topology, in the order the constraints bind:

1. **Connections first**: 20 API pods × 12 + workers × 10 ≈ 300 > `max_connections` 200. Put **PgBouncer** (transaction pooling) in front — `SET LOCAL` is transaction-scoped and survives it — or cap pools per pod and keep the arithmetic honest in the HPA ceiling.
2. **Read replicas** for list/get misses (the 0.5% that misses a 99.5%-hit cache is 275 rps of Postgres at 10×). The cache key scheme is already tenant-prefixed; replica routing needs no schema change.
3. **Cache instance sizing/clustering**: `allkeys-lru` at 10× tenants needs a real memory budget from measured per-tenant bytes, or Redis Cluster with `tenantId` as the hash tag (the key scheme is already tag-ready by design).
4. **Worker fairness**: KEDA on queue depth replaces fixed replicas; per-tenant worker concurrency (already modelled in `plans.ts`) becomes load-bearing so one enterprise's report storm cannot monopolize the shared pool — the isolation test's `REPORT_WORK_MULTIPLIER` exists to keep that measurable.
5. **Table growth**: hash-partition `projects`/`report_jobs`/`outbox` by `tenant_id` (~thousands of tenants), plus a scheduled outbox pruner — `outbox_pending_messages` must be a gauge of _lag_, not of table size.
6. **The measurement itself**: at 10×, the load generator needs to be off-host (the client was co-located here — fine at 1.2k rps, dishonest at 12k), and per-tenant latency moves to exemplars/traces because the top-N counter view is triage, not diagnosis.

## 11. Security posture (summary)

Least-privilege DB role with forced RLS (§1) · JWT + rotating refresh with reuse detection (§3) · layered rate limiting with per-IP credential brakes (§4) · tenant-prefixed cache keys built in one module (§5) · outbox dedupe keyed by tenant (§6) · non-root, read-only-root-filesystem, dropped-capability containers; internal-only metrics ports; secrets never in manifests (§ADR-0008) · Swagger/OpenAPI off in prod; strict content-type parser; body limits at edge and app.

## 12. Repository map

| Path                                | What                                                                                                |
| ----------------------------------- | --------------------------------------------------------------------------------------------------- |
| `apps/api`                          | Fastify 5 API: hooks, modules (auth/tenants/users/projects/reports/health), cache, limiter, metrics |
| `apps/worker`                       | BullMQ consumers, outbox relay, DLQ + replay, internal metrics server                               |
| `packages/shared`                   | zod DTOs, plans, token bucket (TS+Lua parity), key scheme, metric contract, logger                  |
| `db`                                | SQL migrations (schema, RLS, definer surface, outbox), runner, tenant-scoped client, seed           |
| `infra/compose`                     | the annotated lab: pg, redis×2, api×2, worker, nginx, prometheus, alertmanager, grafana             |
| `infra/k8s`                         | kustomize base + dev/prod overlays, migrate Job, ServiceMonitors + PrometheusRule                   |
| `infra/prometheus`, `infra/grafana` | scrape config, alert rules, provisioned dashboards                                                  |
| `loadtests`                         | three configs + their generated k6 scripts (smoke / capacity / noisy-neighbour)                     |
| `tools/loadgen`                     | the load generator and the k6 emitter                                                               |
| `.github/workflows`                 | `ci.yml` (gates incl. compose-smoke) · `cd.yml` (GHCR + digest-pinned migrate-first deploy)         |
