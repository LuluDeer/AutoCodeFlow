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
| POST | `/auth/login` | 否 | 用户名密码登录，返回 `accessToken` 与 `refreshToken`（camelCase；独立限流，默认 20 次/分钟）。**TOTP 已启用用户**返回 `200 + {"totpRequired": true}`（不发 token，见下） |
| POST | `/auth/totp/verify` | 否 | SEC-03 TOTP 登录第二步：username+password+code 复验后签发 `accessToken`/`refreshToken`（限流 10 次/分钟；错码计入登录失败锁定计数） |
| POST | `/auth/refresh` | 否 | 使用 refresh_token 刷新 access_token（限流 10 次/分钟） |
| POST | `/auth/logout` | 是 | 登出，吊销当前用户全部 refresh_token |
| GET | `/auth/profile` | 是 | 获取当前登录用户信息 |
| POST | `/auth/totp/setup` | 是 | SEC-03 暂存新 TOTP 密钥（Base32）+ `otpauth://` URL（限流 10 次/分钟；已启用时 400） |
| POST | `/auth/totp/enable` | 是 | SEC-03 校验一次动态码后激活 TOTP（`{code}`；无暂存密钥或错码 400） |
| POST | `/auth/totp/disable` | 是 | SEC-03 关闭 TOTP，需 `{password}` 或 `{code}` 之一确认（否则 401；未启用时幂等返回 `{disabled:false}`） |
| GET | `/auth/sessions` | 是 | SEC-03 列出我的活跃会话（refresh token 行），`current:true` 标记当前会话 |
| DELETE | `/auth/sessions/:id` | 是 | SEC-03 吊销我的单个会话（非本人或不存在的 id 返回 401） |
| POST | `/auth/sessions/revoke-others` | 是 | SEC-03 吊销除当前会话外的全部会话；access token 无 `sid` 声明时退化为吊销全部（fail-safe） |

**TOTP 两步验证（SEC-03）语义约定：**

- **登录契约写死为 200 + 字段**：`POST /auth/login` 对已启用 TOTP 的用户返回
  `{"code":200,"data":{"totpRequired":true}}`——不返回 401，避免前端把「需要第二步验证」
  与「密码错误」混淆。前端收到 `totpRequired:true` 后收集 6 位动态码调用
  `POST /auth/totp/verify` 完成登录。
- **未启用用户登录路径零变化**：`totpEnabled=false` 时 login 直接签发双 token，行为与
  SEC-03 之前完全一致。
- **绑定流程**：`setup`（暂存密钥，此时 `totpEnabled` 仍为 false）→ 用户在验证器
  （Google/Microsoft Authenticator 等任意 TOTP 应用，SHA-1/6 位/30s，RFC 6238）中添加
  → `enable`（验证一次码后激活）。重复 `setup` 会以新密钥覆盖暂存。
- **TOTP 参数**：HMAC-SHA1、6 位数字、步长 30s、允许 ±1 步（±30s）时钟漂移。
  `otpauth://totp/AutoCodeFlow:<username>?secret=<base32>&issuer=AutoCodeFlow&algorithm=SHA1&digits=6&period=30`
- **关闭确认**：`disable` 需账号密码或有效动态码之一——被窃的 access token 单独不足以
  关闭 2FA。`users.totpSecret` 列永不出现在任何 API 响应中（entity `@Exclude`）。
- **access token 新增 `sid` 声明**：等于本次签发的 refresh token 的 `jti`，用于
  `GET /auth/sessions` 标记当前会话与 `revoke-others` 排除自身。旧 token 无 `sid`
  时会话列表正常（无 current 标记），revoke-others 退化为吊销全部。
- **会话 = refresh_tokens 表一行**：吊销即 `revoked=true`（DR-04 撤销语义，立即生效，
  被吊销设备下次 refresh 即 401）。签发时记录 `userAgent`（截断 256 字符）与 `ip`
  供会话列表展示。迁移 `1789800000001`（幂等）新增
  `users.totpSecret`/`users.totpEnabled`/`refresh_tokens.userAgent`/`refresh_tokens.ip`。

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

**TOTP 启用用户的登录响应（200，非 401）：**

```json
{
  "code": 200,
  "message": "success",
  "data": { "totpRequired": true }
}
```

**会话列表响应示例：**

