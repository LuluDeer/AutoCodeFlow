# O-4/U-2: 与 CI 的 node-version '24' 对齐——且 executor-node package.json
# engines 已声明 "node": ">=24"，旧 node:22-alpine 与其自相矛盾
FROM node:24-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:24-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=builder /app/dist ./dist

# Q-09: run as non-root user
RUN addgroup -S appgroup && adduser -S appuser -G appgroup \
    && mkdir -p /data/tasks && chown -R appuser:appgroup /data/tasks /app
USER appuser

EXPOSE 8002

# O-1: 内置健康探针（独立 docker run / K8s 形态可用）
HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
  CMD wget -qO- http://localhost:8002/health || exit 1

CMD ["node", "dist/main.js"]
