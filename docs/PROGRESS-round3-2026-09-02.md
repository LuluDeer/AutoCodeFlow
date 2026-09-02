# Round 3 任务指派与进度追踪（2026-09-02）

> 负责人会话使用。四条并行工作流（subagent），文件所有权严格划分避免冲突。
> 完成后由负责人统一集成（全量 jest + tsc）、分组提交并回写 AGENT_HANDOFF.md。

## 全局约束（所有 agent 必读）

- 项目根：`/home/yongsheng/project/AutoCodeFlow`，主战场 `apps/admin-api`（NestJS + TypeORM + BullMQ + ioredis）。
- 基线：admin-api 432/432 jest 全绿（commit 4d87e77）。**不要跑全量 jest、不要跑项目级 `tsc --noEmit`**（其它 agent 正在并行编辑，只跑自己相关的 `npx jest <路径过滤>`）。
- 不 commit、不改 `AGENT_HANDOFF.md` / `docs/review_*.md`。
- 新增出站 HTTP 必须走 `src/common/utils/safe-http.util.ts` 的 `assertSafeHttpUrl`（SSRF 单点防护）。
- 全局 `ResponseInterceptor` 会包 `{code,message,data}`，勿破坏。
- 先补/改测试再改实现；中文注释与现有风格一致。
- 新迁移文件时间戳分配：Stream A 用 `1717473142700`，Stream D 从 `1717473142701` 递增，禁止重复（DB-005 教训）。
- 改动 `*.module.ts` 时只做 provider 追加，不动别人的行。

## Stream A — 调度器与任务执行（负责人重点验收项）

文件所有权：`src/scheduler/**`、`src/task/**`、`src/common/**redis-lock**`、`src/entities/task.entity.ts`、新迁移(…700)。

| 项 | 内容 | 要求 |
|----|------|------|
| P0/TASK-006 | 多实例重复扫描 | 调度器 Leader Election（基于 RedisLockService，带续期，非 Leader 跳过扫描 tick）+ 定时任务领取用条件 UPDATE 原子 claim（`WHERE status=... AND nextRunAt<=now`），双保险 |
| TASK-003 | reload vs scheduleOne 竞态 | 现有进程内 Set 基础上，使跨进程路径全部经过 leader/claim 保护；补竞态单测 |
| TASK-004 | recoverStaleExecutions 逐条 save | 改批量条件 UPDATE（单事务 / `WHERE id IN`），保留逐行终态保护语义 |
| TASK-007 | checkCircularDependency 深度 DoS | 加最大深度/访问集合上限，超限抛 BadRequest |
| TASK-008 | SSE 日志流无并发上限 | 每 execution 与全局两级连接上限，超限 503/拒绝，带释放 |
| DB-001 | task 软删除 | `@DeleteDateColumn` + 迁移；确认 TypeORM find 自动排除；FK 引用行为在迁移注释说明 |
| DB-003 | getAllExecutions N+1 | 单次 join 查询 + Map 组装收敛为一条 SQL 或明确的两条查询 |

## Stream B — 通知 / AI / 部署

文件所有权：`src/notification/**`、`src/ai/**`、`src/application/**`。

| 项 | 内容 | 要求 |
|----|------|------|
| NOTIF-002 | sendAll 日志记录 content | 日志只记 channel 类型+长度+截断摘要（脱敏），不记原文 |
| NOTIF-003 | silences 内存 Map | size 上限 + 过期条目定时清理（interval `unref()`），重启丢失在 README/注释注明为可接受降级或持久化到 system_config（二选一，说明理由） |
| AI-002 | suggestSchedule 解析失败静默回退 | 失败时记 warn 日志并在响应中携带 `fallback: true` 标记 |
| APP-001 | webhook 找不到应用返回 200 | 统一返回模糊 404（不区分不存在/已删除，防枚举），带单测 |
| APP-002 | 包 URL fallback localhost | 无 API_BASE_URL 时 fail-fast 或显式告警，不再静默 localhost |

## Stream C — 架构与基础设施 + 死代码

文件所有权：`src/main.ts`、`src/app.module.ts`、`src/config/configuration.ts`、`src/common/constants/app.constants.ts`、`src/common/decorators/skip-timeout.decorator.ts`、疑似重复 controller。

