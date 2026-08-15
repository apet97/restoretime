# RestoreTime container image (docs/15 "Candidate pipeline" step 3, docs/05 "Configuration").
#
# Two stages on the SAME base image family (node:22-bookworm-slim, glibc) — `better-sqlite3`
# ships a compiled native binary; mixing glibc and musl (e.g. an alpine runtime) between build and
# run would produce a binary the runtime process cannot load, and `/healthz`'s `SELECT 1` is the
# check that would catch it, not a build-time failure. `builder` compiles the native module,
# TypeScript, and the UI bundle, then removes development dependencies. `runtime` copies the built
# `dist/` (which already contains the SQL migrations) and production `node_modules`, then drops to
# a non-root user before `CMD`. Build tools never enter the runtime image.

# ---- builder: full devDependencies, compiles src/ -> dist/ -----------------------------------
FROM node:22-bookworm-slim@sha256:d649c27dae7ba0137b3cef5dd75baa422c08dc3d9e3fc0c23dfb172dc3cc6436 AS builder
WORKDIR /app
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY .dockerignore Dockerfile ./
COPY scripts/source-fingerprint.mjs ./scripts/source-fingerprint.mjs
COPY src ./src
RUN node scripts/source-fingerprint.mjs > /tmp/restoretime-source-fingerprint
RUN npm run build
RUN npm prune --omit=dev

# ---- runtime: non-root, dist + prod node_modules only -----------------------------------------
FROM node:22-bookworm-slim@sha256:d649c27dae7ba0137b3cef5dd75baa422c08dc3d9e3fc0c23dfb172dc3cc6436 AS runtime
ENV NODE_ENV=production
WORKDIR /app

# The upstream node image ships a `node` user (uid/gid 1000) already — reuse it rather than
# defining a new one (AGENTS.md rule 15: no abstraction without a concrete requirement).
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /tmp/restoretime-source-fingerprint ./.restoretime-source-fingerprint
COPY package.json ./

# Package managers are build tools. The running service does not use them. Remove them from the
# final image so their command-line dependency trees cannot add runtime vulnerabilities.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack /opt/yarn-v1.22.22 \
  && rm -f /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
    /usr/local/bin/yarn /usr/local/bin/yarnpkg

# docs/05 "Configuration" — the seven environment variables this process reads at boot
# (src/config.ts `loadConfig`). None have a baked-in default beyond `PORT` (8080) and `LOG_LEVEL`
# ("info"); the rest are required and `loadConfig` fails fast with an actionable message if any is
# missing.
#   PORT                    HTTP listen port (default 8080)
#   PUBLIC_BASE_URL         Addon public HTTPS origin (manifest baseUrl, CSP) — required
#   CLOCKIFY_PARENT_ORIGIN  Clockify app origin: production https://app.clockify.me,
#                           developer https://developer.clockify.me — required
#   DATABASE_PATH           SQLite file path — required; mount a persistent volume under it
#   ADDON_KEY               Manifest key; JWT `sub` check — required
#   TOKEN_ENCRYPTION_KEY    32-byte (64 hex char) key for the installation-token codec — required,
#                           secret; pass on the run command line or via a secrets manager, never
#                           bake it into the image or a committed file
#   LOG_LEVEL               debug|info|warn|error (default info)

RUN mkdir -p /data && chown node:node /data

USER node
EXPOSE 8080

# No curl in a `-slim` image; Node 22 ships a native `fetch`, so the healthcheck needs no extra
# package (docs/14 "Health": GET /healthz -> 200 {status:"ok", db:"ok"} after a SELECT 1).
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["node", "dist/server.js"]
