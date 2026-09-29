# ADR-0007: Observability — metric contracts, bounded cardinality, separate scrape ports

**Status:** accepted

## Context

Dashboards and alert rules reference metric names and labels. The classic
failure is quiet: a metric is renamed or never emitted, the panel goes empty,
the alert returns nothing, and everyone reads "no data" as "healthy". The
second classic failure is cardinality: per-tenant labels on a histogram melt
Prometheus at a few thousand tenants.

## Decision

**1. Metric names are a contract.** `packages/shared/src/metrics.ts` is the
single list (`METRICS`) plus `METRIC_OWNERSHIP` (which process may emit each
one). Both are enforced by tests from both sides:

- `packages/shared/tests/metricNames.unit.test.ts` — the list is well-formed;
- `apps/api/tests/metricsContract.unit.test.ts` /
  `apps/worker/tests/metricsContract.unit.test.ts` — each app registers
  exactly its owned metrics on the exposed registry;
- dashboards (`infra/grafana/dashboards/`) and alert rules
  (`infra/prometheus/alerts.yml`, `infra/k8s/monitoring/prometheusrule.yaml`)
  are generated from or checked against the same names.

The repo also tracks names _considered and rejected_ next to the list, so a
future "let's just add tenantId to the latency histogram" starts from the
decision, not from the outage.

**2. Cardinality budget.** Never a tenant/user label on a histogram (6 buckets
× 10k tenants × 30 routes ≈ 1.8M series). Per-tenant observability uses
counters on the two axes that matter for noisy-neighbour triage —
`tenant_requests_total{tenant, route_class, outcome}` — with a **top-N
allow-list** (first 2N tenants seen, frozen to N by volume) so the series
count is bounded no matter how many tenants exist. Route labels use the
Fastify _route template_ (`/v1/projects/:id`), never the URL: ids must not
enter the label set.

**3. Scrape surface.** `/metrics`, `/readyz`, `/livez`, `/healthz` live on a
separate internal listener (9464 API, 9465 worker) that the ingress never
fronts. Metrics are unauthenticated inside the pod network by design; the
public listener gets only the shallow `/v1/health` and the self-service
`/v1/status` (dependency booleans, never a DSN — a status endpoint that leaks
connection strings is a standard pentest win).

**4. Gauges that mean something.** Depth is not enough: `queue_oldest_pending_job_seconds`
(age of the oldest unclaimed job) is the user-visible number — depth 5 is fine
if it is 5 new jobs and fatal if it is the same 5 for an hour. Pull-type
gauges (pool stats, Redis liveness, queue depth, outbox lag) refresh on a
15s collector interval, independent of scrape rate, and a failing collector
never breaks a scrape.

## Consequences

- Adding a metric is a three-file change (list, owner, emitter) and the tests
  force the dashboard/alert side to follow — that friction is the feature.
- The 429-vs-5xx distinction is explicit everywhere (an alert description that
  says "a 429 storm is NOT this alert") because in a rate-limited multi-tenant
  system, _some tenant being throttled is the healthy state_.
- Both environments (compose lab and k8s) run identical rules and targets on
  purpose: a metric that only exists in one environment is how an alert is
  discovered to be broken during the incident it was written for.