```json
{
  "code": 200,
  "message": "success",
  "data": [
    {
      "id": 42,
      "createdAt": "2026-09-07T08:00:00.000Z",
      "expiresAt": "2026-10-07T08:00:00.000Z",
      "userAgent": "Mozilla/5.0 (Windows NT 10.0) Chrome/126.0",
      "ip": "192.168.1.8",
      "current": true
    }
  ]
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
| GET | `/applications/:id/versions` | 是 | 版本历史快照（无快照的历史数据回退展示部署记录）——DEP-01 后作为过渡期 alias 保留，统一追溯请用 `/applications/:id/releases` |
| GET | `/applications/:id/releases` | 是 | **统一发布追溯视图（DEP-01 新增）**：按版本聚合包地址与最近一次部署的状态/时间/触发方式，见下节 |
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
| GET | `/app-deployments` | 是 | 分页查询部署列表，支持 `applicationId` 过滤（`page` 默认 1，`pageSize` 默认 20、最大 100）——DEP-01 后作为过渡期 alias 保留，「按版本聚合部署信息」的统一视图用 `/applications/:id/releases` |
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
>
> **并发部署冲突（409）**：同一应用已存在 `pending` / `deploying` / `upgrading` 状态的部署行时，再次 `POST /app-deployments/applications/:appId/deploy` 返回 **409**（`already has an in-progress deployment... Wait for it to finish or cancel it first`）。应用层 findOne 预检与数据库部分唯一索引 `uq_app_deployments_application_in_flight`（并发插入竞态兜底，23505 → 409）双层拦截，两条路径返回同一冲突语义。等待在途部署完成（或升级结束）后重试即可。

---

## Releases — 统一发布追溯（DEP-01 新增）

`GET /api/applications/:id/releases?page=1&pageSize=50`（任意认证用户，默认 JWT）

**目标**：合并 `application_versions`（版本号/包地址/快照）与 `app_deployments`（部署时间/状态/执行器）两个语义面，**一行 = 一次版本发布**，「这次部署用了哪个包」一屏完成。纯只读聚合视图，**零 schema 变更**（不占迁移时间戳）。

**响应** `{ data: AppReleaseRow[], total, page, pageSize }`——`total` 为版本快照表行数（synthetic 部署聚合行不并入，属过渡期语义），`pageSize` 默认 50、**上限 200**（超出部分截断，防全表）。排序键 = 该版本最近一次部署完成时刻（无部署则为版本行创建时刻），降序。

| 字段 | 来源 | 说明 |
|------|------|------|
| `version` / `id` / `gitCommit` / `status` / `createdAt` / `sourceDeploymentId` | `application_versions` | `id` 为快照行 id；合成部署行时 `id=null` |
| `packageUrl` | 快照行 `snapshot.packageUrl` | 部署当时的包地址（历史语义，不回退应用当前值——当前值在 `GET /applications/:id`）；无快照行为 null |
| `deployedAt` / `latestDeploymentId` / `deploymentStatus` / `executorAddress` / `runMode` | 该版本 `deployedVersion` 匹配的**最近一次** `app_deployments` 行（`deployedAt ?? createdAt` 最大） | 同版本多实例/多次部署各计入 `deploymentCount`；无部署的版本行这些字段为 null（行仍出现） |
| `triggerType` | 推导：升级指纹（statusMessage `Upgrade triggered`/`Pulling latest commit…`）→ `upgrade`；`deployedAt` 已置位 → `manual`；否则 `unknown`；无部署 → null | **已知限制**：两表无持久化 trigger 列；既有部署行被复用做升级且推送成功后文案被覆盖时可能误判 `manual`。落库 trigger 列属后续轮 schema 工作 |
| `operator` / `operatorSource` / `operatorMissingReason` | `application_versions.createdBy` | **来源缺失如实标注**：当前所有写入路径均未填充 `createdBy`（恒 null），且 `audit_logs` 不覆盖部署写面；AUTH-05 审计扩展接线后自动可得 |
| `synthetic` | — | 有部署记录但从未保存版本快照的历史数据（心跳竞态等）合成行，`deployedVersion=null` 的部署归一为一条 `version=null` 行；对齐 `/versions` 的 legacy fallback 语义，仅第 1 页参与 |

> **旧端点过渡期保留（不删除、不重定向）**：`GET /applications/:id/versions`（版本快照/回滚消费面，携带 snapshot 与 deployCount）与 `GET /app-deployments`（逐部署行列表）与本端点数据同源；新前端一律消费 `/releases`，旧端点收口另立任务。admin-web `ApplicationDetailPage` 接入为后续轮工作（本任务只落 API 契约）。

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
| GET | `/tasks/:id/executions/:execId/report` | 是 | 执行报告+时间线一次拉取（OBS-04，见下） |
| GET | `/tasks/:id/executions/:execId/logs` | 是 | 按行分页获取执行日志（`fromLine` 默认 0，`limit` 默认 500、最大 2000；可选 `level` 过滤，见下） |
| GET | `/tasks/:id/executions/:execId/logs/stream` | 是 | SSE 实时日志流（并发上限，见下） |
| POST | `/tasks/:id/executions/:execId/kill` | 是 | 强制取消 running/pending 执行 |
| POST | `/tasks/:id/executions/:execId/analyze` | 是 | 按需触发 AI 执行分析，结果落库并返回 |
| GET | `/tasks/executions/all` | 是 | 全局执行记录分页（status/taskId/taskName/executorAddress/时间范围） |
| GET | `/tasks/executions/:execId` | 是 | 按执行 ID 查详情（兼容别名，acf-cli / mcp-server 使用） |
| GET | `/tasks/executions/:execId/logs` | 是 | 按执行 ID 取日志（兼容别名；参数同上，含 `level`） |
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
| `maintenanceWindows` | MaintenanceWindow[] | 否 | 任务级维护窗口（FEAT-06）：数组形态 `[{ start, end, description? }]`，`start`/`end` 均为 5 字段 Cron——`start` 最近触达时刻开窗、`end` 最近触达时刻关窗（半开区间 `[start, end)`）。命中窗口的**计划触发**（cron/fixed_rate/错失补偿等调度入队路径）被跳过并计入 `/metrics/scheduler` 的 `triggersSkippedMaintenance`，不建执行记录；手动/API 触发不受窗口约束。上限 10 条；窗口 Cron 按服务端本地时间评估。`PATCH /tasks/:id` 缺省 = 保留旧值，显式 `null` / `[]` = 清空 |
| `timeoutSeconds` | number | 否 | 任务执行超时，单位秒；推荐使用该字段 |
| `timeout` | number | 否 | 兼容旧字段，语义同 `timeoutSeconds` |
| `timeoutAction` | string | 否 | 超时后动作（CORE-04）：`kill`（缺省）/ `kill_retry` / `notify_only`。`kill` = 既有树杀语义，执行器到时强杀进程树并回调 `timeout` 终态；`kill_retry` = 同样树杀，但 admin 在超时终态落定后按任务既有重试预算（`maxRetry`/`retryDelay`，与 executor-restart / stale sweep 共用同一 re-enqueue 模式，触发类型 `timeout_retry`）追加一次新执行——预算耗尽退化为普通 `kill`，终态保持 `TIMEOUT`；`notify_only` = admin 不额外下发终止指令、只保证超时告警（告警由既有失败通知路径发出一次）。**边界**：`notify_only` ≠ 不超时——执行器自身的硬超时仍然生效，进程树仍会被执行器杀掉并回调，本策略只改变 admin 侧行为。`PATCH /tasks/:id` 缺省 = 保留旧值，显式 `null` = 回缺省 `kill` |
| `timeoutWarnRatio` | number | 否 | 超时预警阈值（CORE-04）：占 `timeout` 的百分数，整数 0–90。执行运行时长达到 `timeout × ratio / 100` 时发送一次 WARNING 级预警通知（复用 `notifyTimeout` 通道，受任务级静默窗口约束），每个执行**至多一次**；例如 `timeout=600`、`ratio=80` → 运行到 480 秒时预警。缺省/`null` = 未启用（存量任务零新通知）；运行态归一化时非 0–90 整数一律视为未启用 |
| `estimatedDurationSec` | number | 否 | 预估执行时长秒数（CORE-05）：整数 0–604800（7 天上限），`0`/缺省 = 未知。**任务侧属性**，仅参与调度侧执行器负载评分（长任务预估对繁忙执行器惩罚更高，长短混布时倾向把长任务派给更空闲的执行器，权重公式见 executor-score.util.ts）；执行链路（心跳/超时/统计）不消费该字段。`PATCH /tasks/:id` 缺省 = 保留旧值，显式 `null` = 重置为未知；版本快照随存（回滚不静默重置） |
| `maxRetry` | number | 否 | 最大尝试次数（BullMQ attempts），0–10；服务端会保证至少为 `1` |
| `retryDelay` | number | 否 | 重试退避起始延迟，单位秒；`0` 表示不配置队列 backoff。**CORE-02 抖动语义**：实际重试延迟 = `retryDelay × 1000 × 2^(attempt-1)` 的指数基座上加 **±20% 抖动**（admin-api `retry-backoff.util.ts` 纯函数，在四处 enqueue 边界算好整数毫秒传入 BullMQ），摊开同周期失败任务的的重试时刻（thundering herd）；`retryDelay<=0` 仍保持不延迟 |
| `retryableErrors` | string[] | 否 | 可重试错误类型白名单（CORE-02 已 UI 化，admin-web 表单暴露九类中文选项）。**消费语义**（task.processor RETRY-01）：非空白名单 = 仅白名单内的失败会被 BullMQ 重试——匹配规则为错误消息子串或 `failureReason` 分类值（大小写不敏感），未命中转 `UnrecoverableError` 烧尽预算；`null`/`[]` = 全部可重试（既有行为）。`PATCH /tasks/:id` 缺省 = 保留旧值，显式 `null` = 回到全量可重试。**边界**：`timeout` 类失败另有防双派发守卫，无论白名单如何配置都不会自动重试 |

**重试链路与 attempt 可视化（CORE-02）：**

- **attempt 语义**：`task_executions.retryCount`（0 起）标识该执行行是任务的第几次重试载体；详情页"重试预算"展示 `Attempt #N of M`（N = retryCount+1，M = maxRetry）与剩余预算。BullMQ 同执行行内的 job 级自动重试不产生新行。
- **重试链拼装**：重试链 = 同任务下 `retryCount` 递增的兄弟执行行（executor_restart / stale_recovery / timeout_retry 等 re-enqueue 路径创建）。前端复用既有 `GET /tasks/:id/executions`（按 `taskId` 查询）拉取兄弟行后按连续档拼装，中间档缺失在间断处截断；各次尝试展示状态/耗时/与上次尝试的间隔（下行 `startTime` − 上行 `endTime`）。
- **下次重试时间**：链上存在 PENDING 行时展示近似开跑时刻（行 `createdAt` + `retryDelay × 2^(attempt-1)` 指数基座，注明 ±20% 抖动）——BullMQ delayed job 的精确到期时刻不落库，此为近似值。
- **手动提前重试**：无专用端点；使用既有 `POST /tasks/:id/trigger` 手动触发（admin-web 执行详情页「重新触发」按钮）。
- **退避抖动纯函数**：`apps/admin-api/src/modules/task/retry-backoff.util.ts` `jitteredRetryDelayMs(retryDelaySec, attempt, random?, ratio?)`，输出 `[base×0.8, base×1.2]` 内整数毫秒，`retryDelay<=0` 返回 `0`（调用方省略 backoff）。
| `secrets` | object | 否 | 任务级凭据键值对（SEC-02，独立于 `params` 的普通运行参数）。**存储加密**：配置 `SEC_SECRETS_KEY` 后所有叶子值以 AES-256-GCM `enc:v1:<iv>:<tag>:<ciphertext>` 信封落库；未配置时降级明文并启动 warn 一次（零破坏升级路径）。**读取永久脱敏**：`GET /tasks`、`GET /tasks/:id` 响应中叶子值一律回 `******`（密文也不外泄），因此已保存的 secrets 不可经 API 回读。**派发语义**：执行时解密与 params 合并注入执行器 env（`AUTOFLOW_<KEY>`，与 params 同通道），同名键 secrets 覆盖 params；明文仅存在于派发 HTTPS 载荷与执行器内存，不落 `task_executions.params`。**PATCH 语义**：缺省 = 保留旧值，显式 `null` / `{}` = 清空/替换（整体替换，非按键合并）。存量行不做迁移加密——配置 key 后首次 update 自然转为密文 |
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

