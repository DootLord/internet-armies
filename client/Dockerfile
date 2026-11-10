# The web entrypoint: the built client, served by nginx, which also routes the
# API paths to the backend services (one public origin, so no CORS and the
# session cookie stays first-party). On Kubernetes an Ingress takes over the
# routing and this image only serves files.
#
# Build context is the repo root (the client imports shared/).

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
COPY client client
RUN npm run build -w @eden/client

# ---- Stage 2: serve ---------------------------------------------------------
FROM nginx:1.29-alpine
# Files in templates/ get ${VAR}s filled from the environment at container start.
COPY client/nginx.conf /etc/nginx/templates/default.conf.template
COPY --from=build /repo/client/dist /usr/share/nginx/html
ENV ACCOUNTS_UPSTREAM=http://accounts:3001 \
    GATEWAY_UPSTREAM=http://gateway:3000 \
    DNS_RESOLVER=127.0.0.11

EXPOSE 80
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1/healthz || exit 1
