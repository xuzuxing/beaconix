ARG NPM_REGISTRY=https://registry.npmmirror.com

# ==============================================================================
# Stage 1: Install all dependencies (including dev)
# ==============================================================================
FROM node:22-alpine AS deps

ARG NPM_REGISTRY
ENV COREPACK_NPM_REGISTRY=$NPM_REGISTRY \
    pnpm_config_registry=$NPM_REGISTRY

RUN corepack enable
WORKDIR /app

# 关键：为了减小体积，只拷贝依赖清单
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./

# 安装依赖
RUN pnpm install --frozen-lockfile \
        --registry=$NPM_REGISTRY \
        --network-concurrency=4 \
        --fetch-retries=5

# ==============================================================================
# Stage 2: Build
# ==============================================================================
FROM node:22-alpine AS builder

ARG NPM_REGISTRY
ENV COREPACK_NPM_REGISTRY=$NPM_REGISTRY \
    pnpm_config_registry=$NPM_REGISTRY

RUN corepack enable
WORKDIR /app

# 从 deps 复用 node_modules
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# 生成 Prisma Client，同时只保留当前平台（linux-musl）的引擎
ENV PRISMA_CLI_QUERY_ENGINE_TYPE=binary
RUN DATABASE_URL="postgresql://placeholder:placeholder@localhost:5432/beaconix" \
    pnpm prisma:generate

RUN pnpm build

# ==============================================================================
# Stage 3: Production runner (Slim Version)
# ==============================================================================
FROM node:22-alpine AS runner

ARG NPM_REGISTRY
ENV COREPACK_NPM_REGISTRY=$NPM_REGISTRY \
    pnpm_config_registry=$NPM_REGISTRY

# 1. 替换软件源并安装系统工具
RUN apk add --no-cache iputils

WORKDIR /app
ENV NODE_ENV=production
RUN corepack enable

# 2. 拷贝编译产物和 Prisma 生成文件
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/src/generated ./src/generated
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/.env.example ./env
COPY --from=builder /app/prisma.config.ts ./prisma.config.ts

# 3. 拷贝清单
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./

# 4. 只安装生产依赖并立即清理缓存
# --ignore-scripts 防止 husky 等脚本报错；完成后立即清理 pnpm store
RUN pnpm install --frozen-lockfile --prod \
        --ignore-scripts \
        --registry=$NPM_REGISTRY \
        --network-concurrency=4 \
        --fetch-retries=5 \
    && pnpm store prune \
    && rm -rf /root/.local/share/pnpm/store /root/.npm

# 5. 裁剪 Prisma 引擎（可选，但极其有效）
# 如果你确定只在 alpine 上跑，可以删掉非 linux-musl 的引擎
RUN find node_modules/.prisma -type f -not -name "*linux-musl*" -name "*.node" -delete || true

ENV PORT=3000
EXPOSE $PORT

CMD ["sh", "-c", "node_modules/.bin/prisma migrate deploy --config prisma.config.ts && node dist/src/main"]
