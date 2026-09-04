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

## 七、第四轮全新对抗性排查完成清单（2026-09-02）

> 方法：4 路只读 audit（安全/并发/执行器/契约）→ 负责人逐条核实（5 P0 + 关键 P1 全部坐实）→ 7 路 fix agent 按不重叠文件所有权并行修复 → 集成 seam + 全量回归。findings 全文见 `docs/review_round4_*.md`，过程追踪见 `docs/PROGRESS-round4-2026-09-02.md`。

### 7.1 调度与任务链（`d2613d6`）

- ✅ P0 触发去重锁被 watchdog 无限续期 → 每个定时任务一个进程生命周期只触发一次（`acquireLock` 新增 `renew` 选项，trigger 锁 `renew:false` 恢复 TTL 自然过期语义）
- ✅ P0 依赖任务链死代码（worker 路径永不写 SUCCESS）→ `triggerDependentTasks` 迁入 `handleCallback` 条件 UPDATE 赢家路径，幂等扇出
- ✅ P1 多页日志回填丢页 → `storeLogLines` append 语义（首页 replace 后续追加，S3 读回拼接）
- ✅ P1 COVER_EARLY 盲写 → 条件 UPDATE + RETURNING（对齐 TASK-004 模式）

### 7.2 安全（`b0aa67f`）

- ✅ P1 RBAC 全局生效：RolesGuard 注册 APP_GUARD；config 写端点/共享 token 明文读取/executor-package 全部 @Roles(ADMIN)；@Public 机器端点空 @Roles() 覆盖
- ✅ P1 heartbeat/register 列注入：controller 白名单构造 + service 逐字段赋值（原 Object.assign 可覆写 tokenHash 成轮换不可吊销的持久后门）
- ✅ P2 SSRF 覆盖：`assertSafeExecutorUrl`（恒拒元数据/未指定段，默认放行私网段，`EXECUTOR_ALLOW_PRIVATE_NETWORK` 放 loopback）接入 dispatch/broadcast/reload-config/pushToExecutors + dingtalk/wecom/slack 渠道
- ✅ P2 登录枚举时序拉平（dummy bcrypt compare）；callback 端点移除 SkipThrottle 改 60/min + token 校验 60s 正向缓存；trust proxy 改显式开关
- ✅ P1 SSE query token：仅 `/logs/stream` 路径接受 `?access_token=`（type=access 强制）
- ✅ P1 config/history 与 audit 筛选 QueryDto（修 forbidNonWhitelisted 恒 400）

### 7.3 执行器运行时（`f792e10` python / `f0f61e5` node）

- ✅ P0 python shell entrypoint 命令注入（字符白名单 + 位置参数，对齐 node 6062bee）
- ✅ P1 callback >100 批次被硬拒 + 毒文件无限重发 → ≤100 分片 + .meta 重试计数 + dead-letter 终态
- ✅ P1 部署子进程 env 白名单（EXECUTOR_SHARED_TOKEN 不再透传给被管应用）
- ✅ P1 node 任务 requirements 不可解析（NODE_PATH）；P1 stdout/stderr 无上限（BoundedLogBuffer / 10MB+64MB 截断）；P1 磁盘无回收（TTL sweep + 6h 定时）
- ✅ P2 update-package 缺 Bearer/慢滴卡死（共享下载器 + watchdog + 路径穿越校验）；deploy.ts spawnSync→async；进程组 kill 防孤儿；/api/logs 分页修正；git 缓存盐与串行队列

### 7.4 跨端契约（`75c8d2b`）

- ✅ P0 CLI 登录字段名错（access_token→accessToken，此前 CLI 全命令 401）；P0 应用编辑恒 400（不再提交 name）
- ✅ P1 安装向导 404（走 install-cmd，后端删坏 curlCmd）、latest 包列表、下载带 auth、AI 分析字段、SSE 参数名、trigger executorId 移除

### 7.5 基线

admin-api **605/605（45 suites）** · executor-node **119/119** · executor-python **86/86** · 三端 tsc ✓ · admin-web lint 0 errors。

