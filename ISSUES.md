# AutoFlow 问题记录与修复追踪

> 参考项目：[xxl-job](../xxl-job)，对照分析后整理的问题清单。
> 每修复一项，在状态栏更新。

---

## 优先级说明

- 🔴 高优先级 — 功能 bug 或运行时错误，影响核心流程
- 🟡 中优先级 — 逻辑缺陷，不立即崩溃但行为不正确
- 🟢 低优先级 — 改进项，可按需安排

---

## 问题清单

### 已修复（Phase 8–10）

| ID | 优先级 | 描述 | 状态 |
|----|--------|------|------|
| S1 | 🔴 | jwt.strategy 缺少 isActive 检查，被禁用账号 JWT 仍可通行 | ✅ 已修复 |
| S2 | 🔴 | access/refresh token 无 type 字段区分，可互相冒用 | ✅ 已修复 |
| S3 | 🟡 | admin-web 用 localStorage 存 token，XSS 可窃取 | ✅ 已修复（改 sessionStorage）|
| S4 | 🔴 | 生产环境 JWT_SECRET 缺失时无 fail-fast | ✅ 已修复 |
| S5 | 🔴 | executor 路由无认证，任意客户端可伪造心跳/执行 | ✅ 已修复 |
| S6 | 🔴 | 任务工作目录路径遍历 + 权限无隔离 | ✅ 已修复 |
| S7 | 🔴 | gitRepo 字段无 scheme 白名单，可 SSRF | ✅ 已修复 |
| S8 | 🔴 | docker-compose.yml 密码硬编码 | ✅ 已修复 |
| S9 | 🔴 | registry-pypi 包索引/下载无认证 | ✅ 已修复 |
| S10 | 🟡 | CORS origin 为 *，与 credentials 同时使用 | ✅ 已修复 |
| S11 | 🔴 | users 接口无 RBAC，普通用户可删除任意账号 | ✅ 已修复 |
| S12 | 🔴 | 修改密码不验证旧密码 | ✅ 已修复 |
| S13 | 🟡 | config 接口返回 secret 字段明文 | ✅ 已修复 |
| S14 | 🔴 | executor register/heartbeat 无 token 校验 | ✅ 已修复 |
| S15 | 🟡 | login 接口无限速，暴力破解风险 | ✅ 已修复（ThrottlerModule）|
| S16 | 🔴 | npm install 包名未校验，可命令注入 | ✅ 已修复 |
| Q1 | 🔴 | task.processor catch 不 rethrow，BullMQ 无法重试 | ✅ 已修复 |
| Q2 | 🟡 | executor dispatch 并发时负载均衡失效 | ✅ 已修复（乐观递增）|
| Q3 | 🟡 | 僵尸任务检测阈值固定 15min，与任务实际 timeout 无关 | ✅ 已修复 |
| Q4 | 🟡 | AI service 无 HTTP timeout，阻塞 BullMQ worker | ✅ 已修复 |
| Q5 | 🟡 | email channel 未接入 nodemailer | ✅ 已修复 |
| Q6 | 🔴 | 无 TypeORM Migration 文件，生产环境无法建表 | ✅ 已修复 |
| Q7 | 🟡 | 历史 execution / audit_log 无清理策略，DB 无限膨胀 | ✅ 已修复 |
| Q8 | 🟡 | auth login/logout 未接入 AuditService | ✅ 已修复 |
| Q9 | 🟡 | dingtalk/wecom/slack webhook 无 timeout | ✅ 已修复 |
| Q10 | 🟡 | SDK 与 executor 无共享 schema | ✅ 已修复 |
| Q11 | 🔴 | 任务工作目录无权限隔离（与 S6 合并）| ✅ 已修复 |
| Q12 | 🟡 | audit.service findAll 无分页上限，可全表扫描 | ✅ 已修复 |
| M1 | 🟢 | 缺少核心链路单元测试 | ✅ 已修复 |
| M2 | 🟢 | 两份 docker-compose.yml 职责不清 | ✅ 已修复 |
| M3 | 🟡 | 关键配置缺少 fail-fast 校验 | ✅ 已修复 |

---

## 新发现问题（本次审查，2026-06-04）

### N1 🔴 executor-python/main.py 引用了未导入的 `logs` 模块