**执行日志按级别过滤（GET /tasks/:id/executions/:execId/logs 及其兼容别名，OBS-03）：**

- 查询参数 `level`：可选，枚举 `ERROR` / `WARN` / `INFO` / `DEBUG`（严格大写）。日志行写入时从行文本推断级别（行首或时间戳后的 `[ERROR]`/`ERROR:` 等标注，大小写不敏感，`WARNING` 归一化为 `WARN`）并落库；过滤在 SQL 层等值下推
- **未知级别行（`level=null`：存量历史行或文本推断不到的行）在 `level` 过滤时一律不返回**；不传 `level` 时行为与引入前完全一致（含 null 行）
- 带 `level` 过滤时，`fromLine` 的语义从"物理行号游标"变为"**过滤后序列的偏移量**"（被过滤掉的行不占用分页窗口），响应中的 `totalLines` 与 `hasMore` 均按**过滤后行集**计算；不传 `level` 时保持既有"物理行号游标 + 全量 `totalLines`"语义
- 分页参数不变：`fromLine` 默认 0，`limit` 默认 500、最大 2000

**执行报告 + 时间线（GET /tasks/:id/executions/:execId/report，OBS-04）：**

执行详情「分析报告/时间线」面板的一次性载荷，单请求合并三类数据：

```json
{
  "execution": { "id": "uuid", "status": "failed", "createdAt": "...", "startTime": "...", "endTime": "...", "duration": 295000, "aiAnalysis": "...", "...": "task_executions 行原样" },
  "timeline": [
    { "phase": "created",  "at": "2026-09-07T01:00:00.000Z", "detail": "trigger=cron" },
    { "phase": "started",  "at": "2026-09-07T01:00:05.000Z", "detail": "executor=http://..." },
    { "phase": "finished", "at": "2026-09-07T01:05:00.000Z", "detail": "status=failed" }
  ],
  "report": { "id": 7, "triggerDay": "2026-09-07", "successCount": 10, "failCount": 3, "avgDurationMs": 42000, "...": "..." }
}
```

