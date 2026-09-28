#!/usr/bin/env bash
# Boot the API against the sandbox Postgres with the in-process Redis double and
# the outbox queue driver — i.e. no Redis needed to develop against this repo.
#
#   node tools/services/bootstrap.mjs pg-init --reset     # once
#   node tools/services/bootstrap.mjs pg-run --port 55432 # background
#   DATABASE_URL=... npx tsx db/src/cli.ts rebuild         # migrations + seed
#   tools/dev/run-api.sh
#
# Every value is `${VAR:-default}` so CI and docker-compose can override them.
set -euo pipefail
cd "$(dirname "$0")/../.."

export NODE_ENV="${NODE_ENV:-development}"
export LOG_LEVEL="${LOG_LEVEL:-info}"
export DATABASE_URL="${DATABASE_URL:-postgres://app_user:app_user@127.0.0.1:55432/saas}"
export REDIS_CACHE_URL="${REDIS_CACHE_URL:-memory://}"
export REDIS_QUEUE_URL="${REDIS_QUEUE_URL:-memory://}"
export QUEUE_DRIVER="${QUEUE_DRIVER:-outbox}"
export PORT="${PORT:-3000}"
export METRICS_PORT="${METRICS_PORT:-9464}"
export ENABLE_SWAGGER="${ENABLE_SWAGGER:-true}"
# Dev-only: a fresh random secret per boot, so nothing that looks like a real
# credential is ever committed and a restart simply invalidates local sessions.
# `loadConfig` refuses short/placeholder secrets; production injects its own.
export JWT_SECRET="${JWT_SECRET:-$(node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("base64url"))')}"
export BUILD_VERSION="${BUILD_VERSION:-0.1.0-dev}"
export BUILD_SHA="${BUILD_SHA:-$(git rev-parse --short HEAD 2>/dev/null || echo unknown)}"

exec npx tsx apps/api/src/server.ts
