# API 参考

所有接口基础路径：`http://localhost:3105/api`

交互式文档：`http://localhost:3105/api/docs`（Swagger UI，仅非生产环境开放）

## 认证说明

- 需要认证的接口须在请求头携带：`Authorization: Bearer <access_token>`
- Access Token 通过登录接口获取，有效期默认 15 分钟（`JWT_EXPIRES_IN`）
- Token 过期后使用 Refresh Token 接口刷新，无需重新登录
- 全局限流默认 60 次/分钟（`THROTTLE_LIMIT` / `THROTTLE_TTL`），超限返回 429；登录、刷新接口有更严格的独立限流；executor callback 端点限流 60 次/分钟（第四轮起不再豁免）
- 每个响应都携带 `X-Trace-Id` 响应头，排查问题时提供给运维
- **RBAC（第四轮起全局生效）**：标注「Admin」的端点要求 JWT `role=ADMIN`，普通用户返回 403。收紧范围：`/config` 全部写端点与共享 token 读写/回滚、`/executor-packages` 全部端点（`push-result` 机器回调仍走 executor token）。executor 的 heartbeat/register 等机器端点仍走 per-address token，不受用户角色影响

## 静态资源鉴权（/uploads）⚠️ 破坏性变更

应用包静态文件 `GET /uploads/packages/*`（不在 `/api` 前缀下）**不再公开下载**，每个请求必须携带以下任一凭证，否则返回 401：

1. 管理台用户 JWT：`Authorization: Bearer <access_token>`（与登录接口同源的 access token）
2. executor 共享 token：`Authorization: Bearer <EXECUTOR_SECRET 或系统配置中的 executor.sharedToken>`

> 该中间件不做数据库查询（不校验用户是否仍存在/启用），吊销依赖 access token 的短过期时间。
> `/uploads` 下当前没有任何匿名可访问的子路径（公开前缀白名单为空，fail closed）。
>
> **部署注意：** executor-node 下载应用包时会自动携带共享 token；**旧版本 executor-node 不携带凭证，会收到 401**，升级 admin-api 后必须同步升级 executor-node。

---

## Health — 健康检查

以下端点全部**无需认证**（`@Public`）：

| 方法 | 路径 | 需要认证 | 说明 |
|------|------|:--------:|------|
| GET | `/health` | 否 | 完整健康检查：数据库 / Redis / 队列 / 执行器 / 调度器状态与汇总指标 |
| GET | `/health/live` | 否 | Liveness 探针（K8s liveness），进程存活即返回 200 |
| GET | `/health/ready` | 否 | Readiness 探针（K8s readiness），校验 DB 与 Redis 连接 |
| GET | `/health/services` | 否 | 各核心服务健康明细（database / redis / queue / executors / scheduler） |
| GET | `/health/metrics` | 否 | 关键系统指标：任务总数、活跃任务、运行中执行、执行器在线数、队列长度 |

---

## Auth — 认证

| 方法 | 路径 | 需要认证 | 说明 |
|------|------|:--------:|------|
| POST | `/auth/login` | 否 | 用户名密码登录，返回 `accessToken` 与 `refreshToken`（camelCase；独立限流，默认 20 次/分钟） |
| POST | `/auth/refresh` | 否 | 使用 refresh_token 刷新 access_token（限流 10 次/分钟） |
| POST | `/auth/logout` | 是 | 登出，使当前 refresh_token 失效 |
| GET | `/auth/profile` | 是 | 获取当前登录用户信息 |

**登录请求示例：**

```json
POST /api/auth/login
{
  "username": "admin",
  "password": "<your_password>"
}
```

**登录响应示例：**

```json
{
  "code": 200,
  "message": "success",
  "data": {
    "accessToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
    "refreshToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
  }
}
```

---

## Applications — 应用管理