- `timeline` 三段（created→started→finished）由 `task_executions` 行的 DB 时间戳列（`createdAt`/`startTime`/`endTime`）直接映射，与 admin-api `execution-timeline.util.ts`、mcp-server `buildExecutionTimeline`（ECO-03）三端同语义；未到达的阶段 `at=null`（前端渲染「—」），不抛错、不二次推算
- `report` 为 `execution_reports` 表中该执行所在**日**的聚合行（按 `triggerDay` DATE 等值匹配执行 `createdAt` 的本地零点）；该表由 MetricsService 按日聚合懒写入，与单次执行无外键关系——**无行时 `report: null` 属正常态**，前端降级渲染提示而非报错
- 未知执行（或执行不属于该任务）返回 404，与 `GET /tasks/:id/executions/:execId` 一致

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
| POST | `/executors/heartbeat` | 否* | 执行器心跳上报（携带 `restartedAt`/`startupId` 用于重启收敛）。可选指标字段：`cpuUsage` / `memUsage` / `diskUsage` / `networkLatency` / `runningTaskCount` / `totalTaskCount` / `failedTaskCount` / `runningExecutionIds`（≤200，`null`=旧版未上报）/ `deadLetterCount`（回调死信积压数，**0..100000** 非负整数，`null`=旧版执行器未上报该字段（区别于 `0`：已上报且无积压），`>0` 表示回调持续失败、载荷已落盘执行器本地 dead-letter）/ `maxConcurrentTasks`（1..10000 容量热更新）。服务端对白名单外字段静默丢弃（防 mass-assignment），非法取值不落库 |
| POST | `/executors/token` | 否* | 执行器以注册凭证换取专属 Token。**副作用（register-on-token）**：若该 `address` 尚无执行器行（典型场景：compose 启动竞态下 register 失败——register 不会自动重试，heartbeat 对未知地址返回 404 也不建行），本端点会补建仅含 `address`/`appName` 的瘦行：`type`/`capabilities`/`maxConcurrentTasks`/`executorVersion` 等富元数据缺失（runtime 过滤对空 capabilities 全放行，故竞态窗口内该执行器可能被选中执行任意 runtime 任务），直到执行器进程重启重新 register 才补齐 |
| POST | `/executors/offline` | 否* | 执行器主动下线 |
| GET | `/executors` | 是 | 查询执行器列表（含在线状态） |
| GET | `/executors/groups` | 是 | 执行器分组列表 |
| GET | `/executors/tags` | 是 | 执行器标签列表 |
| GET | `/executors/install-cmd` | 是 | 生成执行器一键安装命令（返回 `{ cmd, token, adminApiUrl }`；第六轮起 `cmd` 为 `curl -fsSL <API_BASE_URL>/api/executors/install.sh | bash -s -- --api-url ... --secret ...` 形式，脚本由后端承载；第七轮起服务端 `ADMIN_API_URL` 未配置时返回 **503**，不再生成裸机不可用的相对路径命令） |
| GET | `/executors/install.sh` | 否 | 一键安装脚本本体（`text/plain; charset=utf-8`，`@Public`：脚本不含密钥，secret 由用户 `bash -s --` 参数传入；与仓库根 `scripts/install.sh` 互为同步拷贝。第八轮 N24 根治：脚本恢复远程下载分支，从下方 artifact 端点拉取 `executor-node.tar.gz` 解压安装，下载失败回退项目 checkout 本地复制；支持 `--install-dir` 覆盖安装目录） |
| GET | `/executors/artifact/executor-node.tar.gz` | 否* | 执行器安装 artifact（`application/gzip`；`@Public` + 执行器共享 token 鉴权：`Authorization: Bearer <token>` 或 `?token=<token>`，未配置 token 时 fail-closed 401）。产物由仓库根 `scripts/bundle-executor-artifact.sh` 生成（dist + package.json + 生产 node_modules），放置于 `EXECUTOR_ARTIFACT_DIR`（默认 admin-api 进程 `<cwd>/artifacts`）；未生成时返回 404。**query 传 token 形态仅用于无法自定义 Header 的场景（如浏览器直下 `<a href>`），共享 secret 会进入反向代理与访问日志，优先使用 `Authorization: Bearer`** |
| GET | `/executors/:id` | 是 | 获取执行器详情 |
| PATCH | `/executors/:id` | 是 | 更新执行器配置 |
| POST | `/executors/:id/reload-config` | 是 | 手动下发配置重载（manifest 同步）。使用幂等签发缓存中的当前 Token（不轮换）；**admin-api 重启后（签发缓存冷）对任一执行器的首次推送会失败一次**（`Failed to reach executor`——rotate-on-push 固有语义，执行器在一个心跳间隔内经出站 401 自愈对齐，稍后重试即可成功） |
| POST | `/executors/:id/rotate-token` | 是 | 轮换执行器专属 Token（新 Token 仅在本响应展示一次）。**R10 起 executor-node 在线自动对齐，无需重启/重新注册**：手动轮换后，node 执行器下一次出站请求（心跳/回调，默认 ≤30s）收到 401 时立即以注册凭证重取 `POST /executors/token`，在同一往返内采纳新 Token 与匹配的 tokenHash（N26 回调 HMAC 密钥）并重试原请求一次。**executor-python 自 R11 起同样具备 401 即时自愈**（`request_with_self_heal`：出站心跳收到 401 时立即重取 `POST /executors/token`，在同一往返内采纳新 Token 与匹配的 tokenHash（N26 回调 HMAC 密钥）并重试原心跳恰一次）——两端收敛均 ≤ 一个心跳间隔（默认 30s）。`rotateToken` 同步播种幂等签发缓存，故执行器采纳的正是本响应展示的 Token（不产生二次轮换）。窗口内以旧 tokenHash 签发的 `v1.` 回调 token 仍验签失败（401，`v1_bad_signature`）；两端配置相同 `EXECUTION_CALLBACK_SECRET` 的部署不受轮换影响 |
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
> **N23：per-execution 回调 token（任务代码安全回调）**。除执行器 Token 外，本端点还接受执行器为单次执行签发的一次性 HMAC token：`Authorization: Bearer v1.<executionId>.<expiresAtUnixSec>.<hmacHex>`，由 executor-node 以 `AUTOFLOW_CALLBACK_TOKEN` 注入任务子进程（签名密钥优先级 = `EXECUTION_CALLBACK_SECRET` → 注册/取 token/心跳响应采纳的 per-executor tokenHash（N26/R9；R10 起手动轮换后 ≤ 一次心跳内自动对齐）→ 执行器共享 token；`key = HMAC-SHA256(secret, "autocodeflow:execution-callback:v1")`，`hmacHex = HMAC-SHA256(key, "v1.<executionId>.<expiresAtUnixSec>")`）。校验规则（全部 fail-closed）：签名与 TTL 有效、**批次内每条 item 的 `executionId` 必须与 token 绑定的一致**、每条仍须携带 `executorAddress`（服务层再与执行记录的执行器地址比对）。token 过期即失效，不能伪造为共享 token，也不授权其他执行。共享 token / per-address token 路径完全保留（向后兼容旧执行器）。
>
> 取消/终止执行请使用 `POST /tasks/:id/executions/:execId/kill`（见 Tasks 章节）。
>
> **执行失败原因（failureReason）枚举**（`ExecutionFailureReason`，执行详情/全局执行列表响应字段）：
> `package_fetch_failed`（应用包拉取失败）/ `script_error`（脚本异常，任务回调默认值）/ `timeout`（超时）/ `executor_offline`（pinning 执行器离线）/ `executor_restart`（执行器重启中断）/ `stale_recovered`（失联回收——stale sweep 赢得 RUNNING→FAILED 条件更新、兑现重试预算时标记，区别于执行器回调上报的 `unknown`，便于排查"worker 崩溃型故障 + sweep 兑现重试预算"链路）/ `killed`（被 kill 接口强制取消）/ `unknown`（执行器回调未给出原因）。

