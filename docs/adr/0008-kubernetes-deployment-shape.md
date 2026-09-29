# ADR-0008: Kubernetes deployment shape

**Status:** accepted
**Context:** taking the compose lab's topology (see infra/compose) to a
cluster: infra/k8s.

## Decision

**Two Deployments, not one.** API and worker share nothing at runtime and
differ in everything operational: memory profile (many small requests vs a
few large payloads), scaling signal (RPS/CPU vs queue depth), blast radius (a
wedged report handler must never take request serving with it), and probes.
A combined Deployment forces one HPA, one resource envelope and one rollout
risk on two different workloads.

**Migrations as a Job, before the rollout.** CD applies the migrate Job,
waits for `complete`, then applies the rest. The app role cannot DDL
(ADR-0001) and never runs migrations at boot: a pod that can `ALTER TABLE`
is a pod that can read every tenant, and N pods racing to migrate is a
rollout you cannot roll back. The Job is immutable, so CD deletes the
previous run before applying.

**HPA on CPU + memory, RPS documented not enabled.** CPU is the honest
default (the hot path is JSON ⇄ Postgres ⇄ Redis, and it saturates before
sockets at this tier). RPS-based scaling via `http_requests_per_second` needs
prometheus-adapter/KEDA and is included as a commented block in
`base/hpa.yaml` — a custom metric that silently stops being served turns an
HPA into a fixed replica count, which is worse than an honest CPU-only HPA,
so it ships disabled with instructions. Scale-up is fast (0s stabilization,
+100%/30s); scale-down is deliberately slow (5 min, 1 pod/min) — fairness is
Redis-shared so shrinking is safe, but flapping replicas churn Postgres
connection pools and dashboards alike.

**Probes split by meaning.** Liveness = `/healthz` (process only: a Postgres
blip must remove a pod from rotation, not restart it into a crash loop).
Readiness = `/readyz` (dependencies + a stale-window gate). Both on the
internal port, never the public one. The app and the manifest agree on
shutdown: SIGTERM flips readiness, `preStop: sleep 5` covers endpoint
propagation, `SHUTDOWN_GRACE_MS` bounds the drain, `terminationGracePeriodSeconds`
is the sum plus headroom.

**Digest pinning.** CD pins images by digest (`kustomize edit set image …@sha256:…`),
not tag: `latest` can move between build and apply, and a rollout that does
not know what it rolled out cannot be rolled back.

**Overlay structure.** `base/` holds the shape; `overlays/dev` (1 replica, no
TLS, debug logs, swagger on) and `overlays/prod` (3–20 replicas, PDBs at 2,
bigger envelopes, heap caps matched to limits) differ _only_ in the values
that actually differ, so the diff between overlays is the diff between
environments. Monitoring (ServiceMonitors + PrometheusRule) mirrors the
compose prometheus/alerts.yml exactly (ADR-0007).

**Postgres/Redis are external.** The manifests deploy the stateless tiers
only; the datastores are managed services (or separately-operated
StatefulSets). The `redis-cache`/`redis-queue` hostnames in the Secret are
placeholders for the split required by ADR-0006 — the manifests deliberately
do not blur that boundary with a single shared instance.

## Consequences

- One-job-at-a-time migrations serialize deploys slightly — acceptable: they
  are advisory-locked anyway, and a deploy that waits for its schema is a
  deploy that can roll back its schema.
- The worker has no HPA in the base: queue-depth-based scaling needs the
  custom-metrics pipeline; until then the queue alerts (backlog age, relay
  ticks) drive manual scaling, which is honest at this scale.
- PodDisruptionBudgets at minAvailable 2 (prod) mean node drains are safe but
  the cluster needs ≥3 schedulable nodes per tier — matched to the HPA floor.