| 方法 | 路径 | 需要认证 | 说明 |
|------|------|:--------:|------|
| GET | `/applications` | 是 | 查询全部应用列表（返回数组，无分页） |
| POST | `/applications` | 是 | 创建新应用（name/version/runtime 必填） |
| GET | `/applications/:id` | 是 | 获取应用详情 |
| PUT | `/applications/:id` | 是 | 更新应用信息（含 `webhookSecret` 配置） |
| DELETE | `/applications/:id` | 是 | 删除应用 |
| POST | `/applications/upload` | 是 | 上传应用包（multipart/form-data，按名称 upsert） |
| GET | `/applications/:id/versions` | 是 | 版本历史快照（无快照的历史数据回退展示部署记录） |
| POST | `/applications/:id/upgrade-all` | 是 | 对所有 RUNNING 部署触发滚动升级 |
| POST | `/applications/:id/sync-tasks` | 是 | 解析应用 manifest.json 自动注册任务 |
| POST | `/applications/:id/analyze` | 是 | AI 应用健康分析（聚合全部任务执行统计） |
| POST | `/applications/:id/rollback/:deploymentId` | 是 | 回滚到指定版本快照/部署记录 |
| POST | `/applications/webhook` | 否（HMAC 签名） | CI/CD 触发发版部署；目标应用必须配置 `webhookSecret` 并使用 HMAC 签名 |

**上传应用包（POST /applications/upload）：**

multipart/form-data 字段：

| 字段 | 类型 | 必填 | 说明 |
|------|------|:----:|------|
| `file` | file | 是 | 应用包，仅接受 `.zip`（扩展名 + ZIP 魔数双重校验），上限 200 MB |
| `name` | string | 是 | 应用名称，最长 100 字符（超限/缺失返回 400；非法字符写入磁盘时替换为 `_`） |
| `runtime` | string | 否 | 运行时类型，最长 50 字符；新建应用时缺省为 `python` |

- 请求经全局 ValidationPipe 校验（whitelist + forbidNonWhitelisted），携带未声明字段会返回 400
- 按名称 upsert：应用已存在则只更新 `packageUrl`（可选更新 runtime），不存在则创建（初始版本 `1.0.0`）
- `packageUrl` 由 `API_BASE_URL` 拼接生成：`{API_BASE_URL}/uploads/packages/{filename}`
- **`API_BASE_URL` 未配置时直接返回 500（fail-fast）**，不再静默回退 `http://localhost:PORT` 生成不可达 URL

**Webhook 发版请求体：**

> 该接口对 CI/CD 调用方公开（`@Public`），不需要用户 Bearer JWT。目标应用必须配置 `webhookSecret`，请求必须携带：
>
> - `X-AutoCodeFlow-Timestamp`: 当前 Unix 毫秒时间戳，允许 5 分钟窗口。
> - `X-Hub-Signature-256`: `sha256=<hex>`，其中 `<hex>` 为 `HMAC_SHA256(webhookSecret, "${timestamp}.${rawBody}")`。
>
> ⚠️ 所有鉴权失败路径（应用不存在 / 未配置 `webhookSecret` / 缺失签名或时间戳 / 签名错误 / raw body 缺失）**统一返回相同的 401**（`"Webhook authentication failed"`），不区分具体原因——防止应用名枚举。具体失败原因只写入服务端日志。

```http
POST /api/applications/webhook
X-AutoCodeFlow-Timestamp: 1700000000000
X-Hub-Signature-256: sha256=<hex>
Content-Type: application/json

{
  "appName": "my-app",
  "version": "1.2.0",
  "gitCommit": "abc1234",
  "triggerDeploy": true
}
```

| 字段 | 类型 | 必填 | 说明 |
|------|------|:----:|------|
| `appName` | string | 是 | 应用名称（需与已创建的应用名称完全匹配） |
| `version` | string | 是 | 版本号（语义化版本，如 `1.2.0`） |
| `gitCommit` | string | 否 | Git commit SHA，随版本一起记录 |
| `gitBranch` | string | 否 | Git 分支名 |
| `triggerDeploy` | boolean | 否 | `true` 时对所有 RUNNING 部署触发滚动升级，默认 `false` |

**成功响应：** `{ ok: true, updatedApp, triggeredDeployments }`

---

## App Deployments — 应用部署

| 方法 | 路径 | 需要认证 | 说明 |
|------|------|:--------:|------|
| GET | `/app-deployments` | 是 | 分页查询部署列表，支持 `applicationId` 过滤（`page` 默认 1，`pageSize` 默认 20、最大 100） |
| GET | `/app-deployments/:id` | 是 | 获取部署详情 |
| POST | `/app-deployments/applications/:appId/deploy` | 是 | 将应用分配到执行器部署；`executorId` 留空时自动选择在线且负载最低的执行器 |
| POST | `/app-deployments/:id/upgrade` | 是 | 触发部署升级（overlay upgrade） |
| POST | `/app-deployments/:id/stop` | 是 | 停止运行中的部署 |
| POST | `/app-deployments/heartbeat` | 否* | 执行器上报应用运行状态（`deploymentId` + `status`: running/stopped/failed） |

