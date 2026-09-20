# ---- Build stage ----
FROM node:20-bookworm-slim AS build

WORKDIR /app

RUN npm install -g pnpm@9

COPY package.json pnpm-lock.yaml* ./
# --shamefully-hoist forces a flat node_modules layout so binaries like
# `node_modules/prisma/build/index.js` resolve the same way npm would.
# Without it, pnpm's isolated layout breaks `pnpm run db:generate` because
# the prisma CLI shim expects a hoisted package.
RUN pnpm install --no-frozen-lockfile --unsafe-perm --shamefully-hoist

COPY . .
RUN pnpm exec prisma generate
RUN pnpm exec tsc

# ---- Production stage ----
FROM node:20-bookworm-slim AS production

WORKDIR /app

# Install mongodump (v7) + pg_dump v17 (matches Neon, RDS PG17) +
# mariadb-client (works against MySQL 8 in practice — Aiven, Cloud SQL, RDS).
#
# Why postgresql-client-17 explicitly (not Debian's stock postgresql-client=15):
#   pg_dump refuses to dump a server NEWER than itself ("server version mismatch").
#   Debian bookworm ships v15; Neon runs v17 → backups would fail.
#
# Why mariadb-client (default-mysql-client) for MySQL:
#   Oracle's own MySQL APT repo currently ships an expired GPG key. mariadb's
#   mysqldump is API-compatible with MySQL 8 dumps. If we hit caching_sha2_password
#   issues we'll add `--default-auth=mysql_native_password` at the call site.
RUN apt-get update && \
  apt-get install -y --no-install-recommends ca-certificates curl gnupg && \
  install -d -m 0755 /etc/apt/keyrings && \
  \
  # MongoDB 7
  curl -fsSL https://www.mongodb.org/static/pgp/server-7.0.asc \
    | gpg --dearmor -o /etc/apt/keyrings/mongodb-server-7.0.gpg && \
  echo "deb [ arch=amd64,arm64 signed-by=/etc/apt/keyrings/mongodb-server-7.0.gpg ] https://repo.mongodb.org/apt/debian bookworm/mongodb-org/7.0 main" \
    > /etc/apt/sources.list.d/mongodb-org-7.0.list && \
  \
  # PostgreSQL 17 (PGDG)
  curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc \
    | gpg --dearmor -o /etc/apt/keyrings/postgresql.gpg && \
  echo "deb [signed-by=/etc/apt/keyrings/postgresql.gpg] https://apt.postgresql.org/pub/repos/apt bookworm-pgdg main" \
    > /etc/apt/sources.list.d/pgdg.list && \
  \
  apt-get update && \
  apt-get install -y --no-install-recommends \
    mongodb-database-tools \
    postgresql-client-17 \
    default-mysql-client && \
  rm -rf /var/lib/apt/lists/*

# Copy the entire node_modules from the build stage (includes prisma CLI and
# all prod deps). Both stages use the same base image so native binaries are
# compatible. This avoids a second pnpm install and any network calls here.
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/dist ./dist
COPY --from=build /app/prisma ./prisma

# Re-generate the Prisma client so the query-engine binary is linked against
# this stage's glibc (same image, so it's a no-op rebuild — fast and safe).
RUN node_modules/.bin/prisma generate

EXPOSE 3001

# Run migrations then start the server. migrate deploy is idempotent so it's
# safe on every restart and eliminates the need for a separate post-deploy step.
CMD ["sh", "-c", "node_modules/.bin/prisma migrate deploy && node dist/index.js"]

# ---- Development stage ----
FROM node:20-bookworm-slim AS development

WORKDIR /app

# Install mongodump / mongorestore (mongodb-database-tools).
# Notes:
#   - Debian's repo component is `main`, NOT `multiverse` (that's Ubuntu).
#   - `apt-key` is deprecated in Debian 12; use a keyring file + signed-by instead.
RUN apt-get update && \
  apt-get install -y --no-install-recommends ca-certificates curl gnupg && \
  install -d -m 0755 /etc/apt/keyrings && \
  curl -fsSL https://www.mongodb.org/static/pgp/server-7.0.asc \
    | gpg --dearmor -o /etc/apt/keyrings/mongodb-server-7.0.gpg && \
  echo "deb [ arch=amd64,arm64 signed-by=/etc/apt/keyrings/mongodb-server-7.0.gpg ] https://repo.mongodb.org/apt/debian bookworm/mongodb-org/7.0 main" \
    > /etc/apt/sources.list.d/mongodb-org-7.0.list && \
  apt-get update && \
  apt-get install -y --no-install-recommends \
    mongodb-database-tools \
    postgresql-client \
    default-mysql-client && \
  rm -rf /var/lib/apt/lists/*

RUN npm install -g pnpm@9

COPY package.json pnpm-lock.yaml* ./
RUN pnpm install

COPY . .

EXPOSE 3001

CMD ["pnpm", "dev"]
