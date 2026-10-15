
# Registry used to fetch the package manager and install dependencies.
# Override for restricted networks, e.g.
#   docker build --build-arg NPM_REGISTRY=https://registry.npmjs.org .
ARG NPM_REGISTRY=https://registry.npmmirror.com


# Stage 1: Install dependencies
FROM node:22-alpine AS deps

ARG NPM_REGISTRY
ENV COREPACK_NPM_REGISTRY=$NPM_REGISTRY \
    npm_config_registry=$NPM_REGISTRY

# `corepack enable` installs the pnpm version pinned by package.json's
# `packageManager` field, which is the one pnpm-lock.yaml was resolved with.
# Do not use `corepack prepare pnpm@latest`: it fetches the registry dist-tags
# on every build and can activate a pnpm other than the pinned one.
RUN corepack enable

WORKDIR /app

# pnpm-workspace.yaml carries the overrides and allowBuilds allowlist the
# lockfile was resolved with — without it --frozen-lockfile fails and native
# postinstall steps (prisma, bcrypt, esbuild) are skipped.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./

RUN pnpm install --frozen-lockfile


# Stage 2: Build
FROM node:22-alpine AS builder

ARG NPM_REGISTRY
ENV COREPACK_NPM_REGISTRY=$NPM_REGISTRY \
    npm_config_registry=$NPM_REGISTRY

RUN corepack enable

WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules

COPY . .

# No real DB needed at build time — generate only reads the schema file
RUN DATABASE_URL="postgresql://placeholder:placeholder@localhost:5432/beaconix" \
    pnpm prisma:generate

RUN pnpm build


# Stage 3: Production runner
FROM node:22-alpine AS runner

# PING uses the system binary; ICMP permissions are still controlled by deployment.
RUN apk add --no-cache iputils

WORKDIR /app

ENV NODE_ENV=production

RUN corepack enable

# Compiled app
COPY --from=builder /app/dist ./dist

# Runtime dependencies
COPY --from=builder /app/node_modules ./node_modules

# Generated Prisma client
COPY --from=builder /app/src/generated ./src/generated

# Prisma schema + migrations folder (needed for migrate deploy)
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/prisma.config.ts ./prisma.config.ts

# Needed by some packages at runtime
COPY package.json ./

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
    CMD wget -qO- http://localhost:3000/api/health/live || exit 1

# Run migrations first, then start the server
# DATABASE_URL is injected by Render at container startup — not available at build time
CMD ["sh", "-c", "npx prisma migrate deploy --config prisma.config.ts && node dist/src/main"]
