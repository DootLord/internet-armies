# ---- Stage 1: build ---------------------------------------------------------
# Full Node toolchain, only needed to compile the app. None of this ships.
FROM node:24-alpine AS build
WORKDIR /app

# Copy only the manifests first: this layer (and the slow `npm ci`) is cached
# until dependencies actually change, so code-only edits rebuild in seconds.
COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build

# ---- Stage 2: serve ---------------------------------------------------------
# Tiny static web server holding just the built files (~20 MB image).
FROM nginx:1.29-alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html

EXPOSE 80
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1/healthz || exit 1
