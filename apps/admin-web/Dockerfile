# U-2/O-4: builder 与 CI 的 node 24 对齐
FROM node:24-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

# O-2: nginx:alpine 浮动 tag → pin 到具体版本（构建可复现，大版本升级不再静默进入）
FROM nginx:1.27-alpine
COPY --from=builder /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80

# O-1: 内置健康探针（与 compose 的 healthcheck 同参；compose 定义优先）
HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
  CMD wget -qO- http://localhost/health || exit 1

CMD ["nginx", "-g", "daemon off;"]