**deploy 请求体（均可选）：**

| 字段 | 类型 | 说明 |
|------|------|------|
| `executorId` | UUID | 目标执行器；留空自动选择 |
| `runMode` | enum | 运行模式（默认 daemon） |
| `env` | object | 环境变量覆盖 |
| `startCommand` | string | 启动命令覆盖（留空使用 manifest entrypoint） |

> *heartbeat 使用 `X-Executor-Token` 请求头认证（按部署关联的执行器逐个校验 per-executor token，兼容旧共享 token），非用户 JWT。

---

## Tasks — 任务管理

| 方法 | 路径 | 需要认证 | 说明 |
|------|------|:--------:|------|
| GET | `/tasks` | 是 | 分页查询任务列表，支持 status/name/runtime 过滤 |
| POST | `/tasks` | 是 | 创建任务 |
| GET | `/tasks/:id` | 是 | 获取任务详情 |
| PATCH | `/tasks/:id` | 是 | 更新任务配置 |
| DELETE | `/tasks/:id` | 是 | 删除任务（运行中执行将被强制终止） |
| POST | `/tasks/:id/trigger` | 是 | 手动触发任务立即执行（可带自定义参数） |
| POST | `/tasks/:id/pause` | 是 | 暂停任务（停止调度，不影响进行中的执行） |
| POST | `/tasks/:id/resume` | 是 | 恢复任务调度 |
| POST | `/tasks/batch/trigger` | 是 | 批量触发（部分失败不影响其他任务；兼容别名 `POST /tasks-batch/trigger`） |
| POST | `/tasks/batch/pause` | 是 | 批量暂停（兼容别名 `POST /tasks-batch/pause`） |
| POST | `/tasks/batch/resume` | 是 | 批量恢复（兼容别名 `POST /tasks-batch/resume`） |
| POST | `/tasks/batch/delete` | 是 | 批量删除（兼容别名 `POST /tasks-batch/delete`） |
| PUT | `/tasks/:id/glue` | 是 | 在线更新 GLUE 脚本（`{ source, language? }`） |
| GET | `/tasks/:id/stats` | 是 | 单任务执行统计（成功率、平均耗时、最近 20 次） |
| POST | `/tasks/:id/suggest-schedule` | 是 | AI 调度建议（响应含 `fallback` 标记，见下） |
| GET | `/tasks/:id/executions` | 是 | 分页查询该任务的执行记录 |
| GET | `/tasks/:id/executions/:execId` | 是 | 执行详情 |
| GET | `/tasks/:id/executions/:execId/logs` | 是 | 按行分页获取执行日志（`fromLine` 默认 0，`limit` 默认 500、最大 2000） |
| GET | `/tasks/:id/executions/:execId/logs/stream` | 是 | SSE 实时日志流（并发上限，见下） |
| POST | `/tasks/:id/executions/:execId/kill` | 是 | 强制取消 running/pending 执行 |
| POST | `/tasks/:id/executions/:execId/analyze` | 是 | 按需触发 AI 执行分析，结果落库并返回 |
| GET | `/tasks/executions/all` | 是 | 全局执行记录分页（status/taskId/taskName/executorAddress/时间范围） |
| GET | `/tasks/executions/:execId` | 是 | 按执行 ID 查详情（兼容别名，acf-cli / mcp-server 使用） |
| GET | `/tasks/executions/:execId/logs` | 是 | 按执行 ID 取日志（兼容别名） |
| GET | `/tasks/scheduler/stats` | 是 | 调度器状态 |
| GET | `/tasks/:id/versions` | 是 | 任务版本列表 |
| GET | `/tasks/:id/versions/:v1/compare/:v2` | 是 | 两个版本的 diff |
| POST | `/tasks/:id/versions/:versionId/rollback` | 是 | 回滚任务配置到指定历史版本 |
| POST | `/tasks/:id/rollback` | 是 | Git 类型任务回滚到指定 commit |

**创建/更新任务策略字段：**