## 八、第五轮收尾 + 首次真机验证（2026-09-02）

> 方法：4 代码流（I 并发收尾+可观测性 / J flake 加固 / K RBAC 收尾+前端门控 / L CLI-MCP 补全）+ V 真机验证（docker compose 双实例/三实例拓扑）→ 真机新发现 N1-N6 → W1/W2 修复 → V2 真机复验闭环。报告：`docs/VERIFY-round5-e2e.md`、`docs/VERIFY-round5v2-n2.md`。

### 8.1 代码流（`0a7ebcb` `1864597` `51469d6` `9e8f2ae`）

- ✅ 依赖扇出 10s DB claim（双上游并发只触发一次下游）+ checkDependencies take 兜底；storeLogLines DB 路径事务化
- ✅ 可观测性：SchedulerMetricsService（tick/claimed/skipped×4/failed/依赖扇出计数）+ BullMQ 队列深度 + `GET /metrics/scheduler`（零新依赖）
- ✅ flake 元凶：file-logger spec UTC/本地日期错位（超前时区机器每天 8 小时确定性失败）；4 spec 确定性化 + 5 TZ 交叉验证
- ✅ audit 收紧 ADMIN；孤儿 install-token 端点删除；admin-web 角色门控（role 来源 /auth/profile，RequireAdmin + 菜单隐藏 + settings 写禁用）
- ✅ CLI/MCP P1 补全 10 组命令/tool + 5 个既有契约 bug 顺带修 + vitest 基建（41+40 测试）

### 8.2 真机验证首战价值：抓到单测永远抓不到的 P0（`2642293` `d2be430`）

- ✅ Leader Election 双实例 80 execution 无重复无丢失、kill Leader 35s 接管（d2613d6 触发锁修复真机回归通过）
- ✅ LOG-11 S3 对象存在 + 内容一致 + API 读取闭环；负载均衡精确 2+2 无超卖
- ❌→✅ N2(P0)：PG enum 列运行时返回字符串 label，原样传 BullMQ 致**所有调度入队 100% 失败**——单测全 mock queue 从未暴露。normalizeTaskPriority 入队边界归一化，V2 复验 96/96 success
- ❌→✅ N1(P1)：全新 DB 迁移链 3 处断裂（app_deployments 无建表/version 撞名/rename 时序）+ typeorm CLI 命中 spec 崩溃——幂等化 + 补偿迁移，空库 24/24 + 存量续跑数据无损双验证
- ✅ N3 假 Leader 竞态、N4 register 轮换风暴、N5 stale cutoff、N6 去重 TTL 压制短周期任务——全部修复并真机复验（N6 隔离实证 300s 12 触发 vs 旧 ~3）

### 8.3 基线

admin-api **669/669（47 suites）** · executor-node **119/119**（5 连跑稳定）· executor-python **86/86** · admin-web vitest 15 + lint 0 errors · acf-cli 41 / mcp-server 40 · 三端 tsc ✓。

### 8.4 方法论沉淀

**mock 一切不等于能跑**：五轮排查中 admin-api 单测从 432→669 全绿，但 BullMQ 参数校验、PG enum 读回形态、迁移链全新库执行序这三类问题只有真机能暴露。后续任何调度/队列/迁移改动，验收标准应包含 compose 冒烟（下一步建议 #2 的 CI 方案已含）。

---

## 九、第六轮：遗留清零 + CI 落地 + install.sh 闭环 + audit 修复（2026-09-03）

> 方法：侦察 → A/B/C/D 四路并行（N6+DTO / CI / install.sh+pinning / 只读 audit）→ audit triage（N7-N16 共 9 项）→ F1/F2/F3 三路修复 → V 真机验证 6/6 PASS。报告：`docs/PROGRESS-round6-2026-09-03.md`、`docs/VERIFY-round6-e2e.md`。

### 9.1 本轮要点

