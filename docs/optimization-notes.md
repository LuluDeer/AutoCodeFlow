# 优化建议（基于 E2E 测试体验）

> 基于 Linux x86_64 平台完整流程端到端测试，涵盖：应用开发 → 打包部署 → 迭代发版 → 任务调度执行 → 报错排查 → executor 注册注销重注册 → 热更新全流程。

---

## 一、本次测试发现并修复的 Bug

| # | 问题描述 | 修复方案 |
|---|----------|----------|
| 1 | `executor-node` dotenv 加载时机问题：模块顶部代码在 `dotenv.config()` 前执行，`ADMIN_API_URL` 等变量读不到 | 将 `dotenv.config()` 移到文件最顶部，所有 import 之前 |
| 2 | 上传应用包时 `executorType` 无默认值，导致后续部署无法匹配执行器 | upload DTO 设置 `executorType` 默认值为 `python` |
| 3 | 同名应用重复上传触发数据库唯一约束冲突 | 改为 upsert 逻辑（按 appName 查找，存在则更新，否则创建） |
| 4 | 部署任务卡在 `deploying` 状态无超时自愈机制 | 增加部署超时检测，超时后自动回退为 `failed` |
| 5 | 执行器心跳接口触发 throttle 返回 429，执行器被误判下线 | 心跳接口豁免限流，或显著提高心跳路由的 throttle 阈值 |
| 6 | 管理端强制注销执行器的 `DELETE /executors/:id` 接口缺失或权限异常 | 补全接口及权限校验，确保 admin 角色可调用 |
| 7 | Webhook DTO 校验过严：传入 `runtime`/`executorType`/`upgradeStrategy` 返回 400，与用户直觉不符 | 在接口文档中明确声明仅接受三个字段，或改为 `whitelist` 模式忽略多余字段 |

---

## 二、admin-api 优化建议

### 2.1 版本历史记录（已支持）

`GET /applications/:id/versions` 已支持读取持久化版本快照；部署命令被执行器接受后会写入 `application_versions`，执行器心跳变为 `running` 时标记为 `released`，部署失败或超时会标记为 `failed`。

**当前状态：** 回滚功能可基于已发布版本快照恢复版本号、Git commit、包地址、运行时、入口、环境变量和 manifest；没有快照的历史部署仍通过部署记录兜底展示。

### 2.2 执行失败原因分类（已支持）

执行记录已支持 `failureReason` 结构化字段，用于区分包拉取/依赖安装失败、脚本错误、执行超时、执行器离线、手动终止和未知原因。

**当前状态：** admin-api 会在执行器回调、调度派发失败、任务超时和手动终止时写入失败分类；admin-web 执行详情页展示「失败分类」和定位提示，帮助用户快速判断下一步排查方向。

**后续增强：** executor 侧可继续细化失败上报来源，例如将依赖安装失败、Git 拉取失败、运行时不支持、进程启动失败拆成更具体的分类，便于后续统计和告警。

### 2.3 Webhook 认证依赖用户 Bearer Token（已支持签名）

CI/CD 系统不再需要存储长期用户 token。`POST /applications/webhook` 已标记为 Public 路由，但匹配到的应用必须配置 `webhookSecret`，调用方必须携带 `X-AutoCodeFlow-Timestamp` 和 `X-Hub-Signature-256`。

**当前状态：** admin-api 使用原始请求体做 HMAC-SHA256 校验，签名载荷为 `${timestamp}.${rawBody}`，时间戳允许 5 分钟窗口以降低重放风险；未配置 `webhookSecret`、缺失签名、签名错误或时间戳过期都会返回 401。

**后续增强：** 如需更细粒度授权，可继续设计限权 API Key（按应用绑定、作用域、过期/吊销、审计记录），但当前 CI/CD 发版路径已与用户 JWT 解耦。

### 2.4 任务缺少执行超时配置（已支持）

长时间运行的任务没有上限，会持续占用执行器，影响其他任务调度。

**当前状态：** 任务 API 已兼容 `timeoutSeconds` 并映射到现有 `timeout` 存储；Node/Python 执行器均按任务级超时执行，Python SDK 同步支持 `timeout_seconds`/`timeoutSeconds`。

### 2.5 Cron 任务缺少时区配置（已支持）

cron 默认使用服务器时区，跨时区团队会遇到调度时间错乱。

**当前状态：** 任务实体、DTO、迁移、前端表单和调度器已支持 `timezone` 字段；Cron 注册时将 IANA 时区（如 `Asia/Shanghai`）传给 `node-cron`。