| 字段 | 类型 | 必填 | 说明 |
|------|------|:----:|------|
| `triggerType` | string | 是 | `cron` / `fixed_rate` / `api` / `manual` |
| `cronExpression` | string | 条件 | `triggerType=cron` 时使用的 5 字段 Cron 表达式 |
| `timezone` | string | 否 | Cron 调度使用的 IANA 时区，例如 `Asia/Shanghai`；留空使用服务端默认时区 |
| `fixedRate` | number | 条件 | `triggerType=fixed_rate` 时的执行间隔，单位秒 |
| `timeoutSeconds` | number | 否 | 任务执行超时，单位秒；推荐使用该字段 |
| `timeout` | number | 否 | 兼容旧字段，语义同 `timeoutSeconds` |
| `maxRetry` | number | 否 | 最大尝试次数（BullMQ attempts），0–10；服务端会保证至少为 `1` |
| `retryDelay` | number | 否 | 重试退避起始延迟，单位秒；`0` 表示不配置队列 backoff |
| `retryableErrors` | string[] | 否 | 预留的可重试错误分类列表 |
| `executorId` | string (UUID) | 否 | 任务级 executor pinning（第六轮）：设置后调度**仅**派给该执行器，绕过 group/tags/runtime 过滤，但仍受其并发槽位上限约束；该执行器离线/不存在时执行直接置 FAILED（failureReason 分别为 `executor_offline` / `unknown`）。与 `executeMode=broadcast` 互斥，同时提供返回 400。`PATCH /tasks/:id` 按**合并后的任务态**校验该互斥（第七轮 N17）：为 broadcast 任务补 `executorId`、或将已 pin 任务改为 `broadcast` 同样返回 400；显式传 `executorId: null` 可清除 pinning |

> 兼容说明：API 入参优先读取 `timeoutSeconds` 并落库到现有 `timeout` 字段；响应中可能同时包含历史字段 `timeout`。Python SDK 同时支持 snake_case（如 `timeout_seconds`、`retry_delay`、`max_retry`），Node/API wire format 推荐 camelCase。

**AI 调度建议响应（POST /tasks/:id/suggest-schedule）：**

```json
{
  "taskId": "uuid",
  "currentCron": "0 8 * * 1-5",
  "suggestedCron": "30 7 * * 1-5",
  "reasoning": "基于最近 50 次执行的成功率与耗时分布……",
  "fallback": false
}
```

- `fallback: true` 表示 AI 不可用或响应解析失败，`suggestedCron` 回退为当前 cron 值（服务端记录 warn 日志）；调用方可据此区分「AI 建议」与「回退值」。

**SSE 日志流（GET /tasks/:id/executions/:execId/logs/stream）：**

- 响应为 `text/event-stream`，日志行以 `data:` 事件下发，结束时发送 `event: done` + `[DONE]`
- 两级并发上限：**单 execution 最多 4 个并发连接，全局最多 64 个**；超限在写出任何 SSE 响应头之前直接返回 **503**（不会产生半开的流）
- 客户端断开（连接 close）即释放槽位
- EventSource 无法携带请求头：**仅本日志流路径**支持 query 参数 `?access_token=<JWT>` 认证（第四轮起；type=access 强制，refresh token 不可用；其它路径的 query token 一律拒绝）

---

## Executors — 执行器管理

