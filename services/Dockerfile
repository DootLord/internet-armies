# One Dockerfile for every Node service: pick it with --build-arg SERVICE=shard
# (Compose sets this per service). Build context is the repo root, because a
# service bundles code from shared/ and services/kit/ too.

# ---- Stage 1: build ---------------------------------------------------------
FROM node:24-alpine AS build
WORKDIR /repo

# Manifests first, so the slow `npm ci` layer is reused until dependencies change.
COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY client/package.json client/
COPY services/kit/package.json services/kit/
COPY services/accounts/package.json services/accounts/
COPY services/shard/package.json services/shard/
COPY services/gateway/package.json services/gateway/
RUN --mount=type=cache,target=/root/.npm npm ci --ignore-scripts

COPY shared shared
COPY services services
ARG SERVICE
RUN test -n "$SERVICE" && cd services/$SERVICE && npm run build

# ---- Stage 2: run -----------------------------------------------------------
# Just Node and one bundled file (dependencies are inlined), running as a non-root user.
FROM node:24-alpine
ARG SERVICE
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /repo/services/$SERVICE/dist ./
USER node
CMD ["node", "--enable-source-maps", "main.js"]