**文件**：`apps/executor-python/main.py` 第 69 行
**问题**：`app.include_router(logs.router, prefix='/api')` 使用了 `logs`，但文件顶部只导入了 `execute` 和 `health`，没有 `from routers import logs`。服务启动时立即抛 `NameError: name 'logs' is not defined`，executor-python 完全无法启动。
**修复**：在导入区加上 `from routers import logs`。

---

### N2 🔴 executor-python/routers/execute.py 重复定义 `ExecuteRequest` 覆盖 SDK 版本

**文件**：`apps/executor-python/routers/execute.py` 第 14–24 行 & 第 58–62 行
**问题**：文件先通过 try/except 从 SDK 导入 `ExecuteRequest`（含 fallback），然后在第 58 行又无条件 `class ExecuteRequest(BaseModel)` 重新定义，覆盖前者。实际使用的是局部版本，SDK 版本形同虚设，且局部版本缺少 `TaskConfig` 嵌套校验。
**修复**：删除第 58–62 行的重复定义，统一使用 SDK 导入版本。

---

### N3 🔴 executor-python 超时时日志流协程未正确取消，资源泄漏

**文件**：`apps/executor-python/routers/execute.py` 第 193–206 行
**问题**：`await asyncio.wait_for(_stream_to_file(), timeout=timeout)` 超时后调用了 `proc.kill()`，但 `_stream_to_file` 协程任务未被显式 cancel，会导致 asyncio 发出 `Task was destroyed but it is pending` 警告并泄漏文件句柄。
**修复**：将 stream 任务显式创建为 `asyncio.Task`，超时时先 kill 进程再 `task.cancel()`。

---

### N4 🔴 executor-node logs 路由对 executionId 未做 basename 过滤

**文件**：`apps/executor-node/src/routes/logs.ts` 第 25–32 行
**问题**：`executionId` 来自 URL 路径参数，直接拼入 `path.resolve(workDir, executionId + '.log')`，未先做 `path.basename`。虽有 `startsWith(base)` 校验，但含 null byte 的输入在部分 Node 版本会截断路径，绕过校验。
**修复**：使用前先过滤：`const safeId = path.basename(executionId); if (safeId !== executionId) { reject 400; }`

---

### N5 🔴 两个 Migration 文件重复建同名表，生产启动报错

**文件**：`apps/admin-api/src/migrations/1700000000000-InitialSchema.ts` 和 `1717473142678-InitialSchema.ts`
**问题**：两份 migration 均创建 `users`、`tasks`、`task_executions`、`audit_logs`、`system_configs` 等表和 enum。TypeORM 按时间戳顺序执行，旧版（1700000000000）用 `IF NOT EXISTS`，新版（1717473142678）不用，执行新版时 CREATE TABLE 报已存在，migration 链失败，应用无法启动。
**修复**：删除旧版 `1700000000000-InitialSchema.ts`（已被 1717473142678 完整取代）。

---

### N6 🟡 `task_executions.taskId` 在新版 Migration 中为 VARCHAR，无外键无索引

**文件**：`apps/admin-api/src/migrations/1717473142678-InitialSchema.ts` 第 66 行
**问题**：`taskId VARCHAR NOT NULL`——无外键约束（旧版有 `REFERENCES tasks(id) ON DELETE CASCADE`），无索引。导致：①执行记录可指向不存在的 task；② `getExecutions(taskId)` 全表扫描。
**修复**：补加外键和索引（在新 migration 中）。

---

### N7 🟡 scheduler 分布式锁依赖 Bull 队列私有 `.client` 属性

**文件**：`apps/admin-api/src/modules/scheduler/scheduler.service.ts` 第 92 行
**问题**：`const client = await (this.queue as any).client` 通过强制类型转换访问私有属性。Bull 与 BullMQ 此属性命名不同，升级时静默失效，导致分布式锁失效、多实例重复触发任务。
**修复**：使用独立的 ioredis 连接或 `redlock` 库实现分布式锁。

---

### N8 🟡 cron 闭包捕获 stale task 快照，update 后最多 1 分钟行为不一致

**文件**：`apps/admin-api/src/modules/scheduler/scheduler.service.ts` 第 82 行
**问题**：`nodeCron.schedule(t.cronExpression, () => this.enqueue(t, 'cron'))` 闭包捕获了查询时的 `t` 快照。若后续 `update()` 修改了 `maxRetry`、`timeout` 等字段，已注册的 cron 仍引用旧对象，最多 1 分钟内行为不一致。
**修复**：闭包中按 taskId 重新查询最新 task：`const latest = await this.taskRepo.findOne({ where: { id: t.id } }); if (latest) await this.enqueue(latest, 'cron');`