| 方法 | 路径 | 需要认证 | 说明 |
|------|------|:--------:|------|
| POST | `/executors/register` | 否* | 执行器注册（返回/绑定执行器专属 Token） |
| POST | `/executors/heartbeat` | 否* | 执行器心跳上报（携带 `restartedAt`/`startupId` 用于重启收敛） |
| POST | `/executors/token` | 否* | 执行器以注册凭证换取专属 Token |
| POST | `/executors/offline` | 否* | 执行器主动下线 |
| GET | `/executors` | 是 | 查询执行器列表（含在线状态） |
| GET | `/executors/groups` | 是 | 执行器分组列表 |
| GET | `/executors/tags` | 是 | 执行器标签列表 |
| GET | `/executors/install-cmd` | 是 | 生成执行器一键安装命令（返回 `{ cmd, token, adminApiUrl }`；第六轮起 `cmd` 为 `curl -fsSL <API_BASE_URL>/api/executors/install.sh | bash -s -- --api-url ... --secret ...` 形式，脚本由后端承载；第七轮起服务端 `ADMIN_API_URL` 未配置时返回 **503**，不再生成裸机不可用的相对路径命令） |
| GET | `/executors/install.sh` | 否 | 一键安装脚本本体（`text/plain; charset=utf-8`，`@Public`：脚本不含密钥，secret 由用户 `bash -s --` 参数传入；与仓库根 `scripts/install.sh` 互为同步拷贝。第八轮 N24 根治：脚本恢复远程下载分支，从下方 artifact 端点拉取 `executor-node.tar.gz` 解压安装，下载失败回退项目 checkout 本地复制；支持 `--install-dir` 覆盖安装目录） |
| GET | `/executors/artifact/executor-node.tar.gz` | 否* | 执行器安装 artifact（`application/gzip`；`@Public` + 执行器共享 token 鉴权：`Authorization: Bearer <token>` 或 `?token=<token>`，未配置 token 时 fail-closed 401）。产物由仓库根 `scripts/bundle-executor-artifact.sh` 生成（dist + package.json + 生产 node_modules），放置于 `EXECUTOR_ARTIFACT_DIR`（默认 admin-api 进程 `<cwd>/artifacts`）；未生成时返回 404。**query 传 token 形态仅用于无法自定义 Header 的场景（如浏览器直下 `<a href>`），共享 secret 会进入反向代理与访问日志，优先使用 `Authorization: Bearer`** |
| GET | `/executors/:id` | 是 | 获取执行器详情 |
| PATCH | `/executors/:id` | 是 | 更新执行器配置 |
| POST | `/executors/:id/reload-config` | 是 | 手动下发配置重载（manifest 同步） |
| POST | `/executors/:id/rotate-token` | 是 | 轮换执行器专属 Token |
| POST | `/executors/:id/set-offline` | 是 | 管理端强制将执行器置为离线 |
| DELETE | `/executors/:id` | 是 | 删除执行器（返回 204） |
| GET | `/executors/:id/executions` | 是 | 查询该执行器上的执行记录 |
| GET | `/executors/:id/metrics` | 是 | 执行器运行指标 |

> *执行器接口使用执行器专属 Token / 安装凭证认证，非用户 JWT。

---

## Executions — 执行记录

| 方法 | 路径 | 需要认证 | 说明 |
|------|------|:--------:|------|
| GET | `/tasks/executions/all` | 是 | 全局分页查询执行记录（见 Tasks 章节） |
| GET | `/tasks/executions/:execId` | 是 | 按执行 ID 查询执行详情 |
| GET | `/tasks/executions/:execId/logs` | 是 | 按执行 ID 分页获取日志 |
| POST | `/executions/callback` | 否* | 执行器批量上报执行最终状态（成功/失败） |

> *回调接口使用执行器 Token 认证，请携带 `Authorization: Bearer <executor_token>`（该路由豁免全局限流）。请求体为数组（**最多 100 条**，超出返回 400），每条必须携带 `executorAddress`；服务端按地址逐个校验执行器 Token——**多执行器批次不允许使用共享 token 兜底**。
>
> **N23：per-execution 回调 token（任务代码安全回调）**。除执行器 Token 外，本端点还接受执行器为单次执行签发的一次性 HMAC token：`Authorization: Bearer v1.<executionId>.<expiresAtUnixSec>.<hmacHex>`，由 executor-node 以 `AUTOFLOW_CALLBACK_TOKEN` 注入任务子进程（签名密钥 = `EXECUTION_CALLBACK_SECRET`，缺省回落执行器共享 token；`key = HMAC-SHA256(secret, "autocodeflow:execution-callback:v1")`，`hmacHex = HMAC-SHA256(key, "v1.<executionId>.<expiresAtUnixSec>")`）。校验规则（全部 fail-closed）：签名与 TTL 有效、**批次内每条 item 的 `executionId` 必须与 token 绑定的一致**、每条仍须携带 `executorAddress`（服务层再与执行记录的执行器地址比对）。token 过期即失效，不能伪造为共享 token，也不授权其他执行。共享 token / per-address token 路径完全保留（向后兼容旧执行器）。
>
> 取消/终止执行请使用 `POST /tasks/:id/executions/:execId/kill`（见 Tasks 章节）。

---

## Notifications — 通知渠道配置