---

## Artifacts — 执行产物（FEAT-05，本轮新增）

执行器任务可在其工作目录约定的 `artifacts/` 子目录写入交付物（截图 / 报表 / CSV 等）。任务结束时双执行器（executor-node、executor-python）会：

1. 扫描 `<workDir>/artifacts/`（仅顶层普通文件），构造清单 `[{ name, size, sha256 }]`——**上限 20 个、单文件 ≤ 100 MB**，超限 / 非法名 / 子目录一律跳过并记日志；
2. 逐文件 multipart PUT 上传到下方"上传"端点（复用执行器回调的同一 token 做机器鉴权）；
3. 把**实际上传成功**的清单随终态回调 `POST /executions/callback` 的 `artifacts` 字段上报，服务端落库到 `task_executions.artifacts`（jsonb 可空列，缺省不覆盖为 null）。

> ⚠️ **best-effort 铁律**：产物收集 / 上传的任何失败都只记日志，**绝不阻塞、绝不改变任务终态**。artifacts 永远不是任务成败的一部分。管理台任务文件可通过环境变量 `AUTOFLOW_ARTIFACTS_DIR`（执行器注入）定位写入目录。

| 方法 | 路径 | 需要认证 | 说明 |
|------|------|:--------:|------|
| PUT | `/executions/:execId/artifacts/:name` | 否* | 执行器上传单个产物（multipart `file` 字段，复用包上传通道形态；body 上限 100 MB）。可选 `?sha256=` 与实际字节交叉核对，不符返回 400 |
| GET | `/tasks/executions/:execId/artifacts` | 是 | 读取执行记录的产物清单（来自终态回调落库的 `artifacts`） |
| GET | `/tasks/executions/:execId/artifacts/:name` | 是 | 流式下载单个产物（JWT）；`name` 必须是裸安全文件名，服务端二次校验防路径穿越，文件缺失返回 404 |

> *上传端点豁免全局 JWT（`@Public`），处理器内复用回调的凭据形态校验：执行器共享 token（`verifyExecutorToken`）**或** 每执行器动态 token（`validateTokenByAddress`，按执行行的 `executorAddress` 绑定）任一命中即放行；执行行不存在返回 404，凭据均不匹配返回 401。
>
> **存储与生命周期**：产物字节落在 admin 的 `uploads/artifacts/<execId>/<name>`（与执行器安装包同 `uploads` 卷；根目录可用 `LOG_ARTIFACT_DIR` 环境变量覆盖，缺省回退该 uploads 路径）。每日 03:45 的 TTL 清理服务复用 `LOG_RETENTION_DAYS`（默认 30 天），按子目录最旧文件 mtime 超期即整目录回收——与日志保留策略搭车，无需单独配置。

---

## Task Templates — 任务模板（CORE-03，本轮新增）

常用任务形态（定时备份 / 健康巡检 / 数据同步 / 日志清理 / Webhook 探活）固化为模板。迁移 `1789800000000` 建表并幂等 seed 5 个官方模板（`INSERT ... ON CONFLICT (key) DO NOTHING`），五个 key（`scheduled_backup` / `health_check` / `data_sync` / `log_cleanup` / `webhook_ping`）与 mcp-server `TASK_TEMPLATES`（ECO-03）**同一口径**，避免 admin 与 MCP 两套模板语义漂移。

- `config` 是**合法 CreateTaskDto 子集**（省略 `name`）：落库与实例化前都走 `plainToInstance + validate`（whitelist + forbidNonWhitelisted，与全局 ValidationPipe 同口径）复检，多余键 / 非法值直接 400，防脏模板。
- `POST /task-templates` 创建**自定义模板**；官方模板不可删（403）。
- 「从模板创建任务」语义（模板 config 作默认、请求体显式字段覆盖）由独占端点 `instantiate` 承担（复用 `TaskService.create`；`POST /tasks` 本体不带 `templateId`）。

| 方法 | 路径 | 需要认证 | 说明 |
|------|------|:--------:|------|
| GET | `/task-templates` | 是 | 模板列表（官方在前、自定义在后），返回 `TaskTemplate[]` |
| GET | `/task-templates/:id` | 是 | 单个模板（创建表单预填取 `config`）；不存在 404 |
| POST | `/task-templates` | 是 | 新建自定义模板（body：`name` 必填 ≤128 / `description?` ≤500 / `category?` ≤32 / `key?`（缺省由 name 规整，1-64 位 `[A-Za-z0-9_-]`）/ `config` 必填对象）。config 非法 400、key 重复 409 |
| POST | `/task-templates/:id/instantiate` | 是 | 一键建任务：模板 config 展开为默认值、body 显式字段覆盖（至少提供 `name`；body 内 `templateId` 键被剥离防越权）。合并载荷经 CreateTaskDto 语义校验后走标准任务创建路径，返回创建的任务；缺 name / 非法载荷 400，模板不存在 404 |
| DELETE | `/task-templates/:id` | 是 | 删除自定义模板（官方模板 403，不存在 404），返回 `{ ok: true }` |