---

### N9 🟡 task.processor 直接读 `process.env` 而非 ConfigService

**文件**：`apps/admin-api/src/modules/task/task.processor.ts` 第 33 行
**问题**：`const token = process.env.EXECUTOR_SHARED_TOKEN || ''` 直接读环境变量，与项目其他地方通过 `ConfigService` 读取不一致。若配置通过 Vault/k8s Secret 方式注入（只更新 ConfigService 不更新 process.env），此处静默发送无认证头，拉取日志时 401。
**修复**：注入 `ConfigService`，使用 `this.configService.get('executor.sharedToken')`。

---

### N10 🟡 `getExecutionLogs` 使用字符串表名访问 repository，返回 `any` 类型

**文件**：`apps/admin-api/src/modules/task/task.service.ts` 第 102 行
**问题**：`this.dataSource.getRepository('execution_log_lines')` 返回 `Repository<unknown>`，字段取值需要 `r.l_content ?? r.content` 兼容逻辑，脆弱易出错。
**修复**：注入类型化的 `@InjectRepository(ExecutionLogLine) private logLineRepo` 并直接使用。

---

### N11 🟡 rollback 后未重新调度，cron/fixed_rate 任务仍用旧 commit

**文件**：`apps/admin-api/src/modules/task/task.service.ts` 第 116–139 行
**问题**：`rollback()` 在事务里更新了 `task.gitCommit`，但没有调用 `schedulerService.scheduleOne(task)`（而 `update()` 会调用）。下次自动触发仍用旧 commit 的 task 快照。
**修复**：rollback 完成后，若任务状态为 ACTIVE，调用 `await this.schedulerService.scheduleOne(task)`。

---

### N12 🟡 僵尸任务检测 15min 硬编码阈值，与 PROGRESS.md 声称的 per-execution 修复不符

**文件**：`apps/admin-api/src/modules/executor/executor.service.ts` 第 85–103 行
**问题**：PROGRESS.md 声称 Q3 已按 per-execution 使用 `taskTimeout+5min` 修复，但实际代码 `broadThreshold = 15 * 60 * 1000` 硬编码，内层 for 循环也没有从 taskRepo 查询实际 timeout 做二次判断。任务 timeout 配置为 30min 时，15min 后会被错误标记为 FAILED。
**修复**：内层循环查询关联 task 的 timeout 字段，以 `task.timeout * 1000 + 5 * 60 * 1000` 作为该 execution 的判定阈值。

---

### N13 🟡 ValidationPipe `forbidNonWhitelisted: false`，额外字段静默丢弃

**文件**：`apps/admin-api/src/main.ts` 第 41 行
**问题**：与 `whitelist: true` 组合时，额外字段只被丢弃不会返回 400，调用方字段拼写错误时静默失效，调试困难。
**修复**：改为 `forbidNonWhitelisted: true`。

---

### N14 🟡 registry-pypi 上传接口 filename 未过滤路径遍历

**文件**：`apps/registry-pypi/main.py` 第 106 行
**问题**：`filename = content.filename` 直接使用，虽有扩展名白名单，但未做 `Path(filename).name` 过滤。`filename` 为 `../../evil.whl` 时会写入包目录之外（download 端点已做过滤，upload 遗漏）。
**修复**：`filename = Path(content.filename).name`

---

### N15 🟡 executor `runningTaskCount` 乐观递增后成功完成不回滚，30s 内统计失真

**文件**：`apps/admin-api/src/modules/executor/executor.service.ts` 第 65–77 行
**问题**：dispatch 成功后 admin-api 递增 `runningTaskCount`，但任务完成时（无论成功/失败）admin-api 没有代码将其递减。实际计数依赖执行器每 30s 心跳上报，高并发时调度器会误认为执行器满载。
**修复**：在 task.processor.ts 的 finally 块中通过 executor address 递减计数；或完全依赖心跳上报，去掉 admin-api 侧的主动递增。

---

### N16 🟢 login 路由未单独设置更严格的限速

**文件**：`apps/admin-api/src/app.module.ts` / `auth.controller.ts`
**问题**：ThrottlerModule 仅有全局默认配置（10req/60s），login 路由没有 `@Throttle()` 单独收紧。全局限速过宽会影响正常 API，login 理应更严格（建议 5req/60s）。
**修复**：在 `AuthController.login` 上加 `@Throttle({ default: { limit: 5, ttl: 60000 } })`。

