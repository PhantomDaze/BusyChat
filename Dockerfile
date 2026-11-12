# syntax=docker/dockerfile:1

# ---------------------------------------------------------------------------
# 构建阶段：安装全部依赖（含 devDependencies）并产出 dist/ + webui-dist/
# ---------------------------------------------------------------------------
FROM node:22-alpine AS builder
WORKDIR /app

# 先复制 manifest 与 lockfile，最大化利用 Docker 层缓存
COPY package.json package-lock.json ./
COPY webui/package.json webui/package-lock.json ./webui/
RUN npm ci && npm --prefix webui ci

# 再复制源码并构建（前端 Vite -> webui-dist/，后端 tsc -> dist/）
COPY tsconfig.json ./
COPY src ./src
COPY webui ./webui
RUN npm run build

# ---------------------------------------------------------------------------
# 运行阶段：仅保留生产依赖与构建产物，以非 root 用户运行
# ---------------------------------------------------------------------------
FROM node:22-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=production \
    DATA_DIR=/app/data \
    BUSYCHAT_DATA_DIR=/app/data \
    BUSYCHAT_HOST=0.0.0.0

# 只安装运行时依赖
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/webui-dist ./webui-dist
COPY config.example.json ./config.example.json
# 分发镜像时一并携带许可证与第三方致谢（AGPL-3.0）
COPY LICENSE NOTICE ./

# uid/gid 10001 固定下来，方便宿主机绑定目录时对齐权限；
# /app 需要可写，因为首次启动会在工作目录创建 config.json。
RUN addgroup -g 10001 -S busychat \
    && adduser -u 10001 -S -G busychat busychat \
    && mkdir -p /app/data \
    && chown -R busychat:busychat /app

USER 10001:10001

VOLUME ["/app/data"]
EXPOSE 3000

# 不依赖 wget/curl：使用 Node 内置 fetch 探测 /health
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:' + (process.env.BUSYCHAT_PORT || '3000') + '/health').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "dist/index.js"]