| 方法 | 路径 | 需要认证 | 说明 |
|------|------|:--------:|------|
| GET | `/notification/channels` | 是 | 查询所有通知渠道配置（内置渠道：email / slack / dingtalk / wecom / webhook）。读面对 password/secret/token 类字段脱敏为 `***`（N11）；URL 值内 query 参数名命中同类规则的（如 `?access_token=...`）其值也脱敏（N32，第九轮） |
| PATCH | `/notification/channels/:key` | 是 | 更新指定渠道配置（body: `enabled?`、`config?`）。合法 key：email / slack / dingtalk / wecom / webhook（N32 起 webhook 可配置，config 形状 `{ url: string }`；未知 key 返回 400）。发送时 webhook 渠道 config-first：优先已保存的 `url`，回退逐请求 `webhookUrl` 参数；掩码回显（`***` / `?…=***`）不会覆盖存储中的真实值 |
| POST | `/notification/channels/:key/test` | 是 | 向指定渠道发送测试消息 |
| POST | `/notification/test` | 是 | 向多个渠道发送测试通知（body: `{ channels: string[], title, content }`） |

---

## Metrics — 监控指标

| 方法 | 路径 | 需要认证 | 说明 |
|------|------|:--------:|------|
| GET | `/metrics` | 是 | **Prometheus 抓取端点**（第七轮新增，prom-client）：text exposition format（Content-Type 由 registry 提供）。series：`autoflow_scheduler_ticks_total`、`autoflow_scheduler_tick_duration_ms_total`、`autoflow_scheduler_last_tick_duration_ms`、`autoflow_scheduler_triggers_total{result=claimed\|failed}`、`autoflow_scheduler_triggers_skipped_total{reason=lock_held\|db_claim\|inactive\|block_strategy}`、`autoflow_scheduler_dependency_triggers_total{result=claimed\|skipped}`、`autoflow_queue_depth{state=waiting\|active\|delayed\|failed\|completed}`、`autoflow_queue_up`（Redis 不可读时置 0、队列深度全部置 0）、`autoflow_execution_callback_auth_total{result=ok\|v1_expired\|v1_binding_mismatch\|v1_bad_signature\|legacy_shared_invalid\|missing_token\|bad_address}`（第九轮 N32 新增：`POST /executions/callback` 认证结果分类计数，per-execution `v1.` token 落地后的 401 排障观测；七个 result series 恒在、未计数时为 0），以及进程默认指标（CPU/内存/GC，`METRICS_PROMETHEUS_DEFAULT_METRICS_ENABLED=false` 可关）。env 开关 `METRICS_PROMETHEUS_ENABLED`（默认 `true`；`false` 时本端点返回 404，用于多实例下避免重复抓取或安全收紧场景）。计数为进程内快照映射，多实例部署按 target 各自抓取 |
| GET | `/metrics/summary` | 是 | 系统概览统计 |
| GET | `/metrics/trend?days=` | 是 | 每日执行趋势（`days` 默认 7，上限 90） |
| GET | `/metrics/executors` | 是 | 执行器负载和状态统计 |
| GET | `/metrics/failures` | 是 | 最近失败执行列表 |
| GET | `/metrics/scheduler` | 是 | 调度器可观测性（第五轮新增）：tick 计数/耗时、trigger claimed/skipped/failed、依赖扇出 claim、BullMQ 队列深度、isLeader 与 pid/hostname（多实例区分）；进程内计数，重启归零 |

> 注意：`/metrics` 与 `/metrics/*` 均需要 JWT（Prometheus 抓取方需配置 bearer token）。免认证的系统指标请使用 `GET /health/metrics`（见 Health 章节）。

---

## Audit — 审计日志

| 方法 | 路径 | 需要认证 | 说明 |
|------|------|:--------:|------|
| GET | `/audit` | 是（Admin） | 分页查询审计日志（支持 action/resource/userId/username/startTime/endTime 筛选） |
| GET | `/audit/export` | 是（Admin） | 导出审计日志为 CSV（最多 10000 行，支持相同过滤条件） |

**审计日志查询参数：**

| 参数 | 类型 | 说明 |
|------|------|------|
| `page` / `pageSize` | number | 分页参数 |
| `userId` | number | 按操作用户过滤 |
| `action` | string | 操作类型（task.create / task.update / task.delete / 登录等） |
| `resource` | string | 资源类型（task / executor / application 等） |

