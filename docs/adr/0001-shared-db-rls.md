# ADR-0001: Shared database with Row-Level Security

**Status:** accepted
**Context:** multi-tenant SaaS, early design (2026).

## Context

Every table with tenant-scoped rows needs a tenancy model. The options, with
the trade-offs that actually drove the decision at ~3 tenants and a projected
long tail of small ones:

|                                                | DB-per-tenant                                             | Schema-per-tenant                                                                               | Shared DB + RLS (chosen)                                  |
| ---------------------------------------------- | --------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| Isolation                                      | strongest (physical)                                      | logical, per-schema grants                                                                      | logical, per-row policies                                 |
| Connection cost                                | one pool per tenant — dies at ~50 tenants on one Postgres | one pool, but thousands of schemas bloat the catalog and `pg_dump`/migrations become O(tenants) | one pool, O(1)                                            |
| Migrations                                     | N deploys, version skew across tenants forever            | N schema applies, drift is invisible until it bites                                             | one apply                                                 |
| Cross-tenant features (admin, billing, search) | ETL problem on day one                                    | UNION over schemas, rewritten per tenant                                                        | plain SQL                                                 |
| Noisy neighbour                                | impossible by construction                                | disk/CPU still shared                                                                           | shared — must be _engineered away_ (ADR-0004, load tests) |
| Blast radius of a bad migration                | one tenant                                                | one schema                                                                                      | everyone                                                  |
| Offboarding                                    | drop database                                             | drop schema                                                                                     | delete rows (cascades)                                    |

## Decision

One database; every tenant-scoped table carries `tenant_id`; **Row-Level
Security is enabled and FORCED on every such table**, and the application
connects as a role that cannot bypass it:

- `app_user` (API/worker role): DML only, **no DDL, no `BYPASSRLS`**, no
  ownership of tenant tables.
- `app_migrator` (migration runner only): owns objects.
- `app_admin`: `BYPASSRLS`, **never a login** — reachable only as the definer
  of a narrow, reviewed set of `SECURITY DEFINER` functions (registration,
  tenant resolution by slug/id, login lookup), each pinning `search_path`.

Per request, the API opens a transaction and does
`SET LOCAL app.tenant_id|user_id|tenant_role` — `SET LOCAL`, not `SET`, so a
pooled connection can never carry tenant A's context into tenant B's query.
Every policy compares the row's `tenant_id` with `app.current_tenant_id()`; a
missing predicate is not "allowed", it is _no rows_.

Defense in depth (all asserted against the catalog by
`db/tests/schemaInvariants.int.test.ts`, not just by app tests):

1. RLS enabled **and forced** — a policy that is present but not forced is a
   policy an owner can skip.
2. Triggers enforce `tenant_id` on INSERT even for raw SQL that forgot the
   predicate.
3. Quotas (`maxProjects`, `maxMembers`) live in triggers, so a bypassing
   writer is still bounded.
4. The definer surface is enumerable: every `SECURITY DEFINER` function must
   be owned by `app_admin`, pin `search_path`, and not be executable by
   PUBLIC — a definer function with a mutable `search_path` is a
   privilege-escalation primitive, not a helper.

## Consequences

- Cross-tenant leakage requires _three_ simultaneous failures: a forgotten
  `WHERE`, RLS defeated, and the review that missed both. The tests only need
  to prove the second is impossible.
- Noisy-neighbour fairness is a _product requirement_ we owe tenants: it is
  paid for with per-tenant token buckets (ADR-0004) and verified by the
  isolation load test (`loadtests/isolation.config.json`), not promised.
- At thousands of tenants we accept shared indexes/heap contention; the
  escape hatch is documented (partition by `tenant_id` hash, or move the
  largest tenants out — a per-tenant escape hatch that schema-per-tenant
  would have forced on everyone from day one).
- A bad migration affects every tenant at once — mitigated by checksummed,
  single-transaction, advisory-locked migrations and a migrate Job that runs
  before the rollout (ADR-0008).