**TaskTemplate 响应结构：**

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | uuid | 模板 ID |
| `key` | string | 稳定标识（唯一；官方五模板固定 key） |
| `name` | string | 展示名（中文，如「定时备份」） |
| `description` | string? | 模板说明 |
| `category` | string? | 粗分类（备份/巡检/同步/清理/通知…），前端渲染 Tag |
| `config` | object | 合法 CreateTaskDto 子集（省略 name），实例化时作默认值 |
| `isOfficial` | boolean | 官方预置模板标记（官方不可删） |
| `createdAt` / `updatedAt` | timestamp | 时间戳 |

---

## Notifications — 通知渠道配置

| 方法 | 路径 | 需要认证 | 说明 |
|------|------|:--------:|------|
| GET | `/notification/channels` | 是 | 查询所有通知渠道配置（内置渠道：email / slack / dingtalk / wecom / webhook）。读面对 password/secret/token 类字段脱敏为 `***`（N11）；URL 值内 query 参数名命中同类规则的（如 `?access_token=...`）其值也脱敏（N32，第九轮） |
| PATCH | `/notification/channels/:key` | 是 | 更新指定渠道配置（body: `enabled?`、`config?`）。合法 key：email / slack / dingtalk / wecom / webhook（N32 起 webhook 可配置，config 形状 `{ url: string }`；未知 key 返回 400）。发送时 webhook 渠道 URL 优先级（N37，第十轮修正）：显式 `webhookUrl` 请求参数 > 已保存**且渠道 enabled** 的 `url` > env 回退（webhook 渠道无 env 项）——渠道 disabled 时已保存 url 不生效，不再静默改道显式参数；掩码回显（`***` / `?…=***`）不会覆盖存储中的真实值 |
| POST | `/notification/channels/:key/test` | 是 | 向指定渠道发送测试消息 |
| POST | `/notification/test` | 是 | 向多个渠道发送测试通知（body: `{ channels: string[], title, content }`）；全部请求渠道均 disabled → `success:false`（N29 空 results 报错，不再假 OK） |
| POST | `/notification/send` | 是 | 任务代码主动上报通知（autocodeflow-notify SDK 唯一入口，N22；第七轮落地，本行第十轮 N38 补文档）。body: `{ content（必填）, title?, taskName?, level?(info|warning|error|critical，默认 info), channels?(email|slack|dingtalk|wecom|webhook 子集), webhookUrl?, taskId? }`；`title` 缺省为 `[LEVEL] taskName`；传 `webhookUrl` 而未列 `channels` 时自动追加 webhook 渠道；`channels` 为空则按 `sendAll` 全渠道扇出。webhook 目标解析遵循上行的 N37 优先级链（显式 `webhookUrl` 优先，已保存 url 仅在渠道 enabled 时生效）。响应恒为 2xx + `{ success: true, results: { <channel>: sent|blocked|failed|skipped } }`——单渠道失败或 SSRF 拦截绝不 5xx 任务回调，逐渠道真实结果以 `results` 为准（`blocked`=SSRF 拒绝；`skipped`=无可用 URL/凭证） |

---

### Alerts — 告警入站路由（OBS-02，第十六轮新增）

| 方法 | 路径 | 需要认证 | 说明 |
|------|------|:--------:|------|
| POST | `/alerts/webhook` | 否（HMAC 签名） | Alertmanager v2 webhook 接收入口：把 Prometheus/Alertmanager 告警映射为平台通知并走**既有通知渠道**（email / slack / dingtalk / wecom / webhook）全渠道扇出（`sendAll`），不新建渠道类型 |

> 鉴权约定与 `POST /applications/webhook` 一致（`@Public` + HMAC）：
> - header `X-AutoCodeFlow-Timestamp`（毫秒时间戳，±5 分钟窗）+ `X-Hub-Signature-256: sha256=<hex>`，`<hex> = HMAC_SHA256(secret, "${timestamp}.${rawBody}")`；
> - secret 为环境变量 `ALERT_WEBHOOK_SECRET`；**未配置时端点 503 拒绝（安全缺省）**；所有鉴权失败统一 401（`"Alert webhook authentication failed"`），原因只写服务端日志。

请求体为 Alertmanager v2 JSON（`alerts[]` 带 `status` / `labels` / `annotations` / `startsAt`）。映射语义：

- `title = [Alert] <alertname> <firing|resolved>`（alertname 缺省 `unknown`）；多条告警合并为一条通知。
- `content` = 逐条告警的 labels / annotations 键值摘要 + `startsAt` + Alertmanager `externalURL`（如有）。
- **level**：任一 `firing` → `error`；全部 `resolved` → `info`（resolved 恢复通知也发）。
- **runbook 链接**（FEAT-11）：`annotations.runbook_url` 命中时追加 `Runbook: <url>` 段；`labels.taskId` 命中时查 `tasks.runbook` 拼接 `Runbook:` 段（查询失败降级，不阻断外发）。

响应：`{ ok: true, delivered: <n>, results: { <channel>: sent|blocked|failed|skipped } }`；全部渠道无人可投递（全 `skipped`）时返回 **502** + results 明细（让 Alertmanager 重试）。`alerts` 缺失/为空 → 400。

```json
POST /api/alerts/webhook
{
  "version": "4",
  "status": "firing",
  "alerts": [
    {
      "status": "firing",
      "labels": { "alertname": "PG_DOWN", "severity": "critical", "taskId": "task-abc" },
      "annotations": { "summary": "PostgreSQL 不可达", "runbook_url": "https://wiki.example.com/rb/pg" },
      "startsAt": "2026-09-07T05:00:00Z"
    }
  ]
}
```

Alertmanager 侧 route/receiver 配置样例与加签提示见 `docs/observability/README.md` §3.5。

---

## Event Subscriptions — Webhook 出站事件（FEAT-07，第十六轮新增）

平台事件可订阅后以签名 webhook 推送到外部端点（如 CI 在任务失败时触发流程）。事件沿 ARCH-21 领域事件总线派发，主链零改动。

**可订阅事件目录**（稳定契约，只增不改）：

