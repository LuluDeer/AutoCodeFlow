# AutoCodeFlow Admin API

> **受众**：开发、调试或部署控制面后端的工程师 · **状态**：稳定 · **最后核对**：2026-11-22

AutoCodeFlow 控制面后端，基于 NestJS 12 + TypeORM + PostgreSQL 16 + Redis 7 / BullMQ 构建，承担全部调度决策、任务/执行状态机、执行器注册与派发、实时日志流（SSE）、产物管理、RBAC / API Key / OIDC SSO、SOP 与 Agent 编排、告警通知及全量审计。

## 快速开始

前置依赖：Node.js `>= 24`、PostgreSQL 16、Redis 7（可用仓库根 `make infra-up` 启动基础设施）。

```bash
cd apps/admin-api
npm install

# 运行数据库迁移（migrationsRun=false，启动前必须显式执行）
npm run migration:run

# 开发模式（监听 3105，非生产环境自动暴露 Swagger /api/docs）
npm run start:dev
```

生产构建与启动：

```bash
npm run build
npm run migration:run:prod
npm run start:prod
```

## 默认端口与端点

| 端点 | 默认地址 / 路径 | 说明 |
|------|----------------|------|
| HTTP API 根路径 | `http://localhost:3105/api` | 由 `PORT` 控制，默认 `3105`；所有业务路由挂在 `/api` 前缀下 |
| Swagger / OpenAPI | `http://localhost:3105/api/docs` | 仅非 `production` 环境启用，支持中/英描述切换 |
| 存活 / 就绪探针 | `/api/health/live` · `/api/health/ready` | 容器与负载均衡健康检查 |
| Prometheus 指标 | `/api/metrics` | 默认需 JWT；可通过 `METRICS_PROMETHEUS_ENABLED=false` 关闭 |

## 模块结构

核心业务模块位于 `src/modules/`（共 22 个模块）：

- **调度与任务**：`task`、`task-template`、`scheduler`、`runtime`、`artifacts`
- **应用与执行器**：`application`（含互斥组 `mutex-groups` 与部署审批）、`executor`、`executor-package`、`registry`
- **SOP 与 Agent**：`sop`、`agent`、`ai`
- **权限与多租户**：`auth`、`users`、`api-keys`、`project`、`audit`
- **通知与观测**：`notification`、`event-subscriptions`、`health`、`metrics`、`config`

配置读取受 ARCH-27 约束：新增环境变量须先在 `src/app.module.ts` 的 Joi `validationSchema` 注册，并在 `src/config/configuration.ts` 映射，业务代码一律通过 `ConfigService` 读取（禁止直读 `process.env`）。

## 常用环境变量

完整清单见仓库根 `.env.example` 与 [部署指南](../../docs/deployment.md)，核心启动项如下：

| 变量 | 说明 | 默认值 / 要求 |
|------|------|---------------|
| `PORT` | HTTP 监听端口 | `3105` |
| `NODE_ENV` | 运行环境（`development` / `production` / `test`） | `development` |
| `DB_HOST` / `DB_PORT` / `DB_USERNAME` / `DB_PASSWORD` / `DB_DATABASE` | PostgreSQL 连接参数（亦支持 `DATABASE_URL`） | 必填 |
| `REDIS_HOST` / `REDIS_PORT` / `REDIS_PASSWORD` | Redis / BullMQ 连接参数 | 必填 |
| `JWT_SECRET` / `JWT_REFRESH_SECRET` | 访问与刷新令牌签名密钥 | 生产必填 |
| `EXECUTOR_SECRET` | 执行器共享注册密钥 | 生产必填 |
| `INITIAL_ADMIN_PASSWORD` | 首次启动初始化 `admin` 密码（`>= 8` 位强口令） | 首次启动必填 |
| `API_BASE_URL` / `ADMIN_API_URL` | 对外可达基址（供执行器下载包与回连） | 按部署环境填写 |
| `ALLOW_LOOPBACK_CORS` | 是否在 `NODE_ENV=production` 允许 `localhost` CORS | `false`（本地试跑需设 `true`） |
| `ALLOW_PRIVATE_NETWORK` | 出站 SSRF 守卫是否放行 RFC1918 私网（loopback 恒拒） | `false` |

## 常用脚本

```bash
npm run typecheck           # 应用源码类型检查
npm run typecheck:specs     # 测试用例类型检查
npm run lint                # ESLint 只读检查（修复请用 npm run lint:fix）
npm test                    # Jest 单元测试
npm run test:e2e            # Jest E2E 测试（需可用 PG / Redis）
npm run check:route-authz   # 路由鉴权矩阵守卫
npm run swagger:export      # 导出 openapi.json 并注入英文翻译（x-i18n-en）
npm run migration:show      # 查看 TypeORM 迁移状态
```

## 相关文档

- [API 参考](../../docs/api-reference.md)
- [部署指南](../../docs/deployment.md)
- [开发指南](../../docs/development.md)
- [运维手册](../../docs/operations.md)
- [架构图谱（Atlas）](../../docs/atlas/README.md)