- ✅ N6 残留抖动：去重锁 TTL = 周期−500ms（acquire 相位滞后 δ 是根因）——真机 15s 任务 gap 均值 15.000s 零抖动（修复前 15/30 混合）
- ✅ 任务 API：id UUID 校验（400/409）+ executor pinning（迁移 25 + dispatch pinned 分支，真机三语义 PASS）
- ✅ install.sh 全链：后端承载路由 + install-cmd curl|bash + N15 注入校验 + 双副本漂移守卫
- ✅ audit N7-N15：N7 查询白名单旁路（TS 交叉类型→design:paramtypes=Object，显式 DTO 修复）、N8 SSE 30s 掐断（@SkipTimeout 装饰器）、N9 worker Map 泄漏（5min 惰性回收）、N10-N13（CLI killed 终态/mcp-server 超时文案/RBAC+脱敏/admin-web 类型）
- ✅ CI：ci.yml 重写 12 jobs（develop 触发 + e2e 真机修绿 37/37 + 迁移链双轮幂等 job）
- ⚠️ RBAC 姿态决策：GET /executors 保持登录可见不收紧 ADMIN（任务 CRUD 对普通用户开放 + executions 侧本就暴露 executorAddress，锁列表只打断 TaskFormPage 且挡不住侧信道）；notification/ai config 收紧 ADMIN + 密码脱敏（前端读面 403 待第七轮跟进）

### 9.2 基线

admin-api **730/730（51 suites）** · executor-node **125/125** · executor-python **86/86** · admin-web **19** · acf-cli **45** · mcp-server **48** · 全端 tsc ✓。

### 9.3 方法论沉淀

**类型系统在装饰器边界的静默失效**：TS 交叉类型作 NestJS @Query() 参数时 emitDecoratorMetadata 退化为 Object，ValidationPipe 白名单整个旁路——tsc 全绿不等于校验生效。审计手段：对 design:paramtypes 做元数据断言并固化进测试（execution-query.dto.spec）。同族问题：类型断言与后端实际返回不符（N13 admin-web pause/resume）属于"编译通过的谎言"，修复时应补编译期守卫测试。

---

## 十、第七轮：依赖/质量清零 + prometheus + 通知真机闭环 + N17-N24（2026-09-03）

> 方法：A/B/C/D 四路并行 → audit triage → E1/E2 修复 → V 真机 5/5 → W 真机新发现修复 → V2 复验。报告：`docs/PROGRESS-round7-2026-09-03.md`、`docs/VERIFY-round7-e2e.md`、`docs/VERIFY-round7v2-fixes.md`。

### 10.1 本轮要点

- ✅ 依赖清偿：四端 audit 官方源修复（executor-node qs overrides 非 force）；admin-api eslint 163→0/0；coverageThreshold 地板化恢复 CI coverage；CI 新增 npm-audit job
- ✅ prom-client 15.1.3 `GET /api/metrics`（快照 reset+inc 模式零热路径侵入）；install-cmd 503 降级
- ✅ admin-web /notifications 门控 + AI Tab 降级；组件测试基建建立
- ✅ N17 pinning PATCH 互斥绕过（合并态兜底）；N18/N21 registry-pypi 哈希 sidecar + 上传防重；N19-N24 全消
- ✅ 通知真机闭环：五渠道外发 + SMTP 会话；V 抓到 V1-V5（config 解耦/SSRF fail-open/deny 缺段/500/死引用）→ W 修复 → V2 复验

### 10.2 基线

admin-api **774/774（52 suites）+ eslint 0/0** · executor-node **125** · executor-python **86** · admin-web **33** · acf-cli **48** · mcp-server **52** · registry-pypi **30** · node-sdk **32** · notify **7**。

### 10.3 方法论沉淀

**配置面与生效面解耦是隐性缺陷温床**：通知渠道 PATCH 保存 config 后外发仍读 env（V1）——管理界面让用户以为生效的设置实际无效，单测全绿因为 mock 了 config 层。修复原则：写路径与读路径必须共享同一事实源（ChannelConfigStore），且脱敏层只能作用于读面（GET 响应），绝不渗透到发送路径。

**真机借道取证要转为守卫收紧**：V 首轮为取证借 198.18.0.1（TUN 接口）绕过 SSRF 守卫——这个"绕过路径"本身就是发现（V3），当轮即把该段与 100.64/10 收进 deny 列表。真机验证中所有"为通过验证而做的临时放行"都应回看为安全缺口候选。

