#!/usr/bin/env bash
# Boot the worker against the sandbox Postgres. Same database role as the API
# (`app_user`): the worker has no elevated privileges, which is the point of the
# SECURITY DEFINER claim/mark functions in `app`.
#
#   node tools/services/bootstrap.mjs pg-init --reset
#   node tools/services/bootstrap.mjs pg-run --port 55432
#   DATABASE_URL=... npx tsx db/src/cli.ts rebuild
#   tools/dev/run-api.sh        # terminal 1
#   tools/dev/run-worker.sh     # terminal 2
#
# With QUEUE_DRIVER=outbox (the default) no Redis is needed at all — the relay
# polls the ledger. Set QUEUE_DRIVER=bullmq + REDIS_QUEUE_URL to exercise the
# broker path.
set -euo pipefail
cd "$(dirname "$0")/../.."

export NODE_ENV="${NODE_ENV:-development}"
export LOG_LEVEL="${LOG_LEVEL:-info}"
export DATABASE_URL="${DATABASE_URL:-postgres://app_user:app_user@127.0.0.1:55432/saas}"
export REDIS_QUEUE_URL="${REDIS_QUEUE_URL:-memory://}"
export QUEUE_DRIVER="${QUEUE_DRIVER:-outbox}"
export METRICS_PORT="${METRICS_PORT:-9465}"
export CONCURRENCY="${CONCURRENCY:-4}"
export RELAY_INTERVAL_MS="${RELAY_INTERVAL_MS:-250}"
# The load test raises this to make one tenant's report expensive enough to
# observe head-of-line blocking; 1 means "rendering cost only".
export REPORT_WORK_MULTIPLIER="${REPORT_WORK_MULTIPLIER:-1}"
export BUILD_VERSION="${BUILD_VERSION:-0.1.0-dev}"
export BUILD_SHA="${BUILD_SHA:-$(git rev-parse --short HEAD 2>/dev/null || echo unknown)}"

exec npx tsx apps/worker/src/main.ts
