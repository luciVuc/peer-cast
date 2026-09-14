# ─── PeerCast — multi-stage image ────────────────────────────────────────────
# Builds the shared types + React PWA + Node server, then ships a lean runtime
# image that serves the API, the PeerJS signaling server, and the static PWA
# from a single Node process on one port.

# 1. Build stage ---------------------------------------------------------------
FROM node:22-bookworm-slim AS build
WORKDIR /app

# Native build toolchain for better-sqlite3 (fallback if no prebuilt binary).
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# Install workspace deps (copy manifests first for layer caching).
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/server/package.json packages/server/
COPY packages/web/package.json packages/web/
COPY packages/extension/package.json packages/extension/
RUN npm ci
# npm has a bug (npm/cli#4828) that prunes non-local platform bindings from a
# regenerated package-lock, so rollup's native binary for THIS container's
# arch is missing after `npm ci`. Download + extract just that binding — the
# workbox SW build in vite-plugin-pwa drives rollup, and rollup@4 hard-requires
# it. We use npm pack (not `npm install`) so the workspace tree is untouched.
# The binding is pinned to the exact rollup version already installed by
# `npm ci`, so native <-> JS version skew can never bite later minor bumps.
RUN ARCH=$(uname -m | sed 's/x86_64/x64/; s/aarch64/arm64/') \
  && ROLLUP_VER=$(node -p "require('./node_modules/rollup/package.json').version") \
  && TGZ=$(npm pack --silent "@rollup/rollup-linux-${ARCH}-gnu@${ROLLUP_VER}") \
  && tar -xzf "$TGZ" \
  && mkdir -p node_modules/@rollup \
  && rm -rf "node_modules/@rollup/rollup-linux-${ARCH}-gnu" \
  && mv package "node_modules/@rollup/rollup-linux-${ARCH}-gnu" \
  && rm -f "$TGZ"

# Copy sources and build shared → web → server.
COPY packages/shared packages/shared
COPY packages/server packages/server
COPY packages/web packages/web
RUN npm run build:shared \
  && npm run build:web \
  && npm run build:server

# 2. Runtime stage -------------------------------------------------------------
FROM node:22-bookworm-slim AS runtime
WORKDIR /app/packages/server
ENV NODE_ENV=production \
    PORT=8787 \
    DATABASE_FILE=/data/peercast.db \
    WEB_DIST=/app/packages/web/dist

# Preserve the workspace layout so the @peer-cast/shared symlink, nested
# package node_modules (npm doesn't always hoist), and the native
# better-sqlite3 binary all resolve exactly as they did at build time.
COPY --from=build /app/node_modules /app/node_modules
COPY --from=build /app/package.json /app/package.json
COPY --from=build /app/packages/shared/package.json /app/packages/shared/package.json
COPY --from=build /app/packages/shared/dist /app/packages/shared/dist
COPY --from=build /app/packages/server/package.json /app/packages/server/package.json
COPY --from=build /app/packages/server/node_modules /app/packages/server/node_modules
COPY --from=build /app/packages/server/dist /app/packages/server/dist
COPY --from=build /app/packages/web/dist /app/packages/web/dist

# Persist the SQLite database on a volume.
VOLUME ["/data"]
EXPOSE 8787

# The copied sources may carry restrictive host permissions; make the whole
# app readable/owned by the unprivileged runtime user.
RUN mkdir -p /data && chown -R node:node /app /data
USER node

CMD ["node", "dist/index.js"]
