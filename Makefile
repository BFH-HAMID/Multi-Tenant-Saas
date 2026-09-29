# Multi-Tenant SaaS — developer entrypoints.
#
# Every target here is the *same command CI runs* (.github/workflows/ci.yml),
# so "works on my machine" and "passed CI" are the same sentence. Use
# `make help` to see everything.

.DEFAULT_GOAL := help

# Where the local lab lives; NODE_ENV for anything that boots app code.
COMPOSE := infra/compose/docker-compose.yml
ENV_FILE := infra/compose/.env
NODE_ENV ?= development

.PHONY: help
help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) \
		| awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-22s\033[0m %s\n", $$1, $$2}'

# ---------------------------------------------------------------- install ---

.PHONY: install
install: ## Install all workspace dependencies
	npm ci

.PHONY: build
build: ## Typecheck + compile all workspaces (project references)
	npm run build

.PHONY: clean
clean: ## Remove every workspace's dist/
	npm run clean

# ------------------------------------------------------------------ check ---

.PHONY: lint
lint: ## ESLint across the repo
	npm run lint

.PHONY: format
format: ## Prettier write (CI checks this)
	npm run format

.PHONY: format-check
format-check: ## Prettier check (npm run format:check)
	npm run format:check

.PHONY: test
test: ## Unit tests (no services needed)
	npm run test:unit

.PHONY: test-integration
test-integration: ## Integration tests — needs Postgres+Redis (see dev-db / compose-up)
	npm run test:integration

.PHONY: test-watch
test-watch: ## Unit tests in watch mode
	npm run test:watch

.PHONY: check
check: lint build test ## Everything CI checks without services

# ---------------------------------------------------------------- database ---

.PHONY: db-migrate
db-migrate: ## Apply pending migrations (admin URL from infra/compose/.env)
	npm run -w @saas/db migrate

.PHONY: db-seed
db-seed: ## Seed demo tenants (acme/free, globex/pro, initech/enterprise)
	npm run -w @saas/db seed

.PHONY: db-reset
db-reset: ## Drop schema, re-migrate, re-bootstrap roles, re-seed (dev only)
	npm run -w @saas/db rebuild

.PHONY: db-status
db-status: ## List applied/pending migrations
	npm run -w @saas/db migrate:status

# --------------------------------------------------------------- the lab ----

.PHONY: env
env: ## Create infra/compose/.env from the template if missing
	@test -f $(ENV_FILE) || cp $(ENV_FILE).example $(ENV_FILE)
	@echo "$(ENV_FILE) ready — set POSTGRES_PASSWORD/JWT_SECRET/INTERNAL_SECRET before going further."

.PHONY: compose-up
compose-up: env ## Build & start the whole lab (pg, redis×2, api, worker, nginx, prometheus, grafana)
	docker compose -f $(COMPOSE) up -d --build

.PHONY: compose-seed
compose-seed: ## Seed demo tenants inside the running lab
	docker compose -f $(COMPOSE) run --rm seed

.PHONY: compose-scale
compose-scale: ## Scale the API to N replicas (make compose-scale N=3) — a real shared-everything test
	docker compose -f $(COMPOSE) up -d --scale api=$(or $(N),3) --no-recreate api

.PHONY: compose-logs
compose-logs: ## Tail lab logs
	docker compose -f $(COMPOSE) logs -f api worker

.PHONY: compose-ps
compose-ps: ## Lab status
	docker compose -f $(COMPOSE) ps

.PHONY: compose-down
compose-down: ## Stop the lab (keep volumes)
	docker compose -f $(COMPOSE) down --remove-orphans

.PHONY: compose-nuke
compose-nuke: ## Stop the lab and delete volumes
	docker compose -f $(COMPOSE) down -v --remove-orphans

.PHONY: lab
lab: compose-up ## Alias: the full lab, then wait for the edge to answer
	@for i in $$(seq 1 60); do \
		curl -fsS http://localhost:8080/v1/health >/dev/null 2>&1 && { echo "lab ready: http://localhost:8080 (grafana :3001, prometheus :9090)"; exit 0; }; \
		sleep 2; \
	done; echo "lab did not become ready — make compose-logs"; exit 1

# ------------------------------------------------------------- bare metal ---
# Run the API+worker directly with node (no docker), against local or
# compose-provided Postgres/Redis. Useful for profiling and debugging.
# Requires a built repo (`make build`) and a migrated database.

DATABASE_URL ?= postgres://app_user:app_user@127.0.0.1:5432/saas
REDIS_CACHE_URL ?= redis://127.0.0.1:6379/0
REDIS_QUEUE_URL ?= redis://127.0.0.1:6380/0
JWT_SECRET ?= local-dev-secret-please-rotate-0123456789
BUILD_SHA ?= $(shell git rev-parse --short HEAD 2>/dev/null || echo local)

.PHONY: run-api
run-api: build ## Run the API outside docker (see variables above)
	DATABASE_URL=$(DATABASE_URL) REDIS_CACHE_URL=$(REDIS_CACHE_URL) REDIS_QUEUE_URL=$(REDIS_QUEUE_URL) \
	JWT_SECRET=$(JWT_SECRET) QUEUE_DRIVER=bullmq NODE_ENV=production TRUST_PROXY=false \
	BUILD_SHA=$(BUILD_SHA) BUILD_VERSION=local node apps/api/dist/server.js

.PHONY: run-worker
run-worker: build ## Run the worker outside docker
	DATABASE_URL=$(DATABASE_URL) REDIS_QUEUE_URL=$(REDIS_QUEUE_URL) \
	QUEUE_DRIVER=bullmq NODE_ENV=production BUILD_SHA=$(BUILD_SHA) BUILD_VERSION=local node apps/worker/dist/main.js

# ------------------------------------------------------------- loadtests ----

.PHONY: load-smoke
load-smoke: ## Smoke: does the whole funnel work under a little load? (~6s)
	node tools/loadgen/loadgen.mjs --config loadtests/smoke.config.json

.PHONY: load-run
load-run: ## Capacity: three plans, mixed read/write, server-side gates (45s)
	node tools/loadgen/loadgen.mjs --config loadtests/load.config.json

.PHONY: load-isolation
load-isolation: ## Noisy neighbour: one enterprise floods, four free plans stay fast (60s)
	node tools/loadgen/loadgen.mjs --config loadtests/isolation.config.json

.PHONY: load-k6
load-k6: ## Same three experiments via k6 (requires k6 installed)
	k6 run loadtests/smoke.js
	k6 run loadtests/load.js
	k6 run loadtests/tenant-isolation.js

.PHONY: load-regen
load-regen: ## Regenerate the k6 scripts from their JSON configs (never hand-edit)
	node tools/loadgen/loadgen.mjs --config loadtests/smoke.config.json     --emit-k6 loadtests/smoke.js --duration 1s >/dev/null
	node tools/loadgen/loadgen.mjs --config loadtests/load.config.json      --emit-k6 loadtests/load.js --duration 1s >/dev/null
	node tools/loadgen/loadgen.mjs --config loadtests/isolation.config.json --emit-k6 loadtests/tenant-isolation.js --duration 1s >/dev/null
	@echo "loadtests/{smoke,load,tenant-isolation}.js regenerated"

# ----------------------------------------------------------------- docker ---

.PHONY: docker-build
docker-build: ## Build both images locally
	docker build -f apps/api/Dockerfile -t saas/api:local \
		--build-arg BUILD_SHA=$(BUILD_SHA) --build-arg BUILD_VERSION=local .
	docker build -f apps/worker/Dockerfile -t saas/worker:local \
		--build-arg BUILD_SHA=$(BUILD_SHA) --build-arg BUILD_VERSION=local .

# ------------------------------------------------------------------- k8s ----

.PHONY: k8s-render-dev
k8s-render-dev: ## Render the dev overlay (what would be applied)
	kubectl kustomize infra/k8s/overlays/dev

.PHONY: k8s-render-prod
k8s-render-prod: ## Render the prod overlay
	kubectl kustomize infra/k8s/overlays/prod

.PHONY: k8s-apply-dev
k8s-apply-dev: ## Apply the dev overlay to the current cluster
	kubectl apply -k infra/k8s/overlays/dev

.PHONY: k8s-diff-dev
k8s-diff-dev: ## Diff the dev overlay against the cluster
	kubectl diff -k infra/k8s/overlays/dev || test $$? -eq 1

.PHONY: k8s-apply-prod
k8s-apply-prod: ## Apply the prod overlay (CD does this with pinned digests)
	kubectl apply -k infra/k8s/overlays/prod

# ------------------------------------------------------------------ docs ----

.PHONY: docs-arch
docs-arch: ## Open the architecture doc (the key artifact)
	@echo "docs/ARCHITECTURE.md"
.PHONY: capture-gif
CAPTURE_DURATION_MS ?= 63000
capture-gif: ## Regenerate docs/assets/isolation-capture.gif: live /metrics capture during an isolation run (needs run-api + run-worker or the lab)
	@mkdir -p docs/assets
	@echo "capturing $(CAPTURE_DURATION_MS)ms of live metrics while the isolation load runs…"
	@node tools/gifcap/gifcap.mjs \
	  --api-metrics http://127.0.0.1:9464/metrics \
	  --worker-metrics http://127.0.0.1:9465/metrics \
	  --out docs/assets/isolation-capture.gif \
	  --duration-ms $(CAPTURE_DURATION_MS) 2>&1 | grep -vE 'samples$$' & CAP=$$!; \
	sleep 2; \
	node tools/loadgen/loadgen.mjs --config loadtests/isolation.config.json; \
	wait $$CAP