| 事件名 | 载荷 `data` 主要字段 | 发布时机 |
|--------|---------------------|----------|
| `execution.completed` | `executionId` `taskId` `taskName` `status` `failureReason(null)` `durationMs` `finishedAt` | 执行以 SUCCESS 终态落库后（恰好一次） |
| `execution.failed` | `executionId` `taskId` `taskName` `status`(failed/timeout/killed) `failureReason` `errorMessage?` `durationMs` `finishedAt` | 执行以失败类终态落库后（恰好一次） |
| `executor.offline` | `executorId` `appName` `address` | 执行器翻转 OFFLINE 落库后（心跳超时 sweep / 优雅停机 / 管理台置离线，三路） |
| `deployment.completed` | `deploymentId` `applicationId` `executorAddress` `status` `deployedVersion` `deployedCommit` | 部署心跳确认进入 RUNNING 终态落库后 |

| 方法 | 路径 | 需要认证 | 说明 |
|------|------|:--------:|------|
| GET | `/event-subscriptions` | 是 | 列出订阅：ADMIN 看全部；普通用户看自己的 + 系统级（`userId=null`）。`secret` 恒脱敏为 `******` |
| POST | `/event-subscriptions` | 是 | 新建订阅。body: `{ url（必填，公网 http(s)）, eventTypes（1-10 个，取值=上表事件名）, secret?（≥16 字符；省略则服务端生成 64 字符 hex 并在**本次响应** `generatedSecret` 字段一次性回显） }`。url 经 SSRF 深校验（DNS 解析逐地址拒绝内网/环回/链路本地/云元数据）→ 400 |
| PATCH | `/event-subscriptions/:id` | 是 | 更新（属主/ADMIN）。body: `{ enabled?, url?, eventTypes?, secret? }`（url 变更时再次 SSRF 校验） |
| DELETE | `/event-subscriptions/:id` | 是 | 删除订阅（属主/ADMIN），死信级联删除（FK ON DELETE CASCADE） |
| GET | `/event-subscriptions/:id/dead-letters` | 是 | 死信分页列表（属主/ADMIN）。`page` 默认 1，`limit` 默认 20、最大 100。行含 `eventType` / `payload`（发送时完整载荷）/ `error`（末次失败摘要）/ `attempts` / `createdAt` |
| POST | `/event-subscriptions/:id/dead-letters/:dlId/replay` | 是 | 手动重放：以订阅**当前** url/secret 重新签名派发**一次**（不自动重试）。成功 `{ ok: true }` 且死信删除；失败 `{ ok: false, error }` 且死信保留（可再次重放） |

**派发语义**：

- 事件到达 → 快照 `enabled=true` 的订阅 → 按 `eventTypes` 过滤 → 每订阅独立投递（单订阅失败不影响其他订阅，更不影响事件源）。
- **失败重试**：最多 3 次尝试（首次 + 2 重试），指数退避 1s / 2s / 4s（进程内 setTimeout 队列）；3 次全败 → 整包落 `event_subscription_dead_letters` 死信表 + 订阅行累加 `consecutiveFailures` / `lastFailureAt` / `lastFailureError`（成功派发即清零）。
- **投递请求**：`POST <url>`，`Content-Type: application/json`，超时 10s，**禁跟随 3xx 重定向**（SSRF 纪律——只访问经校验的首跳地址）。载荷信封：`{ "event": "<事件名>", "occurredAt": "<ISO 时刻>", "data": { ...载荷 } }`。
- 订阅 url 出站前二次 SSRF 复核（订阅可能被并发 PATCH）；被拒按确定性失败处理。

**签名校验（订阅方接入指南）** —— 与 `POST /applications/webhook` 发版 webhook 的约定**完全一致**：

- 头 `X-AutoCodeFlow-Event`：事件名（冗余于载荷 `event` 字段，便于路由）。
- 头 `X-AutoCodeFlow-Timestamp`：毫秒时间戳；订阅方应拒绝 `|now - timestamp| > 5 分钟` 的请求（防重放）。
- 头 `X-Hub-Signature-256`：`sha256=<hex>`，`<hex> = HMAC_SHA256(secret, "${timestamp}.${rawBody}")`——注意签名输入是 `${timestamp}.` 前缀拼接**原始请求体字节**（先 `Buffer.from(`${timestamp}.`)` 再拼 body，不是字符串层面分开哈希）。

Node.js 订阅方校验示例：

```js
const crypto = require("node:crypto");

function verifyWebhook(req, secret) {
  const timestamp = req.headers["x-autocodeflow-timestamp"];
  const signature = req.headers["x-hub-signature-256"];
  if (!timestamp || !signature) return false;
  // ±5 分钟窗口
  if (Math.abs(Date.now() - Number(timestamp)) > 5 * 60 * 1000) return false;
  const expected =
    "sha256=" +
    crypto
      .createHmac("sha256", secret)
      .update(Buffer.concat([Buffer.from(`${timestamp}.`), req.rawBody]))
      .digest("hex");
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  // 常数时间比较
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
```

Python 订阅方校验示例：

```python
import hmac, hashlib, time

def verify_webhook(raw_body: bytes, timestamp: str, signature: str, secret: str) -> bool:
    if abs(time.time() * 1000 - int(timestamp)) > 5 * 60 * 1000:
        return False
    expected = "sha256=" + hmac.new(
        secret.encode(), timestamp.encode() + b"." + raw_body, hashlib.sha256
    ).hexdigest()
    return hmac.compare_digest(expected, signature)
```

> 快速上手：`POST /event-subscriptions` 传 `{ "url": "https://ci.example.com/hooks", "eventTypes": ["execution.failed"] }` → 从响应 `generatedSecret` 取出签名密钥（仅此一次可见）→ 用上面的校验方法在订阅方验证签名。验收路径：任务失败 → 订阅方收到带正确签名的失败事件（CI 触发部署场景）。

> **at-least-once 语义说明**：本版为进程内最低正确形态——首投 + 进程内重试 + 终败死信落库可重放。进程重启会丢失在途的退避重试（跨进程 outbox 留后续轮）；对「至少收到一次」要求严格的订阅方应同时容忍极端情况下的漏发（当前窗口：投递在途时重启），或依赖 replay 端点人工补发。

---

## Metrics — 监控指标

