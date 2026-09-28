# syntax=docker/dockerfile:1
#
# The queue worker image. Same build as the API (see the comment there about why
# they are not shared), different shutdown contract:
#
#   * only the internal listener (9465) — the worker has no public port at all;
#   * a long grace period, because a job killed mid-`report.generate` has to wait
#     out `LOCK_DURATION` before another pod may take it over; SIGTERM first makes
#     that wait rare, not shorter.
#
# Build from the repo root:  docker build -f apps/worker/Dockerfile -t saas/worker:local .

FROM node:22-alpine AS build
WORKDIR /repo
COPY package.json package-lock.json tsconfig.base.json tsconfig.build.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
COPY apps/worker/package.json apps/worker/
COPY db/package.json db/
RUN npm ci
COPY packages ./packages
COPY apps ./apps
COPY db ./db
RUN npm run build && npm prune --omit=dev

FROM node:22-alpine AS runtime
WORKDIR /repo
COPY --from=build --chown=node:node /repo/package.json ./package.json
COPY --from=build --chown=node:node /repo/node_modules ./node_modules
COPY --from=build --chown=node:node /repo/packages/shared/dist ./packages/shared/dist
COPY --from=build --chown=node:node /repo/packages/shared/package.json ./packages/shared/package.json
COPY --from=build --chown=node:node /repo/db/dist ./db/dist
COPY --from=build --chown=node:node /repo/db/package.json ./db/package.json
COPY --from=build --chown=node:node /repo/apps/worker/dist ./apps/worker/dist
COPY --from=build --chown=node:node /repo/apps/worker/package.json ./apps/worker/package.json

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    METRICS_PORT=9465 \
    SHUTDOWN_GRACE_MS=30000

ARG BUILD_SHA=unknown
ARG BUILD_VERSION=0.0.0-unknown
ENV BUILD_SHA=${BUILD_SHA} \
    BUILD_VERSION=${BUILD_VERSION}

USER node
EXPOSE 9465

HEALTHCHECK --interval=10s --timeout=3s --start-period=15s --retries=3 \
    CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.METRICS_PORT||9465)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

CMD ["node", "apps/worker/dist/main.js"]