### 2.6 执行日志存主库有膨胀风险（已落地，可选开启）

大量日志行写入 PostgreSQL 的 `execution_log_lines` 表，长期运行后会导致主库膨胀，`VACUUM` 压力大，也不支持实时流式读取。

**建议：** 考虑将日志流写入 MinIO 对象存储（已有基础设施），数据库只存日志文件的引用路径（bucket + key），API 返回时流式读取，支持大日志场景。

**当前状态：** 已实现可选的 S3 日志驱动（`LOG_STORAGE_DRIVER=s3`）：`S3LogStorage`（`src/modules/task/log-storage/`）将每次执行的完整日志作为单个 gzip 对象上传 MinIO（自动建桶），`task_executions` 新增 `logStorage`/`logObjectKey` 列只存引用；`getExecutionLogs` 分页与 SSE `streamExecutionLogs` 均支持 s3 读取（终态后一次性下发），上传/读取失败自动回退 DB 行存储。docker-compose 提供 `minio` profile 服务（`--profile minio`），迁移 `1717473142690-AddExecutionLogStorage`。默认仍为 `db` 驱动，行为不变。

---

## 三、executor 优化建议

### 3.1 启动时做 ADMIN_API_URL 连通性自检（已支持）

executor 容器若 `ADMIN_API_URL` 配置错误（写成 `localhost:3105`），现在会在启动阶段主动暴露，降低排查成本。

**当前状态：** Node/Python executor 启动时会主动探测 Admin API `/api/health`，不可达时打印明确警告并按指数退避重试；多 Admin URL 场景下 Node executor 会选择首个可达地址，启动后心跳仍会继续后台重试。

### 3.2 executor 重启后任务状态不一致（已支持）

executor 容器重启后，正在运行的任务现在会被主动收敛，不再永久卡在 `running`。

**当前状态：** Node/Python executor 启动注册与心跳会携带 `restartedAt` 与 `startupId`；admin-api 检测到同地址执行器启动标识变化后，会将该执行器上仍处于 `running` 的执行记录标记为 `failed`，并写入结构化失败原因 `executor_restart`，前端执行详情页会展示对应定位提示。

### 3.3 应用包解压路径无版本隔离（已支持）

executor 部署应用包时会按版本与部署 ID 写入不可变 release 目录，不再直接覆盖旧版本目录。

**当前状态：** Node executor 会将应用发布到 `<workDir>/apps/<applicationId>/releases/<version>-<deploymentId>/`，先在同一应用的 `tmp/` 目录完成下载、解压、依赖安装与环境文件写入，再原子切换 `current` 指针；若切换后启动失败，会尝试恢复到上一个 `current` 目标。admin-api 下发部署命令时会携带应用版本，重复部署同一版本也会通过 deploymentId 保持物理目录隔离。

### 3.4 多平台支持现状

| 平台 | Docker 部署 | 裸机部署 | 验证状态 |
|------|------------|---------|----------|
| Linux x86_64 | ✅ | 未测试 | **已验证（E2E 35/35）** |
| macOS Intel | 理论可行 | 未测试 | 未验证 |
| macOS Apple Silicon | 需 arm64 镜像 | 未测试 | 未验证 |
| Windows WSL2 | 理论可行 | 不推荐 | 未验证 |
| ARM64 Linux | 需 arm64 镜像 | 未测试 | 未验证 |

**跨平台路线图：**
- **macOS Apple Silicon**：Dockerfile 使用 `--platform=linux/arm64`，或通过 `docker buildx` 构建多架构镜像
- **Windows WSL2**：提供 WSL2 + Docker Desktop 安装文档，现有镜像可直接复用
- **裸机部署**：需处理路径分隔符（`path.sep`）差异和 Windows 上无 `SIGTERM` 信号的问题

---

## 四、整体机制优化建议

### 4.1 executor 调度缺少负载感知

当前任务分配仅按 `executorType` 匹配，不感知执行器当前负载，多执行器场景易产生热点。

**建议：** executor 心跳携带当前并发任务数（`runningTaskCount`）。admin-api 调度时优先选择同类型中负载最低的执行器（最小并发数优先）。

### 4.2 版本历史与部署记录语义割裂

`/applications/:id/versions`（版本快照）和部署记录语义接近，但 API 分离、数据未打通，难以追溯「这次部署用了哪个版本包」。

**建议：** 考虑合并为统一的 `/releases` 资源，每条记录包含：版本号、包地址、部署时间、状态、触发方式（webhook/manual）、操作人。

### 4.3 缺少多租户/项目隔离