**PATCH 语义校验必须看合并态**：互斥/组合类约束（如 N17 pinning×broadcast）只在 DTO 层校验会漏掉 PATCH 部分更新——校验点应在 Object.assign 之后、save 之前，对最终实体态判定。create 全字段同传时该洞不可见，只有 PATCH 路径暴露。

---

## 十一、第八轮：回调 token 三端落地 + artifact 通道 + E2E 25/25 + P0/P1 双闭环（2026-09-03）

> 方法：A/B/C/D 四路并行 → audit+E2E triage → W1/W2 修复 → V 真机 5/5 → W P1 击穿修复 → 收尾。报告：`docs/PROGRESS-round8-2026-09-03.md`、`docs/VERIFY-round8-e2e.md`。

### 11.1 本轮要点

- ✅ per-execution 回调 token（N23 根治）：域分离 HMAC、SEC-01 白名单不破、v1. 前缀 fail-closed、双端测试向量防漂移；N26 bcrypt 矛盾以 tokenHash 字符串为双端 HMAC key 解决
- ✅ install.sh artifact 真通道 + ci-local.sh（push 无凭证期验收通道）+ registry-npm healthcheck 修复
- ✅ Playwright E2E 25/25：抓到 P0（分步表单 validateFields 只回挂载字段 → 创建 UI 不可用）→ getFieldsValue(true) 转正守卫
- ✅ N25 `::ffff:` SSRF 绕过归一修复；N28 显式 null；N29 test 面真实 results；N30 os.link 防重；N31 render 串行化
- ✅ V 抓到 P1 稳态击穿：fetchToken 不拆信封 + 201 误判 200 → token 旋转风暴 → 三层修复（拆信封/issueToken 幂等/tokenHash 三点采纳）

### 11.2 基线

admin-api **840/840（53 suites）+ eslint 0/0** · executor-node **150/150** · Playwright **25/25** · executor-python **86** · admin-web **35** · acf-cli **48** · mcp-server **52** · registry-pypi **33** · node-sdk **43** · notify **7**。

### 11.3 方法论沉淀

**信封层是所有客户端的隐形契约**：admin-api 全局 ResponseInterceptor 的 {code,message,data} 包装已在 acf-cli、mcp-server、executor-node 三处造成同类 bug（前者 round4 修过，后两者本轮/上轮暴露）。修复模式固化：任何新客户端第一件事是拆信封 util（unwrapAdminResponseData），并对状态码用 2xx 区间而非 ===200（Nest POST 默认 201）。

**稳态循环是幂等性破坏的放大器**：fetchToken 失败→重试→旋转→其他依赖方（HMAC 密钥）失效→更多失败——单点 bug 经循环放大为系统不可用（9 分钟 14 次旋转）。防御：写路径幂等化（issueToken 按 startupId 稳态永不旋转）+ 依赖方跟随机制（tokenHash 三点采纳）双管齐下，只修其一在下一个依赖出现时复发。

**分步表单的校验 API 陷阱**：antd Form validateFields 只校验/返回当前挂载的 Form.Item——跨步骤提交必须 getFieldsValue(true)（preserve store 全量）+ 自行兜底必填。此类缺陷 vitest 组件测试难覆盖（难模拟真实分步挂载），E2E 是唯一可靠防线。

---

## 十二、第九轮：python 侧对齐 + 401 观测 + pinned 全链 E2E（2026-09-03）

> 方法：A/B/C/D 四路并行 → V 真机 5/5 + audit N33-N36 → W 收尾修复。报告：`docs/PROGRESS-round9-2026-09-03.md`、`docs/VERIFY-round9-e2e.md`。

### 12.1 本轮要点