---

### N17 🟢 `.env.example` 缺少 `JWT_REFRESH_SECRET` 和 `CORS_ORIGINS`

**文件**：`.env.example`
**问题**：`configuration.ts` 生产环境校验 `JWT_REFRESH_SECRET`（缺失时 fail-fast），`main.ts` 读取 `CORS_ORIGINS`，但 `.env.example` 均未列出，新部署者无从得知，生产部署直接报错。
**修复**：补充到 `.env.example`：
```
JWT_REFRESH_SECRET=change-me-refresh-at-least-32-chars
CORS_ORIGINS=http://localhost,http://localhost:5173
```

---

### N18 🟢 executor-node npm install 使用 `execSync` + `shell: false as any`，类型欺骗

**文件**：`apps/executor-node/src/routes/execute.ts` 第 121–126 行
**问题**：手动将参数数组 join 成字符串再调 `execSync(..., { shell: false as any })`。`execSync` 不支持 `shell: false` 选项（该选项属于 `spawnSync`），`as any` 是类型欺骗，实际该选项被忽略，命令通过 shell 执行，前面的包名校验防护可能失效。
**修复**：改用 `spawnSync('npm', ['install', '--prefix', nodeModulesDir, ...requirements], { stdio: 'pipe', timeout: 300_000 })`。

---

### N19 🟢 `packages/autoflow-http/db/notify/ai` 目录为空占位，与文档描述不符

**文件**：`packages/` 下除 `autoflow-sdk` 外的四个目录
**问题**：PROGRESS.md 目录结构列出了 `autoflow-http`、`autoflow-db`、`autoflow-notify`、`autoflow-ai` 四个包，但实际均为空目录。若有代码引用这些包会静默 fallback 或报 ImportError。
**修复**：实现这些包的内容，或删除空目录并更新文档。

---

## 新问题汇总状态表

| ID | 优先级 | 状态 | 一句话描述 |
|----|--------|------|------------|
| N1 | 🔴 | ✅ 已修复 | executor-python 启动崩溃：logs 模块未导入 |
| N2 | 🔴 | ✅ 已修复 | execute.py 重复定义 ExecuteRequest，SDK 版本被覆盖 |
| N3 | 🔴 | ✅ 已修复 | Python 超时时日志流协程未正确取消，资源泄漏 |
| N4 | 🔴 | ✅ 已修复 | executor-node logs 路由 executionId 未做 basename 过滤 |
| N5 | 🔴 | ✅ 已修复 | 两个 Migration 文件重复建表，生产启动报错 |
| N6 | 🟡 | ✅ 已修复 | task_executions.taskId 无外键约束和索引 |
| N7 | 🟡 | ✅ 已修复 | scheduler 分布式锁依赖 Bull 私有 API，升级即失效 |
| N8 | 🟡 | ✅ 已修复 | cron 闭包捕获 stale task 快照，更新后最多 1min 不一致 |
| N9 | 🟡 | ✅ 已修复 | task.processor 直接读 process.env 而非 ConfigService |
| N10 | 🟡 | ✅ 已修复 | getExecutionLogs 用字符串表名，返回 any 类型 |
| N11 | 🟡 | ✅ 已修复 | rollback 后未重新调度，cron 任务仍用旧 commit |
| N12 | 🟡 | ✅ 已修复 | 僵尸任务检测 15min 硬编码，长 timeout 任务被误杀 |
| N13 | 🟡 | ✅ 已修复 | ValidationPipe forbidNonWhitelisted=false，额外字段静默丢弃 |
| N14 | 🟡 | ✅ 已修复 | PyPI registry 上传接口未过滤 filename 路径遍历 |
| N15 | 🟡 | ✅ 已修复 | executor runningTaskCount 只增不减，30s 内负载统计失真 |
| N16 | 🟢 | ✅ 已修复 | login 路由未单独限速，依赖全局 throttler |
| N17 | 🟢 | ✅ 已修复 | .env.example 缺少 JWT_REFRESH_SECRET 和 CORS_ORIGINS |
| N18 | 🟢 | ✅ 已修复 | executor-node npm install 使用 execSync+shell 类型欺骗 |
| N19 | 🟢 | ✅ N/A | autoflow-http/db/notify/ai 包目录为空占位（当前代码库中不存在该目录）|
