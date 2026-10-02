# syntax=docker/dockerfile:1

# ---- 构建阶段：安装依赖（优先 npmmirror 预编译二进制，失败则从源码编译）----
FROM node:20-bookworm AS builder
WORKDIR /app
COPY package.json package-lock.json* ./
# better-sqlite3 默认从 GitHub 下载预编译二进制；此处显式走 npmmirror 镜像，
# 下载失败时 npm 会自动回退到本地源码编译（bookworm 镜像自带 python3/make/g++）。
ENV npm_config_better_sqlite3_binary_host_mirror=https://registry.npmmirror.com/-/binary/better-sqlite3
RUN npm ci --omit=dev || npm install --omit=dev

# ---- 运行阶段：精简镜像 + 非 root + 可写数据目录 ----
FROM node:20-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
ENV DB_PATH=/data/app.db
# 本机持久化签名密钥目录：与数据库同在 /data 命名卷，容器重建不丢密钥，
# 轮换前的旧公钥也留存在该目录的公钥归档中，旧凭证可持续离线验证。
ENV ATTEST_KEY_DIR=/data/attestation-keys
COPY --from=builder /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY scripts ./scripts
COPY public ./public
COPY docker-entrypoint.sh ./docker-entrypoint.sh
RUN mkdir -p /data && chown -R node:node /data /app
USER node
EXPOSE 3000
ENTRYPOINT ["/bin/bash", "/app/docker-entrypoint.sh"]
