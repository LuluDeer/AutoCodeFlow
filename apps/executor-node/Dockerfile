# O-4/U-2: 与 CI 的 node-version '24' 对齐——且 executor-node package.json
# engines 已声明 "node": ">=24"，旧 node:22-alpine 与其自相矛盾
FROM node:24-alpine@sha256:8a32c8cf649a49915a66e81e7a609223c708d0adabf288ee3f4077d765542f85 AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:24-alpine@sha256:8a32c8cf649a49915a66e81e7a609223c708d0adabf288ee3f4077d765542f85
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
# SHELL-RUNTIME: POSIX shell 任务在 routes/execute.ts 里硬编码 spawn('bash')；
# node:24-alpine 默认不带 bash，缺它时任务直接 ENOENT/exit 127。builder 不需要。
RUN apk add --no-cache bash
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