- ✅ executor-python token 链三缺口修复（201 误判/未拆信封/缺 startupId）——动态 token 首次真正生效，真机 /token 幂等复用兑现
- ✅ autoflow-sdk 回调能力（node-sdk 对等）+ executor-python 回调三变量注入（HMAC 移植，三方同测试向量逐字节一致）
- ✅ 回调 401 七分类观测 series；webhook 配置面补全（config-first + query 脱敏）
- ✅ Playwright 29/29（pinned 全链 4 例：在线/离线/不存在/全 UI 闭环）
- ✅ P1（V 抓到）：python register 用动态 token 打 bootstrap 端点 401 → 静态 token 修复；N34-N36

### 12.2 基线

admin-api **861/861 + eslint 0/0** · executor-node **150** · executor-python **115** · autoflow-sdk **90** · admin-web **35** · Playwright **29** · acf-cli **48** · mcp-server **52** · registry-pypi **33** · node-sdk **43** · notify **7**。

### 12.3 方法论沉淀

**修复揭开被掩盖的 bug 是常态而非意外**：python register 401 在 token 链修好前不可能暴露（fetch 恒失败→恒用静态 token→恰好"对"）。真实缺陷链被上游缺陷掩盖时，上游一修下游就塌——所以修复后必须在真机把整条依赖链重跑一遍（本轮 V 在修复后立即发现 register 401），单点回归不够。

**跨语言算法移植必须三方钉测试向量**：HMAC token 算法 TS→python 移植，admin-api/executor-node/executor-python 三方用同一测试向量（secret+execId+exp→同一 token 字符串）互相钉死。任何一端单方面改算法（哪怕改注释里的域分隔符）都会三方同红，漂移在 CI/本地即可拦截，不会到生产才炸。

**观测埋点跟随验证走**：401 七分类不是先设计后埋点，而是真机验证时"每类 401 都要能区分"直接转化 为 series 分类——验证脚本里的每个断言场景对应一个可观测类别，观测体系与验证体系同构，生产排障时看到的每个异常形态都有现成指标。

---

## 十三、第十轮：观测面板 + 发布管道 + 旋转窗口收敛（2026-09-04）

> 方法：A/B/C/D 四路并行 → W 收尾 N37-N42。报告：`docs/PROGRESS-round10-2026-09-04.md`。

### 13.1 本轮要点

- ✅ docs/observability/：Grafana 11 panels + 6 条告警（series 与源码逐字核对零偏差，不可推导处如实标注）
- ✅ release.yml（version-guard + npm/PyPI + environment 审批门）+ 双 SDK README 矩阵；修掉 pydantic 未声明依赖的发布级 bug
- ✅ 旋转 token 窗口评估实为最坏 30min（60s 缓存掷硬币 + 离线级联）→ executor-node 401 自愈 + rotateToken 播种缓存，收敛到一次往返
- ✅ N37-N42 全消（webhook 优先级链/文档补漏/python 判据/repr 泄漏/release 审批门）

### 13.2 基线

admin-api **870/870 + eslint 0/0** · executor-node **158** · executor-python **115** · autoflow-sdk **91** · admin-web **35** · Playwright **29** · 其余同前。

### 13.3 方法论沉淀

**"幂等复用窗口"要按最坏路径评估**：tokenHash 对齐窗口交接假设"≤一个心跳（30s）"，实测是掷硬币——正向缓存命中则 30s，错过则持续 401 到 30min 定时刷新，且伴随 90s 判离线级联。有缓存的系统，最坏路径永远是"缓存恰好失效+刷新周期最长"，评估时必须画出状态机而不是取均值。

**配置覆盖优先级要写进契约并测试钉死**：webhook URL 的三层来源（显式参数/保存 config/env）在三轮演进中顺序翻过两次（显式→config-first→显式优先），每次翻转都有消费方被静默改道。教训：多来源配置的优先级必须在端点文档明示 + 每层优先级各有独立测试，翻转时旧断言被迫明确更新而不是默默通过。

**发布级 bug 的形态是"本地全绿、发布即崩"**：pydantic 未声明依赖——开发环境装过全局包所以 import 永远成功，wheel 装到干净机器第一行就崩。防御：npm pack --dry-run / python -m build 的产物在干净 venv 里 import 一遍（本轮 B 流已建立该演练模式）。