| 方法 | 路径 | 需要认证 | 说明 |
|------|------|:--------:|------|
| GET | `/metrics` | 是 | **Prometheus 抓取端点**（第七轮新增，prom-client）：text exposition format（Content-Type 由 registry 提供）。series：`autoflow_scheduler_ticks_total`、`autoflow_scheduler_tick_duration_ms_total`、`autoflow_scheduler_last_tick_duration_ms`、`autoflow_scheduler_triggers_total{result=claimed\|failed}`、`autoflow_scheduler_triggers_skipped_total{reason=lock_held\|db_claim\|inactive\|block_strategy}`、`autoflow_scheduler_dependency_triggers_total{result=claimed\|skipped}`、`autoflow_queue_depth{state=waiting\|active\|delayed\|failed\|completed}`、`autoflow_queue_up`（Redis 不可读时置 0、队列深度全部置 0）、`autoflow_execution_callback_auth_total{result=ok\|v1_expired\|v1_binding_mismatch\|v1_bad_signature\|legacy_shared_invalid\|missing_token\|bad_address}`（第九轮 N32 新增：`POST /executions/callback` 认证结果分类计数，per-execution `v1.` token 落地后的 401 排障观测；七个 result series 恒在、未计数时为 0）、`autoflow_scheduler_trigger_latency_ms_bucket{le=10\|50\|100\|250\|500\|1000\|2500\|5000\|+Inf}`、`autoflow_scheduler_trigger_latency_ms_sum`、`autoflow_scheduler_trigger_latency_ms_count`（CORE-06：定时触发 fixed_rate/cron 的 fire→入队延迟直方图；P99 查询 = `histogram_quantile(0.99, sum by (le, instance) (rate(bucket[5m])))`，avg = rate(sum)/rate(count)；Grafana row 5 面板已消费），以及进程默认指标（CPU/内存/GC，`METRICS_PROMETHEUS_DEFAULT_METRICS_ENABLED=false` 可关）。env 开关 `METRICS_PROMETHEUS_ENABLED`（默认 `true`；`false` 时本端点返回 404，用于多实例下避免重复抓取或安全收紧场景）。计数为进程内快照映射，多实例部署按 target 各自抓取 |
| GET | `/metrics/summary` | 是 | 系统概览统计 |
| GET | `/metrics/trend?days=` | 是 | 每日执行趋势（`days` 默认 7，上限 90） |
| GET | `/metrics/executors` | 是 | 执行器负载和状态统计 |
| GET | `/metrics/failures` | 是 | 最近失败执行列表 |
| GET | `/metrics/scheduler` | 是 | 调度器可观测性（第五轮新增）：tick 计数/耗时、trigger claimed/skipped/failed、依赖扇出 claim、BullMQ 队列深度、isLeader 与 pid/hostname（多实例区分）；进程内计数，重启归零。CORE-06 追加：`triggerLatencyCount/SumMs/Buckets`（与 TRIGGER_LATENCY_BUCKETS_MS 对齐的累计桶）与派生 `derived.avgTriggerLatencyMs`/`derived.p99TriggerLatencyMs`（直方图插值） |

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

## AI — AI 配置与测试

| 方法 | 路径 | 需要认证 | 说明 |
|------|------|:--------:|------|
| GET | `/ai/config` | 是（Admin） | 获取当前 AI 生效配置（`provider` / `openaiModel` / `openaiBaseUrl` / `ollamaHost` / `ollamaModel`）。API key 永不回传明文——仅返回 `hasApiKey: boolean` 表示系统配置库中是否已存有 `ai.openaiApiKey` |
| POST | `/ai/config` | 是（Admin） | 保存 AI 配置到系统配置存储（upsert，逐项写入）。body：`provider` 必填（`disabled` \| `openai` \| `ollama`）；`openaiApiKey` 可选，**非空时才更新**已存 key（留空/缺省不覆盖）；`openaiModel`（默认 `gpt-4o-mini`）、`openaiBaseUrl`（默认 `https://api.openai.com/v1`）、`ollamaHost`（默认 `http://localhost:11434`）、`ollamaModel`（默认 `llama3`）可选，缺省落默认值。响应 `{ ok: true }` |
| POST | `/ai/test` | 是（Admin） | 用已保存配置发送一次真实样例 AI 调用（失败分析样例），验证连通性与凭证。响应 `{ ok, message }`；AI 未启用（provider=disabled）或返回空响应时 `ok: false`（不打失败码）。`message` 为模型返回的分析文本或失败说明 |

> 三个端点均为 ADMIN-only（全局 RolesGuard 读取 `@Roles(ADMIN)` 元数据）：读配置暴露内部 baseUrl/host 拓扑，写配置可把出站调用重定向到任意外部主机，`/ai/test` 会真实消耗已配置 provider 的 API 配额。

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
| `NPM_REGISTRY_TOKEN` | 空 | 私有 npm registry 代理的预签发 access token（优先于 user/pass 组合，存在时直接以 `Bearer` 拉取包列表） |
| `NPM_REGISTRY_USER` | 空 | registry 代理 Basic Auth 用户名（与 `NPM_REGISTRY_PASS` 配套，用于 `PUT /-/user/login` 换取 bearer token） |
| `NPM_REGISTRY_PASS` | 空 | registry 代理 Basic Auth 密码 |
| `ALERT_WEBHOOK_SECRET` | 空 | Alertmanager webhook 入站 HMAC secret（OBS-02，`POST /api/alerts/webhook`）。留空 = 端点 503 禁用（安全缺省，绝不无鉴权接收）；配置后签名约定同发版 webhook。建议 `openssl rand -hex 32`。Alertmanager 配置样例见 `docs/observability/README.md` §3.5 |
| `SEC_SECRETS_KEY` | 空 | **任务级 secrets 落库加密密钥**（SEC-02）：32 字节 hex（`openssl rand -hex 32`）或 base64，其他口令按 sha-256 拉伸。留空 = tasks.secrets 明文存储（启动 warn 一次）；配置后写路径全加密（AES-256-GCM `enc:v1:` 信封），派发时解密注入执行器 env。**密钥丢失 = 密文 secrets 不可解密**（派发报错、不静默裸跑）——请纳入密钥管理系统备份；轮换 = 换 key 后对任务做一次任意 update |
| `EXECUTOR_HEARTBEAT_INTERVAL` | `30000` | executor 心跳间隔毫秒（FEAT-07 注记：心跳超时 sweep 触发的 OFFLINE 翻转现在会发布 `executor.offline` 出站事件，见「Event Subscriptions」段） |

> 三者全缺时 registry 代理保持匿名行为：authenticated-only registry（如 Verdaccio `access: $authenticated`）对包列表返回 401 → admin 包列表为空（仅 debug 日志提示凭证未配置），不视为错误。

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
