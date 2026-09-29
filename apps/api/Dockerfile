# syntax=docker/dockerfile:1
#
# The API image. Self-contained on purpose: it repeats ~20 lines of build with the
# worker's Dockerfile so that CI, `npm run docker:build`, and a reviewer with a
# laptop can each build *either* service without an implicit build order. Duplicated
# build logic is visible; a hidden dependency between two images is a footgun.
#
# Build from the repo root:  docker build -f apps/api/Dockerfile -t saas/api:local .

FROM node:22-alpine AS build
WORKDIR /repo

# Manifests first — `npm ci` is the slow layer and should only re-run when a
# dependency actually changes. Every workspace manifest is needed because the
# lockfile describes the whole tree.
COPY package.json package-lock.json tsconfig.base.json tsconfig.build.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
COPY apps/worker/package.json apps/worker/
COPY db/package.json db/
RUN npm ci

COPY packages ./packages
COPY apps ./apps
COPY db ./db
# A whole-workspace build (project references), then drop devDependencies in place
# so the runtime stage copies one already-pruned node_modules and does not run a
# second `npm ci` that could resolve differently.
RUN npm run build && npm prune --omit=dev

FROM node:22-alpine AS runtime
WORKDIR /repo

# Only the compiled output of the four workspaces the API actually imports at
# runtime — no toolchain, no tsconfig, no tests, no source maps.
COPY --from=build --chown=node:node /repo/package.json ./package.json
COPY --from=build --chown=node:node /repo/node_modules ./node_modules
COPY --from=build --chown=node:node /repo/packages/shared/dist ./packages/shared/dist
COPY --from=build --chown=node:node /repo/packages/shared/package.json ./packages/shared/package.json
COPY --from=build --chown=node:node /repo/db/dist ./db/dist
# Raw SQL for the compose `migrate` service / k8s migrate Job, which reuse this
# image with a different command. The migrations run as SQL files loaded from
# disk — they are not inlined into db/dist — so an image that can migrate must
# ship them. (apps/worker/Dockerfile intentionally does not copy them.)
COPY --from=build --chown=node:node /repo/db/migrations ./db/migrations
COPY --from=build --chown=node:node /repo/db/package.json ./db/package.json
COPY --from=build --chown=node:node /repo/apps/api/dist ./apps/api/dist
COPY --from=build --chown=node:node /repo/apps/api/package.json ./apps/api/package.json

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    METRICS_PORT=9464 \
    # Probes and /metrics live on METRICS_PORT, which the ingress never fronts and
    # the image never publishes to the host: the public socket has no /healthz.
    INTERNAL_LISTENER_ENABLED=true

# Build identity lands in the `app_info` metric labels, which is how a dashboard
# answers "is the version I fixed actually the version running here".
ARG BUILD_SHA=unknown
ARG BUILD_VERSION=0.0.0-unknown
ENV BUILD_SHA=${BUILD_SHA} \
    BUILD_VERSION=${BUILD_VERSION}

# Deliberately no NODE_OPTIONS here: the V8 heap cap has to sit under the container
# memory limit, so it is set in the manifest that sets the limit (compose/k8s) and
# cannot drift away from it.

USER node
EXPOSE 3000 9464

# /healthz, not /readyz: a dependency going away makes /readyz fail so the ingress
# stops sending traffic, and restarting the process would only lose the in-memory
# cache and idempotency map. So liveness must not read dependency state.
HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=3 \
    CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.METRICS_PORT||9464)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

CMD ["node", "apps/api/dist/server.js"]