当前系统是单命名空间模型，所有应用和任务对所有用户可见（除 admin/viewer 角色差异外），不同团队的资源无法隔离。

**建议（中期）：** 增加 `Project` 或 `Organization` 层级，应用/任务/执行器均归属于某个 project，JWT 中携带 project 上下文，实现资源隔离和访问边界。

---

## 五、测试覆盖说明

本轮 E2E 测试在 Linux x86_64 Docker Compose 环境下完成，覆盖以下场景：

- ✅ 认证（登录、Token 刷新）
- ✅ 执行器在线状态检查
- ✅ 应用创建、应用包上传（ZIP）
- ✅ CI Webhook 触发部署
- ✅ 手动任务创建、glue script 上传、手动触发执行
- ✅ Cron 任务创建与调度
- ✅ 任务暂停（disable）与恢复（enable）
- ✅ 执行日志查询与错误排查
- ✅ 应用热更新（新版本包上传 + webhook 触发 + upgrade-all）
- ✅ 执行器注销（管理端 DELETE）与重新注册（容器重启）
- ✅ 清理（任务、应用、执行器删除）

**未覆盖（待后续验证）：**
- ⬜ macOS / Windows / ARM64 平台部署
- ⬜ 通知渠道配置（企业微信、钉钉、邮件）
- ⬜ 私有 npm/PyPI 仓库集成
- ⬜ 多执行器负载均衡行为
- ⬜ 任务重试配置生效验证
- ⬜ 大规模并发任务压测

---

## 六、第三轮审查修复完成清单（2026-09-02）

> 本轮为代码审查驱动的修复（对应 `docs/PROGRESS-round3-2026-09-02.md`），按 Stream A–D 并行落地，
> 全量回归：admin-api **518/518（37 suites）+ tsc ✓**，executor-node **79/79 + tsc ✓**。
> 分组提交：`8bb3790`（A）/ `7851ebd`（B）/ `723efbf`（C）/ `b1fbbef`（D）/ `eadedca`（executor-node）。

### 6.1 调度器与任务执行（Stream A）

| 条目 | 状态 | 修复说明 |
|------|:----:|----------|
| Leader Election | ✅ | 调度器多实例 Leader Election：Redis 锁 key `scheduler:leader`（实际 Redis key `lock:scheduler:leader`），TTL 30s，watchdog 每 10s（TTL/3）续期，另设 15s（TTL/2）校验定时器；续期失败自动 demote，锁服务不可用时 fail-open 降级为 leader（不停调度），配合条件 claim 兜底防重复触发 |
| TASK-006 | ✅ | 定时触发原子领取：`claimTaskTrigger` 条件 UPDATE（`WHERE status=... AND nextRunAt<=now`），多实例下同一触发只会被领取一次，与 Leader Election 形成双保险 |
| TASK-003 | ✅ | reload 与 scheduleOne 竞态收敛：跨进程路径全部经过 leader / claim 保护 |
| TASK-004 | ✅ | `recoverStaleExecutions` 由逐条 save 改为分批条件 UPDATE（`RETURNING` 批量取回，保留逐行终态保护语义） |
| TASK-007 | ✅ | 任务依赖环检测增加深度上限 64（`MAX_DEPENDENCY_DEPTH`），超长依赖链直接抛 400，消除串行 N+1 DoS 向量 |
| TASK-008 | ✅ | SSE 日志流两级并发上限：单 execution 4 个 / 全局 64 个连接，超限在写出响应头前返回 503；槽位幂等释放（正常结束 / abort / 异常 / 兜底双保险）。注：配置键 `sse.maxStreamsPerExecution` / `sse.maxStreamsGlobal` 尚未在 configuration.ts 注册，当前实际生效的只有默认值 4/64 |

### 6.2 数据库（Stream D）

| 条目 | 状态 | 修复说明 |
|------|:----:|----------|
| DB-001 | ✅ | task 软删除：`@DeleteDateColumn` + 迁移 `1717473142700`（TIMESTAMP 与既有列一致），TypeORM find 自动排除已删除行 |
| DB-002 | ✅ | 执行日志保留期清理服务：`LOG_RETENTION_DAYS`（默认 30 天），每日 03:30 cron 分批删除（每批 ≤5000 行）防长事务，timer `unref()`；非法配置回退默认值并告警 |
| DB-003 | ✅ | `getAllExecutions` N+1 收敛为 getManyAndCount + PK-IN 批量查询 |
| DB-004 | ✅ | ApplicationVersion 增加 `(applicationId, version)` 唯一索引 + 迁移 |
| DB-005 | ✅ | 重复迁移时间戳 1717473142685 重命名（→2694，含类名），顺序语义不变，幂等 up/down；并补充迁移时间戳唯一性守卫测试 |
| DB-006 | ✅ | username 增加 `@Length(3,128)` + varchar(128) 迁移 |
| DB-007 | ✅ | system_config.value 明确 varchar 长度 + 迁移 |

