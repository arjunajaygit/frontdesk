# syntax=docker/dockerfile:1.7
# Frontdesk production image. Multi-arch (arm64/amd64) via the pinned multi-arch base index digest.
# Targets:  runtime (default)  = app + compiled SPA, non-root, no dev dependencies, no Prisma CLI
#           migrate            = one-shot `prisma migrate deploy` tool (owner credentials, never the runtime)
ARG NODE_IMAGE=node:24.15.0-bookworm-slim@sha256:4e6b70dd6cbfc88c8157ba19aa3d9f9cce6ba4703576d55459e45efcbc9c5f5d

FROM ${NODE_IMAGE} AS base
WORKDIR /app
# openssl: required by the Prisma query engine on Debian slim. `upgrade` pulls security fixes published after the
# pinned base digest was cut (the base stays digest-pinned; patched packages are the one intentional moving part).
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates \
    && apt-get -y --no-install-recommends upgrade \
    && rm -rf /var/lib/apt/lists/*

# ---- all dependencies from the committed lockfile (reproducible) ----
FROM base AS deps
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/contracts/package.json packages/contracts/
RUN npm ci --ignore-scripts --no-audit --no-fund

# ---- deterministic build of contracts, API and web; Prisma client generation ----
FROM deps AS build
COPY tsconfig.base.json ./
COPY prisma/schema.prisma prisma/schema.prisma
COPY packages packages
COPY apps apps
COPY src/calendar.mjs src/calendar.mjs
RUN npx prisma generate --schema prisma/schema.prisma \
    && npm run build

# ---- production-only node_modules ----
FROM base AS prod-deps
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/contracts/package.json packages/contracts/
# @prisma/client lists the Prisma CLI and TypeScript as OPTIONAL PEER dependencies, and they are also root devDependencies,
# so the lockfile marks them `devOptional` and npm keeps them even with --omit=dev. The runtime only needs the generated
# client + query engine library (copied from the build stage). We therefore delete exactly the lockfile's `devOptional`
# set (prisma CLI, @prisma/config + effect + deepmerge-ts, TypeScript, ...): derived, not a hand-maintained list.
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund \
    && node -e "const fs=require('fs');const p=require('./package-lock.json').packages;let n=0;for(const [k,v] of Object.entries(p)){if(v.devOptional&&k.startsWith('node_modules/')){fs.rmSync(k,{recursive:true,force:true});n++}}console.log('removed devOptional packages:',n)" \
    && rm -rf node_modules/.cache \
    && npm cache clean --force

# ---- migration tool (separate image: the runtime never contains the Prisma CLI) ----
FROM base AS migrate
RUN npm install --prefix /opt/prisma --no-audit --no-fund --no-save prisma@6.19.3
COPY prisma/schema.prisma /app/prisma/schema.prisma
COPY prisma/migrations /app/prisma/migrations
ENV PATH=/opt/prisma/node_modules/.bin:$PATH
USER node
# DATABASE_URL (owner role) is supplied at run time by the operator/compose, never baked in.
ENTRYPOINT ["prisma", "migrate", "deploy", "--schema", "/app/prisma/schema.prisma"]

# ---- ops tools (explicit, never started automatically): `docker compose --profile ops run --rm seed` ----
FROM deps AS tools
COPY tsconfig.base.json ./
COPY prisma prisma
COPY packages packages
COPY apps/api apps/api
COPY src/calendar.mjs src/calendar.mjs
RUN npx prisma generate --schema prisma/schema.prisma && npm run build -w @frontdesk/contracts \
    && mkdir -p /app/.local && chown node:node /app/.local
USER node
CMD ["npx", "tsx", "prisma/seed.ts"]

# ---- runtime ----
FROM base AS runtime
# Release traceability: the exact Git commit is recorded in an OCI label and logged at startup (not a secret).
ARG GIT_SHA=unknown
LABEL org.opencontainers.image.revision=$GIT_SHA \
      org.opencontainers.image.title="frontdesk" \
      org.opencontainers.image.source="local"
ENV APP_COMMIT=$GIT_SHA \
    NODE_ENV=production \
    PORT=3000 \
    WEB_DIST_DIR=/app/apps/web/dist \
    NODE_OPTIONS=--enable-source-maps
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/node_modules/.prisma ./node_modules/.prisma
COPY package.json ./
COPY --from=build /app/packages/contracts/package.json packages/contracts/package.json
COPY --from=build /app/packages/contracts/dist packages/contracts/dist
COPY --from=build /app/apps/api/package.json apps/api/package.json
COPY --from=build /app/apps/api/dist apps/api/dist
COPY --from=build /app/apps/web/dist apps/web/dist
# The preserved calendar kernel is loaded at runtime from <repo root>/src/calendar.mjs (see calendar-kernel.ts).
COPY src/calendar.mjs src/calendar.mjs
# Supabase's public root CA (fingerprint pinned by tests/unit/supabase-ca.test.ts): lets the runtime VERIFY the database
# pooler certificate (DATABASE_URL ...&sslcert=/app/certs/supabase-prod-ca-2021.crt&sslaccept=strict). Public, not a secret.
COPY infrastructure/deploy/supabase/supabase-prod-ca-2021.crt /app/certs/supabase-prod-ca-2021.crt
# The runtime never invokes npm/npx/corepack/yarn: remove the package managers bundled with the base image
# (Trivy flagged HIGH/CRITICAL advisories in npm's own bundled dependencies, which the app never executes).
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
           /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /usr/local/bin/yarn /usr/local/bin/yarnpkg /opt/yarn-*
# No privilege boundary inside the image (final audit M04 review): strip every setuid/setgid bit (mount, umount, su,
# passwd, chfn, chsh, gpasswd, newgrp, chage, expiry, unix_chkpwd). The app never executes them, and hosts that do not
# enforce no-new-privileges (e.g. a PaaS) can then not turn a compromised process into root via util-linux/PAM bugs.
RUN find / -xdev -perm /6000 -type f -exec chmod a-s {} + \
    && test -z "$(find / -xdev -perm /6000 -type f)"
# Everything is root-owned and read-only for the app user; the process cannot modify its own code.
USER node
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=5s --start-period=40s --retries=3 \
    CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
CMD ["node", "apps/api/dist/main.js"]
