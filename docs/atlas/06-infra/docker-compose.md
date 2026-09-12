# docker-compose 逐服务拆解
> 所属: docs/atlas/06-infra · 最后核对: 2026-09-13 · 对应代码: docker-compose.yml（根，413 行）、infra/docker-compose.yml（51 行）

## 怎么用

```bash
cp .env.example .env && vi .env          # 必填机密见 env-vars.md
./deploy.sh -e production -b             # 或 docker-compose up -d
docker compose --profile minio up -d     # 追加可选服务（replica/minio/jaeger 同理）
```

根 compose 网络：`autoflow-internal`（`internal: true`，服务间通信）+ `autoflow-public`（对外）。日志统一 `json-file`，`max-size 10m / max-file 5`。

## 服务清单（根 docker-compose.yml，11 个）

### postgres（基础设施）
- 镜像 `postgres:16-alpine`；env `POSTGRES_USER/PASSWORD/DB`；卷 `postgres_data`；`mem_limit 1g`、`shm_size 256mb`（审计聚合与迁移索引需要）。
- healthcheck `pg_isready -U $POSTGRES_USER`（10s/5 次.retry，start_period 30s）；仅 internal 网络。

### postgres-replica（profile: `replica`，ARCH-24）
- 同镜像；**演示形态**：不做真流复制，只提供可连空实例供联调 `DB_READ_REPLICA_URL` 的读写路由。真实读副本用云 RDS / PG 流复制。无端口映射。

### redis（基础设施）
- 镜像 `redis:7-alpine`；卷 `redis_data`；healthcheck `redis-cli ping`；deploy 限额 256M/0.5 CPU。

### admin-api（核心）
- build `./apps/admin-api`；端口 `3105:3105`；`mem_limit 768m`。
- env：DB 指向 `postgres`、Redis 指向 `redis`、`JWT_SECRET/JWT_REFRESH_SECRET/EXECUTOR_SECRET`、`CORS_ORIGINS/ADMIN_WEB_ORIGIN`、`AI_PROVIDER`、`LOG_STORAGE_*`（driver db|s3）、`INITIAL_ADMIN_EMAIL/PASSWORD` 等（全表见 [env-vars.md](env-vars.md)）。
- **depends_on：postgres + redis 均 `service_healthy`**；healthcheck `wget http://localhost:3105/api/health/live`（start_period 60s）。

### admin-web（入口）
- build `./apps/admin-web`；端口 `80:80`；**depends_on：admin-api `service_healthy`**。
- env：`REACT_APP_API_URL`、`VITE_API_URL_INTERNAL/EXTERNAL`；镜像内置 nginx（`apps/admin-web/nginx.conf`）做 SPA + 反代；healthcheck `wget http://localhost/health`（nginx 直返 200 'ok'）。

### executor-python
- build `./apps/executor-python`；端口 `127.0.0.1:8001:8001`；`mem_limit 1G`。
- env：`APP_NAME=executor-python-1`、`PORT=8001`、`REQUIRE_TOKEN=true`（S9 fail-closed）、`EXECUTOR_ADDRESS=executor-python:8001`、`ADMIN_API_URL=http://admin-api:3105`、`PYPI_REGISTRY_URL=http://registry-pypi:8003/simple/`。
- **SEC-07 最小权限双闸**：`cap_drop: ['ALL']` + `security_opt: no-new-privileges:true`（镜像已 non-root）。卷 `executor_python_data:/data/tasks`；depends_on admin-api healthy；healthcheck `python -c urllib… http://localhost:8001/health`。

### executor-node
- build `./apps/executor-node`；端口 `127.0.0.1:8002:8002`；`mem_limit 1G`。
- env 同 python 侧对应项，另有 `MAX_CONCURRENT_TASKS=10`、`NPM_REGISTRY_URL=http://registry-npm:4873`、`PYTHON_REGISTRY_URL=http://registry-pypi:8003/simple/`；`cap_drop`/`no-new-privileges` 同上。
- 卷 `executor_node_data:/data/tasks`；depends_on admin-api healthy；healthcheck wget `http://localhost:8002/health`。

### registry-pypi
- build `./apps/registry-pypi`；端口 `127.0.0.1:8003:8003`；env `REGISTRY_USER/PASS`、`PYPI_API_KEY`、`PACKAGES_DIR=/data/packages`；卷 `pypi_data`；healthcheck urllib 打本机 `/health`。

### registry-npm
- 镜像 `verdaccio/verdaccio:5`；端口 `127.0.0.1:4873:4873`；卷 `npm_data:/verdaccio/storage` + `./apps/registry-npm/config.yaml:/verdaccio/conf/config.yaml:ro`。
- healthcheck 必须打 **`http://127.0.0.1:4873/-/ping`**——verdaccio 5 只监听 IPv4，容器内 `localhost` 先解析 `::1` 导致恒 unhealthy（R8 实爆）。

### minio（profile: `minio`）
- 镜像 `minio/minio:latest`，`command: server /data --console-address ':9001'`；端口 `127.0.0.1:9000`、`127.0.0.1:9001`；卷 `minio_data`。
- `MINIO_ROOT_PASSWORD` **无默认值**（缺失即启动失败）。启用后把 admin-api 的 `LOG_STORAGE_DRIVER=s3`；注意 bucket 生命周期需自行配置（admin 侧清理不覆盖外置对象）。

### jaeger（profile: `jaeger`，OBS-01）
- 镜像 `jaegertracing/all-in-one:1.57`；`COLLECTOR_OTLP_ENABLED=true`；端口 `127.0.0.1:4317/4318/16686`；卷 `jaeger_data:/badger`。
- 现状：平台仅用 `@opentelemetry/api`，span 未出站——此服务为未来接 Jaeger/Tempo 预置，未启用时零资源。

## 卷清单（8 个命名卷）

`postgres_data` `redis_data` `minio_data` `pypi_data` `npm_data` `executor_python_data` `executor_node_data` `jaeger_data`

## 依赖链（depends_on 汇总）

```
postgres(healthy) ─┐
                   ├─► admin-api(healthy) ─┬─► admin-web
redis(healthy) ────┘                       ├─► executor-python
                                           └─► executor-node
registry-pypi / registry-npm / minio / jaeger：无 depends_on 约束（执行器经内网访问）
```

## infra/docker-compose.yml（本地开发）

- 仅 `postgres`（`127.0.0.1:5432`）+ `redis`（`127.0.0.1:6379`），同镜像同健康检查，无应用服务。
- 用法：`docker compose -f infra/docker-compose.yml up -d` 后 `npm run start:dev` / `make dev`。

## 常见坑

1. admin-web 依赖 admin-api 的 healthcheck，admin-api `start_period 60s`——首次冷启动整体要 1~2 分钟。
2. 执行器容器内 `ADMIN_API_URL` 固定写 `http://admin-api:3105`，跨机部署才用 `EXECUTOR_*_PUBLIC_ADDRESS` 覆盖注册地址。
3. `docker-compose down` 不删卷；清库用 `down -v`（`make clean`、`dev.sh clean` 即此语义）。
4. 根 compose 没有映射 postgres/redis 到宿主；要本机连库请用 `infra/` compose 或自行覆盖。

## 相关文档

- [README.md](README.md)（端口表/拓扑）· [env-vars.md](env-vars.md)（变量全表）· [nginx-and-reverse-proxy.md](nginx-and-reverse-proxy.md)（反代细节）
- 各应用实现：[../01-apps/admin-api/README.md](../01-apps/admin-api/README.md) 等
