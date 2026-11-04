ARG NPM_REGISTRY=https://registry.npmmirror.com

# ==============================================================================
# Base: 公共 Node 环境
# ==============================================================================
FROM node:22-alpine AS base

ARG NPM_REGISTRY
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME/bin:$PATH"

ENV COREPACK_NPM_REGISTRY=$NPM_REGISTRY \
    pnpm_config_registry=$NPM_REGISTRY \
    COREPACK_DEFAULT_TO_LATEST=0

RUN corepack enable
WORKDIR /app

# ==============================================================================
# Stage 1: Install all dependencies (including dev)
# ==============================================================================
FROM base AS deps

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./

RUN pnpm install --frozen-lockfile --registry=$NPM_REGISTRY

# ==============================================================================
# Stage 2: Build
# ==============================================================================
FROM base AS builder

COPY --from=deps /app/node_modules ./node_modules
COPY . .

ENV PRISMA_CLI_QUERY_ENGINE_TYPE=binary
RUN DATABASE_URL="postgresql://placeholder:placeholder@localhost:5432/beaconix" \
    pnpm prisma:generate

RUN pnpm build

# ==============================================================================
# Stage 3: Production dependencies only
# ==============================================================================
FROM base AS prod-deps

# 只拷贝锁文件，利用 Docker 层缓存加速 fetch
COPY pnpm-lock.yaml pnpm-workspace.yaml ./

RUN pnpm fetch --prod --registry=$NPM_REGISTRY 

COPY package.json ./

RUN pnpm install --frozen-lockfile --prod --offline \
        --ignore-scripts \
        --registry=$NPM_REGISTRY

# ==============================================================================
# Stage 4: Production runner (Slim Version)
# ==============================================================================
FROM base AS runner

RUN apk add --no-cache iputils

WORKDIR /app
ENV NODE_ENV=production

# 拷贝编译产物和 Prisma 生成文件
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/src/generated ./src/generated
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/.env.example ./env
COPY --from=builder /app/prisma.config.ts ./prisma.config.ts

# 只复制生产依赖，不复制安装过程的中间文件
COPY --from=prod-deps /app/node_modules ./node_modules

# Prisma 清理：删缓存、CLI、无用引擎，只保留 linux-musl 运行时文件
RUN rm -rf node_modules/.cache \
           node_modules/prisma \
           node_modules/@prisma/engines \
           /root/.cache/prisma \
    && find node_modules/.prisma -type f -not -name "*linux-musl*" -name "*.node" -delete || true

ENV PORT=3000
EXPOSE $PORT

CMD ["node", "dist/src/main"]
