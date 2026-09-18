# 基础设施总览
> 所属: docs/atlas/06-infra · 最后核对: 2026-09-13 · 对应代码: docker-compose.yml、infra/docker-compose.yml、infra/nginx/、.github/workflows/、deploy.sh

## 一句话定位

AutoCodeFlow 的部署面 = 两份 compose（根目录完整部署 / `infra/` 仅基础设施）+ admin-web 容器内置 nginx 反代 + GitHub Actions 四个 workflow。所有服务经 `.env` 注入机密（复制 `.env.example`）。

## 组件拓扑（根目录 docker-compose.yml 完整形态）

```
                        host
 ────────────────────────────────────────────────────────────────────
   :80  admin-web(nginx) ── /api/、SSE ───────────────┐   [public 网络]
    │  SPA 静态文件                                  │
    ▼                                               ▼
   :3105 admin-api ─────────────────────────────────────┐
    │  │  │                                             │
    │  │  └── BullMQ 任务队列/调度 ──► redis:6379       │
    │  └──────── TypeORM 读写 ──────► postgres:5432     │  [internal 网络]
    │                 (可选 replica profile)            │
    ├─ 派发执行 ──► executor-python:8001 / executor-node:8002
    │                    │  回调/心跳/产物 ──► 回 admin-api
    │                    └─ 依赖包 ──► registry-pypi:8003 / registry-npm:4873
    ├─ 产物/日志对象 ──► minio:9000 (profile minio)
    └─ 预留追踪 ──────► jaeger:4317/4318/16686 (profile jaeger)
 host 侧端口一律 127.0.0.1 回环映射（executor/registry/minio/jaeger），仅 80 与 3105 对外。
```

## 端口表（compose 声明，均已核实）

| 端口 | 服务 | 宿主映射 | 说明 |
|---|---|---|---|
| 80 | admin-web（nginx:alpine） | `80:80` | SPA + `/api/` 反代入口 |
| 3105 | admin-api | `3105:3105` | 全局前缀 `/api`；Swagger `/api/docs` 仅非生产 |
| 5432 | postgres（16-alpine） | 根 compose 仅内网；`infra/` 映射 `127.0.0.1:5432` | 主库 |
| 6379 | redis（7-alpine） | 同上 | BullMQ + 缓存 |
| 8001 | executor-python | `127.0.0.1:8001` | 本机开发 `uvicorn` 同端口 |
| 8002 | executor-node | `127.0.0.1:8002` | 本机开发同端口 |
| 8003 | registry-pypi | `127.0.0.1:8003` | 自建 PyPI |
| 4873 | registry-npm（verdaccio:5） | `127.0.0.1:4873` | 私有 npm；healthcheck 必须打 `127.0.0.1`（IPv4-only 监听，R8） |
| 9000/9001 | minio（profile minio） | `127.0.0.1` | S3 对象/控制台 |
| 4317/4318/16686 | jaeger（profile jaeger） | `127.0.0.1` | OTLP gRPC/HTTP、UI |

## 依赖服务与版本要求

| 依赖 | 版本 | 依据 |
|---|---|---|
| PostgreSQL | **16**（`postgres:16-alpine`） | 根/infra compose、CI services 一致 |
| Redis | **7**（`redis:7-alpine`；Windows e2e 用 8.10.1 portable） | compose、ci.yml |
| Node.js | **24**（CI/发布矩阵） | ci.yml、release.yml |
| Python | **3.12**（CI；本地 ≥3.9 可跑 SDK） | ci.yml、autoflow-sdk README |
| Docker / Compose | `deploy.sh` 强校验两者存在 | deploy.sh |

## 两份 compose 的分工

- 根 `docker-compose.yml`（413 行）：完整部署——9 个常驻服务 + 3 个 profile 服务（`replica` / `minio` / `jaeger`），双网络（`autoflow-internal` 内部隔离 + `autoflow-public` 出口），8 个命名卷。
- `infra/docker-compose.yml`（51 行）：本地开发仅起 postgres + redis（回环映射），应用全部 `npm run start:dev` 起进程。

## 本目录文档

- [docker-compose.md](docker-compose.md) — 逐服务拆解（镜像/卷/健康检查/depends_on/profile）
- [deployment-and-ci.md](deployment-and-ci.md) — deploy.sh + 四个 GitHub workflow + multi-arch 镜像
- [env-vars.md](env-vars.md) — `.env.example` 全量变量分组表
- [scripts.md](scripts.md) — Makefile/dev.sh/init-db.sh/scripts/ 自测脚本地图
- [nginx-and-reverse-proxy.md](nginx-and-reverse-proxy.md) — 反代 SSE 语义与 `test:nginx-sse`

## 操作路径速查

| 场景 | 命令 |
|---|---|
| 本地开发 | `./dev.sh`（或 `make dev`）→ 管理台 `http://localhost:5176`、API 文档 `http://localhost:3105/api/docs` |
| 仅起 PG/Redis | `make infra-up` / `docker compose -f infra/docker-compose.yml up -d` |
| 完整部署 | `./deploy.sh -e production -b`；健康判定 `curl http://localhost:3105/api/health` 含 `healthy` |
| 追加可选服务 | `docker compose --profile minio\|jaeger\|replica up -d` |
| 看日志/状态 | `make logs` / `make status` |
| 反代门禁 | `npm run test:nginx-sse`（详见 [nginx-and-reverse-proxy.md](nginx-and-reverse-proxy.md)） |

健康检查端点（admin-api 全部 @Public）：`/api/health/live|ready|services|metrics`——compose 各服务 healthcheck 打的就是这些（admin-web 打自身 nginx `/health`）。

## 常见坑

1. `.env` 不存在时 `deploy.sh` 会复制模板并**退出 1**，属预期（提醒先填机密）。
2. `MINIO_ROOT_PASSWORD` 无默认值，启用 minio profile 前必须设置，否则容器起不来。
3. 宿主回环映射是刻意的（S9/SEC 面）；要从外部访问执行器/私服需显式覆盖端口映射。
4. postgres 容器 `mem_limit 1g` + `shm_size 256mb` 是为审计聚合/迁移索引调过的，别改回 512M/64M 默认。
