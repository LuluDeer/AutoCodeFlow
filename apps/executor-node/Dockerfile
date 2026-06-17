FROM node:22-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=builder /app/dist ./dist

# Q-09: run as non-root user
RUN addgroup -S appgroup && adduser -S appuser -G appgroup \
    && mkdir -p /data/tasks && chown -R appuser:appgroup /data/tasks /app
USER appuser

EXPOSE 8002
CMD ["node", "dist/main.js"]
