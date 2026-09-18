# O-4/U-2: 与 CI 的 node-version '24' 对齐（此前 CI 在 Node 24 验证、镜像用 22，
# 存在 CI 绿但生产镜像行为不一致的盲区；admin-api devDeps @types/node ^24 已按
# Node 24 开发）
FROM node:24-alpine AS builder

WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:24-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=builder /app/dist ./dist

# Q-10: run as non-root user
RUN addgroup -S appgroup && adduser -S appuser -G appgroup \
    && chown -R appuser:appuser /app
USER appuser

EXPOSE 3105

# O-1: 内置健康探针——独立 docker run / K8s 部署时编排器可感知就绪；
# compose 中的 healthcheck 定义优先级更高，会覆盖本指令
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
  CMD wget -qO- http://localhost:3105/api/health/live || exit 1

CMD ["node", "dist/main.js"]
