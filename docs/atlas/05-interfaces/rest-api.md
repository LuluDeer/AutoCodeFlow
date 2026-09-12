# REST 接口地图
> 所属: docs/atlas/05-interfaces · 最后核对: 2026-09-13 · 对应代码: apps/admin-api/src/modules/*（24 个 controller 文件，21 个路由前缀）

## 怎么调

- Base URL：`http://localhost:3105/api`（容器内服务名 `http://admin-api:3105/api`）。
- 需要认证的端点：`Authorization: Bearer <access_token|acf_…|executor_token>`；个别机器端点支持 `?token=` 兜底（如 `/executors/install.sh`、`artifact` 下载）。
- 全量字段级契约看 `apps/admin-api/openapi.json`；语义与限流细节看 `docs/api-reference.md`；各模块 DTO 细节进 [admin-api/modules/](../01-apps/admin-api/README.md) 单篇。
- 表中「鉴权」列：`公开`=@Public（多数仍需 executor token，见备注）；`JWT`=登录用户；`JWT+ADMIN`=另过 RolesGuard。

## Health（公开）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/health` | 全量健康检查（DB/Redis/队列/执行器/调度器） |
| GET | `/health/live` `·ready` `·services` `·metrics` | liveness / readiness / 服务明细 / 关键指标 |

## Auth（[auth 模块](../01-apps/admin-api/modules/auth.md)）

| 方法 | 路径 | 鉴权 | 说明 |
|---|---|---|---|
| POST | `/auth/login` | 公开 | 登录；TOTP 启用者返回 `totpRequired:true` 走两步 |
| POST | `/auth/totp/verify` | 公开 | TOTP 第二步签发 token |
| POST | `/auth/refresh` | 公开 | 刷新 access token（原子轮换） |
| POST | `/auth/logout` | JWT | 吊销我的全部 refresh token |
| GET | `/auth/profile` | JWT | 当前用户信息 |
| POST | `/auth/totp/setup·enable·disable` | JWT | TOTP 绑定/激活/关闭 |
| GET/DELETE | `/auth/sessions(/:id)` | JWT | 会话列表/吊销；`POST sessions/revoke-others` 吊销其余 |

## Users / Projects / API Keys（RBAC 面）

- `/users`：`POST`(ADMIN)、`GET` 列表(ADMIN)、`GET/PATCH /users/:id`、`DELETE /users/:id`(ADMIN)。
- `/projects`：CRUD + `GET/POST /:id/members`、`PATCH/DELETE /:id/members/:userId`（写面 ADMIN/Owner）、`GET /projects/me/roles`。
- `/api-keys`：`GET/POST`、`DELETE /:id`、`POST /:id/revoke`（JWT；API Key 限权访问见 [api-keys 模块](../01-apps/admin-api/modules/api-keys.md)）。

## Tasks（核心域，[task 模块](../01-apps/admin-api/modules/task.md)）

| 方法 | 路径 | 鉴权 | 说明 |
|---|---|---|---|
| POST | `/tasks` | JWT | 创建任务（内联 glue / gitRepo / 应用任务） |
| GET | `/tasks` | JWT | 分页列表（status/name 过滤） |
| POST | `/tasks/batch/trigger·pause·resume·delete` | JWT | 批量操作（另有前缀 `/tasks-batch/*` 同语义旧路由） |
| GET | `/tasks/executions/all` | JWT | 跨任务执行列表 |
| GET | `/tasks/executions/:execId(/logs)` | JWT | 全局定位执行详情/日志 |
| GET | `/tasks/scheduler/stats` | JWT | 调度器统计 |
| GET | `/tasks/:id` `·stats` `·versions` | JWT | 详情/执行统计/版本历史 |
| PATCH/DELETE | `/tasks/:id` | JWT | 更新（executorId 钉扎）/删除（强杀运行中执行） |
| PUT | `/tasks/:id/glue` | JWT | 更新内联 glue 脚本 |
| POST | `/tasks/:id/trigger` | JWT | 手动触发（限流 30/min 中档） |
| GET | `/tasks/:id/executions(/:execId)` | JWT | 任务作用域执行列表/详情 |
| GET | `/tasks/:id/executions/:execId/report·logs` | JWT | 报告/日志（行分页） |
| **GET** | **`/tasks/:id/executions/:execId/logs/stream`** | JWT | **日志 SSE 流（见下节）** |
| POST | `/tasks/:id/executions/:execId/analyze·kill` | JWT | AI 分析/强杀 |
| POST | `/tasks/:id/pause·resume·rollback` | JWT | 暂停/恢复/回滚配置 |
| POST | `/tasks/:id/versions/:versionId/rollback` | JWT | 版本回滚 |
| GET | `/tasks/:id/versions/:v1/compare/:v2` | JWT | 版本 diff |
| POST | `/tasks/:id/suggest-schedule` | JWT | AI 建议 cron |

## 执行回调与产物（执行器面）

| 方法 | 路径 | 鉴权 | 说明 |
|---|---|---|---|
| POST | `/executions/callback` | 公开+token | 执行结果/日志回调，批量 ≤100；接受共享 token 或 per-execution `v1.` token（[回调流程](../04-flows/execution-callback.md)） |
| PUT | `/executions/:execId/artifacts/:name` | 公开+token | 执行产物直传（MinIO/S3） |
| GET | `/tasks/executions/:execId/artifacts(/:name)` | JWT | 产物列表/下载 |

## Executors / Executor Packages

- `/executors`：`POST register`、`POST heartbeat`、`POST token`、`POST offline`（公开，token 鉴权，[注册流程](../04-flows/executor-registration.md)）；`GET install.sh`、`GET artifact/executor-node.tar.gz`（公开，共享 token，Bearer 优先 `?token=` 兜底）；`GET install-cmd`（JWT，生成一键安装命令）；`GET` 列表/`groups`/`tags`（JWT）；`GET/PATCH/DELETE /:id`、`POST /:id/reload-config·rotate-token·set-offline`、`GET /:id/executions·metrics`（JWT，rotate 需 ADMIN）。
- `/executor-packages`：类级 `JwtAuthGuard+RolesGuard` 全 ADMIN；`POST`（上传 ≤500MB）、`GET` 列表/`latest`/`:id`、`PATCH :id`、`DELETE :id`、`PATCH :id/deprecate·activate`、`POST :id/push`；例外：`GET /:id/download` 与 `POST /push-result` 为 @Public（执行器/机器回调面，token）。

## Applications / Deployments（[application 模块](../01-apps/admin-api/modules/application.md)）

- `/applications`：CRUD、`GET :id/versions·releases`、`POST :id/upgrade-all·sync-tasks·analyze·rollback/:deploymentId`（JWT）；`POST upload`（应用包 ≤200MB）；`POST webhook`（@Public，CI 机器回调，`ALERT_WEBHOOK_SECRET` 同族语义）。
- `/app-deployments`：`GET` 列表/`:id`、`POST applications/:appId/deploy`、`POST :id/upgrade·stop`、`GET approvals/pending`、`POST :id/approval/approve·reject·cancel`（JWT；DEP-04 第二人审批，[审批流](../04-flows/approval-flow.md)）；`POST heartbeat`（@Public，部署实例心跳）。

## Metrics / Notification / AI / Audit / Config / Registry / Events

- `/metrics`：`GET` `·summary` `·trend` `·executors` `·failures` `·scheduler`（JWT）。
- `/notification`：`GET channels`、`PATCH channels/:key`、`POST channels/:key/test`、`POST test·send`、`GET/POST silences`、`DELETE silences/:id`（JWT）。
- `/alerts`：`POST webhook`（@Public，告警平台回调入口）。
- `/ai`：`GET/POST config`、`POST test`（JWT；`AI_PROVIDER` 侧配置）。
- `/audit`：`GET`（filters 白名单）、`GET export`（JWT）。
- `/config`：`GET`、`GET :key`、`PUT`、`POST batch`、`DELETE :key`、`GET history(/:key)`、`POST history/:id/rollback`、`GET/POST executor-shared-token(/generate)`（读 JWT，写面 ADMIN，[config 模块](../01-apps/admin-api/modules/config.md)）。
- `/registry`：`GET pypi/packages`、`GET npm/packages`、`POST pypi/upload`（JWT，私服代理面）。
- `/event-subscriptions`：CRUD、`GET :id/dead-letters`、`POST :id/dead-letters/:dlId/replay`（JWT）。

## SSE 三条流（均为 `text/event-stream`，@Res() 直写、无 envelope、豁免限流）

| 流 | 路径 | 鉴权 | 语义要点 |
|---|---|---|---|
| 执行日志流 | `GET /api/tasks/:id/executions/:execId/logs/stream` | JWT | 逐行 `data:` 帧；空闲 `: ping` 保活（15s 档）；终态发 `event: done` + `data: [DONE]`；每执行有并发槽位，超限 503 |
| Dashboard 指标流 | `GET /api/metrics/stream` | JWT（或 `?access_token=`） | ~3s 推 `{summary, executors, scheduler}` 快照；空闲 ping 默认 15s（`METRICS_STREAM_*`）；全局槽位默认 32，超限 503 |
| 执行终态事件流 | `GET /api/executions/stream` | JWT（或 `?access_token=`） | 转发领域事件 `execution.completed/failed/killed`（FEAT-16）；空闲 ping 默认 30s（`EXECUTIONS_STREAM_IDLE_PING_MS`）；复用 metrics 槽位 |

三条流在反代层的存活语义（不缓冲/保活/读超时）见 [nginx-and-reverse-proxy](../06-infra/nginx-and-reverse-proxy.md)。

## 常见坑

1. `@Get(":id")` 与固定子路径的声明顺序敏感（executors 的 `install-cmd`/`install.sh` 必须在 `:id` 前），新增路由注意。
2. 上传体积：执行器包 500MB / 应用包 200MB，直连 admin-api 无 nginx 时也受框架/代理限制约束；经反代必须保留 `client_max_body_size 510m`。
3. 回调批量上限 100 条，`errorMessage` ≤4KB、`logs` ≤512KB（`CallbackItemDto`）。
4. `/uploads/packages/*` 静态下载已收口鉴权（JWT 或共享 token），旧版执行器会 401。

## 相关文档

- [README.md](README.md)（鉴权速查、OpenAPI 链）· [mcp-tools.md](mcp-tools.md) · [cli.md](cli.md) · [sdks.md](sdks.md)
- 手册全文：`docs/api-reference.md`；模块细节：[../01-apps/admin-api/modules/](../01-apps/admin-api/README.md)