---

## Users — 用户管理

| 方法 | 路径 | 需要认证 | 说明 |
|------|------|:--------:|------|
| GET | `/users` | 是（Admin） | 分页查询用户列表 |
| POST | `/users` | 是（Admin） | 创建新用户 |
| GET | `/users/:id` | 是 | 获取用户详情（非 Admin 仅可查看本人） |
| PATCH | `/users/:id` | 是 | 更新用户信息（Admin 可改任意用户；非 Admin 仅本人且不可改角色；修改密码需验证当前密码） |
| DELETE | `/users/:id` | 是（Admin） | 删除用户 |

---

## Config — 系统配置

| 方法 | 路径 | 需要认证 | 说明 |
|------|------|:--------:|------|
| GET | `/config` | 是 | 查询所有系统配置项 |
| GET | `/config/history` | 是 | 查询配置修改历史 |
| GET | `/config/history/:key` | 是 | 查询指定 key 的修改历史 |
| POST | `/config/history/:id/rollback` | 是（Admin） | 回滚到指定历史版本 |
| POST | `/config/executor-shared-token/generate` | 是（Admin） | 生成新的执行器共享 Token |
| GET | `/config/executor-shared-token` | 是（Admin） | 查看当前执行器共享 Token（明文）——第四轮起普通用户 403 |
| GET | `/config/:key` | 是 | 查询单个配置项（secret 类字段打码） |
| PUT | `/config` | 是（Admin） | 创建/更新单个配置项（upsert） |
| POST | `/config/batch` | 是（Admin） | 批量创建/更新配置项 |
| DELETE | `/config/:key` | 是 | 删除指定配置项 |

---

## ExecutorPackages — 执行器包管理

| 方法 | 路径 | 需要认证 | 说明 |
|------|------|:--------:|------|
| GET | `/executor-packages` | 是（Admin） | 查询执行器包列表 |
| POST | `/executor-packages` | 是（Admin） | 上传执行器包（multipart/form-data，返回 201） |
| GET | `/executor-packages/latest` | 是（Admin） | 获取最新执行器包（须带 `type` 查询参数，返回单对象或 null） |
| GET | `/executor-packages/:id` | 是（Admin） | 获取包详情 |
| GET | `/executor-packages/:id/download` | 是（Admin） | 下载包文件（仅支持 Authorization 头，浏览器直链会 401） |
| POST | `/executor-packages/:id/push` | 是（Admin） | 将包推送到执行器安装 |
| POST | `/executor-packages/push-result` | 否* | 执行器回推安装结果 |
| DELETE | `/executor-packages/:id` | 是（Admin） | 删除包 |

**上传字段（multipart/form-data）：**

| 字段 | 类型 | 必填 | 说明 |
|------|------|:----:|------|
| `file` | file | 是 | 包文件，上限 500 MB |
| `name` | string | 是 | 包名称（最长 255） |
| `version` | string | 是 | 版本号（最长 64） |
| `type` | string | 是 | 包类型（`python` / `node`） |
| `platform` | string | 否 | 目标平台（如 `linux`，最长 128） |
| `description` | string | 否 | 描述 |

---

## Registry — 私有仓库代理

| 方法 | 路径 | 需要认证 | 说明 |
|------|------|:--------:|------|
| GET | `/registry/npm/packages` | 是 | npm 私有仓库包列表 |
| GET | `/registry/pypi/packages` | 是 | PyPI 私有仓库包列表 |
| POST | `/registry/pypi/upload` | 是 | 上传 PyPI 包（`.whl`/`.tar.gz`/`.zip`，上限 50 MB） |

---

## 静态资源 — /uploads（应用包下载）

| 方法 | 路径 | 需要认证 | 说明 |
|------|------|:--------:|------|
| GET | `/uploads/packages/:filename` | 双凭证二选一 | 下载 `POST /api/applications/upload` 上传的应用包；`/uploads` 不在 `/api` 前缀下 |

凭证要求见顶部「静态资源鉴权（/uploads）」章节。旧版 executor-node 无凭证下载会得到 401。

---