| 项 | 内容 | 要求 |
|----|------|------|
| ARCH-001 | CORS 放行全部私有/LAN | 改为显式 `CORS_ALLOWED_ORIGINS` 白名单（逗号分隔），默认仅 localhost 开发源；LAN 场景走文档说明 |
| ARCH-002 | /uploads 静态无认证 | 加 JWT guard（或一次性签名 token），保留公开下载路由白名单 |
| ARCH-003 | multipart 路由 whitelist 绕过 | 核实并补 DTO 校验 |
| ARCH-004 | 全局 Throttle 宽松 | 收紧默认值并支持 env 覆盖 |
| ARCH-005 | Redis 无 TLS | `REDIS_TLS` 配置项透传 ioredis |
| ARCH-006 | synchronize 依赖 NODE_ENV | 显式 `DB_SYNCHRONIZE` env，默认 false，生产强制 false |
| ARCH-007 | Swagger 暴露生产 server URL | 生产禁用 swagger 或去 server 列表 |
| ARCH-008 | unhandledRejection 直接 exit(1) | 先 log + 触发 graceful shutdown（带超时兜底 exit） |
| 死代码 | app.constants.ts / skip-timeout.decorator.ts / 重复 controller | 先 grep 引用再删；有引用则迁移后删 |

## Stream D — 数据库实体与迁移

文件所有权：`src/entities/**`（除 task.entity）、`src/migrations/**`、日志 TTL 清理新服务。

| 项 | 内容 | 要求 |
|----|------|------|
| DB-002 | execution_log_lines 无 TTL | 新增保留期清理（配置 `LOG_RETENTION_DAYS`，默认 30；分批 DELETE 防长事务；每日 cron，timer unref） |
| DB-004 | ApplicationVersion 缺唯一索引 | `(applicationId, version)` 唯一索引 + 迁移（先查重 SQL 注释） |
| DB-005 | 迁移时间戳重复 1717473142685 | 重命名其一（含类名），保证顺序语义不变 |
| DB-006 | username 无长度限制 | entity `@Length(3,128)` + 迁移 |
| DB-007 | system_config.value 无长度 | 明确 varchar 长度 + 迁移 |

## 状态板

| Stream | 状态 | 结果 |
|--------|------|------|
| A | ✅ 已验收 | Leader Election（scheduler:leader TTL 30s + 续约 + fail-open）+ claimTaskTrigger 条件 UPDATE；stale 恢复分批 RETURNING；TASK-007 深度 64；TASK-008 SSE 4/64 两级上限 503；DB-001 软删除迁移 …2700（TIMESTAMP 与既有列一致，负责人认可）；DB-003 getManyAndCount+PK-IN。commit `8bb3790` |
| B | ✅ 已验收 | NOTIF-002 净化后截断 80；NOTIF-003 上限 1000 + 60s unref 清理（重启丢失注释为可接受）；AI-002 fallback 标记；APP-001 统一 401（比要求的 404 更严，防枚举等效）；APP-002 fail-fast 500。commit `7851ebd` |
| C | ✅ 已验收 | ARCH-001..008 全落地（CORS 白名单 / /uploads 鉴权 / 限流 60min / REDIS_TLS / DB_SYNCHRONIZE / swagger 生产关 / unhandledRejection 优雅退出）；死代码 4 处删除（含 error-codes.ts 由集成补删）。commit `723efbf` |
| D | ✅ 已验收 | DB-002 日志保留服务（03:30 cron，LOG_RETENTION_DAYS=30，分批 ≤5000）；DB-004 唯一索引；DB-005 迁移重命名 2685→2694（幂等 up/down）；DB-006 varchar(128)+@Length；DB-007 显式 text；migrations.spec 时间戳唯一性守卫。commit `b1fbbef` |
| 集成 | ✅ | 4 处 seam 负责人修复：upload DTO（ARCH-003）、suggestSchedule fallback 透传、executor-node 下载带 Bearer + 跨主机重定向剥离 token、删 error-codes.ts。全量回归 admin-api **518/518（37 suites）** + tsc ✓；executor-node **79/79** + tsc ✓ |
| 提交 | ✅ | `8bb3790` A / `7851ebd` B / `723efbf` C / `b1fbbef` D / `eadedca` executor-node / `295e3b1` 文档验收修复 / docs 收尾 |
| 文档验收 | ✅ | docs agent 重写 api-reference.md（12 处）+ optimization-notes.md 追加第三轮清单；其上报 2 个代码 bug 均属实并已修复（`295e3b1`：sse 配置节注册使 env 覆盖生效、CreateExecutorPackageDto 去除服务端推导字段）；修复后全量回归 518/518 + tsc ✓ |

## 遗留风险（写入 AGENT_HANDOFF 供下轮）

- trigger 锁 TTL 仍为 max(taskTimeout, minInterval)，回调不主动释放（Leader 化后重复触发风险已大幅降低）
- 非 Leader 节点不跑 BullMQ 之外的 scheduleOne 延迟 ≤1 个 tick（可接受）
- SSE 并发计数是进程内的：多实例部署实际上限 = 实例数 × 64
- DB-005 重命名导致该迁移在已有环境重跑一次（幂等，安全）；DB-002 唯一索引迁移会重写 application_version 表，建议维护窗口
- **/uploads 鉴权是本轮最大破坏性变更**：旧版 executor-node 下载包会 401，需与 executor-node ≥ eadedca 配套升级