### 6.3 通知 / AI / 部署（Stream B）

| 条目 | 状态 | 修复说明 |
|------|:----:|----------|
| NOTIF-002 | ✅ | `sendAll` 日志不再记录通知原文，只记渠道类型 + 内容长度 + 净化后截断摘要（80 字符，脱敏） |
| NOTIF-003 | ✅ | silences 内存 Map 增加 1000 条上限 + 60s 定期清理过期条目（interval `unref()`）；重启丢失作为可接受降级已在注释注明 |
| AI-002 | ✅ | `suggestSchedule` AI 失败/解析异常不再静默：服务端记 warn 日志，响应携带 `fallback: true` 标记（`suggestedCron` 回退当前值），调用方可区分 AI 建议与回退值 |
| APP-001 | ✅ | webhook 所有鉴权失败路径（应用不存在 / 未配置 secret / 签名缺失或错误 / 时间戳过期 / raw body 缺失）统一返回相同的 401 `"Webhook authentication failed"`，不再区分原因（防应用名枚举），具体原因仅记服务端日志 |
| APP-002 | ✅ | 应用包上传不再静默回退 `http://localhost:PORT`：`API_BASE_URL` 缺失时 fail-fast 返回 500 并提示配置，避免存下 executor 不可达的 `packageUrl` |

### 6.4 架构与基础设施（Stream C）⚠️ 含部署破坏性变更

| 条目 | 状态 | 修复说明 |
|------|:----:|----------|
| ARCH-001 | ✅ | CORS 改为显式白名单：`CORS_ALLOWED_ORIGINS`（逗号分隔，兼容旧 `CORS_ORIGINS` 回退）；移除私有/LAN 网段自动放行；生产必填且禁止 localhost/127.0.0.1（fail-fast），开发环境未配置时仅放行 `http://localhost:*` / `http://127.0.0.1:*` |
| ARCH-002 | ✅ | `/uploads` 静态文件增加鉴权中间件：管理台用户 JWT（同 jwt.secret、要求 `type=access`）或 executor 共享 token 二选一；公开前缀白名单 `PUBLIC_UPLOAD_PREFIXES` 当前为空（fail closed）。**破坏性变更：旧版本 executor-node 下载应用包会收到 401，必须同步升级** |
| ARCH-003 | ✅ | multipart 上传绕过校验修复：`POST /applications/upload` 改用 `UploadApplicationDto`（`name` 必填 ≤100、`runtime` 可选 ≤50）经全局 ValidationPipe（whitelist + forbidNonWhitelisted），非法字段返回 400 |
| ARCH-004 | ✅ | 全局限流默认由 100/min 收紧为 60/min，可用 `THROTTLE_LIMIT` / `THROTTLE_TTL` 覆盖；登录等敏感路由保留独立更严格限流 |
| ARCH-005 | ✅ | Redis TLS 支持：`REDIS_TLS=true` 时 ioredis/BullMQ 连接启用 TLS；`REDIS_TLS_REJECT_UNAUTHORIZED`（默认 true）仅自签证书调试时关闭 |
| ARCH-006 | ✅ | schema 同步改为显式 `DB_SYNCHRONIZE` 开关（默认 false，不再依赖 NODE_ENV 推断）；生产环境设 true 直接 fail-fast，变更一律走 migrations |
| ARCH-007 | ✅ | 生产环境跳过 OpenAPI 文档构建并关闭 Swagger UI，server URL 不再泄露 |
| ARCH-008 | ✅ | `unhandledRejection` / `uncaughtException` 不再直接 exit(1)：先 log 再走优雅关闭（drain 在途请求、关 DB 池、flush Bull），10s 超时兜底强制 exit(1) 保证编排器可重启容器 |

### 6.5 集成收尾（负责人修复）

- ✅ executor-node 下载应用包携带 `Authorization: Bearer <共享token>`，跨主机重定向时剥离凭证避免 token 外泄
- ✅ suggestSchedule 的 `fallback` 标记在 controller 层透传
- ✅ 删除无引用死代码 4 处（含 `error-codes.ts`——`docs/api-reference.md` 旧的「业务错误码 1001/1002…」表已随之失效，本次文档同步一并修正为 HTTP 状态码语义）