## 环境变量（第三/四轮审查新增/收紧项）

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `CORS_ALLOWED_ORIGINS` | 空 | 逗号分隔的显式 CORS 白名单；兼容旧变量 `CORS_ORIGINS` 作为回退。未配置时仅开发环境放行 `http://localhost:*` / `http://127.0.0.1:*`；**生产必填**（fail-fast 校验，且不得包含 localhost/127.0.0.1）。私有/LAN 网段不再自动放行 |
| `THROTTLE_TTL` | `60000` | 全局限流窗口（毫秒） |
| `THROTTLE_LIMIT` | `60` | 全局限流次数/窗口（由 100 收紧为 60） |
| `REDIS_TLS` | `false` | `true` 时 ioredis/BullMQ 连接启用 TLS 传输加密 |
| `REDIS_TLS_REJECT_UNAUTHORIZED` | `true` | 仅自签证书调试时设为 `false` |
| `DB_SYNCHRONIZE` | `false` | 显式 schema 同步开关（不再依赖 NODE_ENV 推断）；**生产环境设为 `true` 直接启动失败**，schema 变更一律走 migrations |
| `LOG_RETENTION_DAYS` | `30` | `execution_log_lines` 日志行保留天数，每日 03:30 分批（≤5000 行/批）清理过期日志 |
| `API_BASE_URL` | 无 | 对外可达的 API 基地址；**上传应用包时必需**——`POST /applications/upload` 用它生成 executor 可下载的 `packageUrl`，缺失时返回 500 |
| `SSE_MAX_STREAMS_PER_EXECUTION` | `4` | 单 execution SSE 并发上限（进程内计数，多实例部署实际上限=实例数×该值） |
| `SSE_MAX_STREAMS_GLOBAL` | `64` | 全局 SSE 并发上限（同上，进程内） |
| `TRUST_PROXY` | `false` | **第四轮起默认关闭**。Express `trust proxy` 仅在 `true` 时启用——nginx/负载均衡后的部署**必须设为 `true`**，否则限流键与审计 IP 全部记为代理地址 |
| `EXECUTOR_ALLOW_PRIVATE_NETWORK` | `false` | executor 出站 SSRF 校验（dispatch/broadcast/reload-config/package push）：默认放行私网段（10/8、172.16/12、192.168/16、IPv6 ULA）但**拒绝 loopback**；admin-api 与 executor 同机（127.0.0.1）部署时必须设为 `true`。云元数据段（169.254.169.254 等）任何取值下都拒绝 |

> 其余环境变量（`JWT_*`、`DB_*`、`EXECUTOR_SECRET`、`AI_*`、`LOG_STORAGE_*` 等）见 `apps/admin-api/src/app.module.ts` 的 Joi 校验 schema 与 `src/config/configuration.ts`。

---

## 统一响应格式

所有接口遵循以下响应结构（`code` 即 HTTP 状态码）：

```json
{
  "code": 200,
  "message": "success",
  "data": {}
}
```

| 字段 | 说明 |
|------|------|
| `code` | HTTP 状态码，200 表示成功 |
| `message` | 状态描述 |
| `data` | 响应数据 |

**分页响应格式：**

```json
{
  "code": 200,
  "data": {
    "items": [],
    "total": 100,
    "page": 1,
    "pageSize": 20,
    "totalPages": 5
  }
}
```

**错误响应格式：**

```json
{
  "code": 400,
  "message": "Validation failed",
  "data": ["name should not be empty"],
  "timestamp": "2026-09-02T12:00:00.000Z",
  "path": "/api/tasks"
}
```

**全链路追踪：** 每个响应携带 `X-Trace-Id` 响应头（请求可传入 `X-Trace-Id` 复用），排查问题时提供给运维。

## 常见错误码

| HTTP 状态 | 说明 |
|-----------|------|
| `400` | 参数校验失败（含 DTO 白名单外字段、非法 .zip 等） |
| `401` | 未登录 / Token 无效或过期 / webhook 签名校验失败（统一消息防枚举）/ `/uploads` 缺少有效凭证 |
| `403` | 无权限执行该操作（如非 Admin 调用管理接口） |
| `404` | 资源不存在 |
| `409` | 资源冲突（名称重复、唯一约束） |
| `429` | 请求频率超限（全局限流 60 次/分钟；登录/刷新有独立更严格限流） |
| `500` | 服务器内部错误（含上传时 `API_BASE_URL` 未配置的 fail-fast） |
| `503` | SSE 日志流并发超限（单 execution 4 / 全局 64） |
