# admin-api 深度审查（2026-09-14 @ 0ef3bbe）

- 审查对象：`apps/admin-api`（NestJS 后端）及其与 `packages/autocodeflow-db`、`autocodeflow-http`、`autocodeflow-ai`、`autocodeflow-notify` 的集成边界
- 基线：分支 `develop`，HEAD `0ef3bbe`，工作区干净
- 审查方式：逐文件人工阅读 + 系统性 grep；所有结论均附 `文件:行号` 与代码摘录；未运行 npm install/build/test，未修改任何现有文件
- 与既有评审的关系：`docs/REVIEW_MASTER.md`（2025-07，39 条）与 `docs/DEEP_REVIEW_73935fe.md`（7 条 DR）已通读。本报告独立验证其修复状态（DR-01 已修、DR-03 已修、DR-07 已修；**H-3 只修了一半**，见 R-04），其余发现均为新问题或既有问题的残留面

---

## 一、全景与方法

### 1.1 代码规模

| 指标 | 数值 |
|---|---|
| admin-api src 下 TS 文件（非 spec） | 276 |
| spec 文件 | 157 |
| 非 spec 源码行数 | ~42,100 |
| modules 子模块 | 20 个：ai / api-keys / application / artifacts / audit / auth / config / event-subscriptions / executor / executor-package / health / metrics / notification / project / registry / runtime / scheduler / task / task-template / users |
| 最大文件（God class 候选） | app-deployment.service.ts 2505 行、task.service.ts 2366 行、executor.service.ts 2250 行、scheduler.service.ts 1238 行、executor.controller.ts 1013 行、task.controller.ts 955 行 |

### 1.2 实际通读/抽读的文件（证据基础）

- **入口/配置**：`main.ts`（全）、`app.module.ts`（全）、`config/configuration.ts`（全，610 行）、`config/env.ts`、`config/throttle-profiles.ts`（引用面核对）
- **common**：`jwt-auth.guard.ts`、`roles.guard.ts`、`timeout.interceptor.ts`、`response.interceptor.ts`、`http-exception.filter.ts`、`upload-auth.middleware.ts`、`leader-gate.service.ts`（全）、`redis-lock.service.ts`（全）、`domain-event-bus.service.ts`（全）、`secret-crypto.util.service.ts` + `maskSecretsObject` 实现、`pagination.dto.ts`
- **auth/users/api-keys**：`auth.service.ts`（全）、`auth.controller.ts`（全）、`jwt.strategy.ts`、`oidc.controller.ts`（grep 面）、`users.service.ts`（全）、`users.controller.ts`（全）、`user.entity.ts`、`update-user.dto.ts`、`api-key-auth.helper.ts`（全）、`api-key-scope.util.ts`（全）
- **task**：`task.service.ts`（全 2366 行）、`task.controller.ts`（全 955 行）、`task.processor.ts`（全）、`execution-callback.controller.ts`（全）、`task-execution.entity.ts`、`execution-log-line.entity.ts`、`batch-task.dto.ts`、`task-batch.controller.spec.ts`（节选）、`log-retention-cleanup.service.ts`（节选）
- **scheduler**：`scheduler.service.ts`（全 1238 行）
- **executor**：`executor.service.ts`（全 2250 行）、`executor.controller.ts`（路由鉴权面全查 + 关键段全文）、`executor-metrics-history.entity.ts`
- **application**：`application.service.ts`（全 750 行）、`app-deployment.service.ts`（结构全查 + deploy/push/审批/probe/rollout/destroy 关键段约 900 行）
- **其余**：`ai.service.ts`（全）、`outbox-dispatcher.service.ts`（全 509 行）、`event-subscription.service.ts` / `outbound-event-dispatcher.service.ts`（SSRF 面）、`artifacts.controller.ts`（全）、`project-access.service.ts`（前 120 行）、`executor-package.service.ts`（URL/上传段）、`config.service.ts` / `config.controller.ts`（掩码面）、`metrics.controller.ts`、`health.controller.ts`、`registry.service/controller`（凭据面）、`notification.service` / `notification-config.service`（grep 面）、audit 实体与服务（索引与查询面）
- **migrations**：索引/外键相关 6 个迁移文件核对

### 1.3 系统性 grep 结果摘要

| 模式 | 结果 |
|---|---|
| `TODO/FIXME/HACK/XXX` | 业务代码 **0 条**（唯一命中为 install-script 内临时目录名，误报）——代码卫生极好 |
| `as any` | 非 spec 共 **14 处**，多为边界型（`(req as any)`、`(client as any).set`、`app-deployment.service.ts:1298 (app as any).packageUrl`），无一危险 |
| 空 catch `catch {` | 非 spec 约 56 处，绝大多数有注释说明 fail-open 语义；未见吞掉关键错误的裸 catch |
| `console.*` | 8 处：main.ts FATAL 路径、configuration.ts 启动告警、**oidc.controller.ts:61/118（违规，应用 Logger）** |
| `@Cron` | 11 个任务，**全部**有 LeaderGate 或 scheduler-isLeader 门禁（ARCH-31 落地完整） |
| `describe.skip/it.skip` | **0 条**；约 2506 个 `it(` |
| 原始 SQL | 2 处（outbox CTE claim、scheduler recover 的 RETURNING 更新），均参数化，无注入面 |
| setInterval/setTimeout | 32 处；leader/watchdog/outbox/silence 等均有 unref + destroy 清理，未发现泄漏型定时器 |
| env 注册完整性 | configuration.ts 读取但未在 Joi 注册：`METRICS_STREAM_*`（3 键）、`EXECUTIONS_STREAM_IDLE_PING_MS`；完全绕过配置中心的读取：`ADMIN_API_URL`（2 处）、`NPM_REGISTRY_URL`（1 处）→ R-12 |

---

## 二、发现清单

> 分级：P0=数据损坏/核心功能损坏；P1=权限边界/重要功能失效；P2=特定条件下的正确性/安全/性能问题；P3=打磨项。
> 每条含：位置、证据（≤5 行）、影响、修复建议、工作量（S<0.5d / M<2d / L>2d）。

---

### 【P0】

#### R-01【Bug】任务 PATCH 未携带 secrets 时，脱敏副本被写回数据库，任务密钥被永久破坏

- **类别**：Bug（数据损坏）
- **位置**：`apps/admin-api/src/modules/task/task.service.ts:533-541`（findOne 脱敏）+ `:544-577`（update 消费脱敏实体）
- **证据**：
  ```ts
  // findOne() L539：t.secrets = this.secretsCrypto.maskForResponse(t.secrets)
  async update(id, dto, user) {
    const t = await this.findOne(id);            // ← t.secrets 已是 {"KEY":"******"}
    ...
    if (normalized.secrets !== undefined) { ... } // 仅当本次 PATCH 带 secrets
    delete normalized.secrets;                    // 未带时是 no-op
    const updated = Object.assign(t, normalized); // t.secrets 仍是掩码副本
    const saved = await this.taskRepo.save(updated); // ← 掩码值整体写回
  ```
- **影响**：任何**不携带 `secrets` 字段**的 PATCH（改名/改 cron/改超时……）都会把库中密文（或明文）整体覆盖为 `{"KEY":"******"}`。此后 dispatch 注入的是字面量 `******`（`executor.service.buildDispatchParams` 解密时非 `enc:v1:` 信封按普通值透传），任务凭据**不可逆丢失**且任务开始批量认证失败。对照 `application.service.update`（L363-386）团队明确知道该陷阱并专门用 `findByIdRaw` 规避（"saving a masked entity back would persist '***' over the real secret env values"），task 侧漏掉了同型修复。
- **修复建议**：`update()` 改用 `findByIdRaw`（或保存前恢复原始 secrets 列）；回归测试：PATCH 不带 secrets → 库中密文逐字节不变；PATCH 带 secrets → 新值生效。
- **工作量**：S（+测试 M）
- **旁证**：`task.service.spec.ts` 中 secrets 加密服务为降级桩，`grep secrets task.service.spec.ts` 仅 1 行注释——该路径零测试覆盖。

---

### 【P1】

#### R-02【Bug】`POST /tasks/batch/delete` 对所有人恒 403——批量删除完全失效，且测试把缺陷固化

- **类别**：Bug（功能失效）
- **位置**：`apps/admin-api/src/modules/task/task.controller.ts:303-324`；`task.service.ts:305-318,596-599`
- **证据**：
  ```ts
  // controller: 结果 = Promise.all(body.taskIds.map((id) =>
  //   this.taskService.remove(id).catch(...)))          ← user 未传
  // service: async remove(id, user?) { ... await this.assertCanWriteProjectAware(t, user); }
  assertCanWrite(row, user) {
    if (user?.role === UserRole.ADMIN) return;   // undefined ≠ admin
    if (row.ownerUserId === null) throw 403;     // 无主行也 403
    if (row.ownerUserId !== user?.id) throw 403; // number !== undefined 恒 true
  ```
- **影响**：NF-03 落地后所有新建任务都有 `ownerUserId`，`batchDelete` 的每个条目必然 403（错误被 `.catch` 吞成 `{id, error}`，HTTP 仍 200）。管理员和属主都无法批量删除。单条 `DELETE /tasks/:id` 正常传 user（L506），只有批量路径漏了。
- **修复建议**：`this.taskService.remove(id, user)`；同时把 `task-batch.controller.spec.ts:121-122` 的断言改为 `toHaveBeenCalledWith("t1", adminUser)`（当前断言 `toHaveBeenCalledWith("t1")` 恰好固化了缺陷）。
- **工作量**：S

#### R-03【安全】任务写面归属守卫缺口：任意登录用户可改任意任务的 GLUE 源码 / gitCommit / 版本回滚

- **类别**：安全（授权缺失，RBAC 覆盖不全）
- **位置**：`apps/admin-api/src/modules/task/task.controller.ts:455-491`（updateGlue）、`:740-777`（rollback）、`:779-807`（rollbackToVersion）；`task.service.ts:587-594, 1248-1314, 2167-2181`
- **证据**：
  ```ts
  // PUT /tasks/:id/glue → taskService.updateGlue(id, body.source, body.language)
  async updateGlue(id, source, language?) {   // ← 无 assertCanWrite / assertCanOperate
    const t = await this.findOne(id);
    t.glueSource = source; ...
  }
  // POST /tasks/:id/rollback → taskService.rollback(id, dto)   ← 同样无守卫
  ```
- **影响**：NF-03/AUTH-02 把 `update`/`remove` 收紧到「ADMIN 或属主（或项目 editor）」，`trigger/pause/resume` 收紧到「viewer 拒绝」（ADR-013）。但 **updateGlue（等价于改写任务执行的代码）、rollback（改写 gitCommit 并触发执行）、rollbackToVersion（整体覆盖任务配置）** 三个配置/代码写面完全绕过守卫——任意普通用户（含项目 viewer）可篡改他人任务的执行代码与配置。守卫在相邻端点上做了、在这三个端点上没做，属模型内不一致而非产品决策（ADR-013 明确「明确保留的缺口」仅限 trigger/pause/resume）。
- **修复建议**：三处 service 方法补 `assertCanWriteProjectAware`（rollback 另加 `assertCanOperate` 传 user），controller 透传 `user`；补 RBAC 矩阵测试。
- **工作量**：S（+测试 M）

#### R-04【Bug】已删除用户的有效 JWT 请求返回 404 而非 401——H-3 只修了一半

- **类别**：Bug（错误处理）/ 安全（用户存在性泄漏）
- **位置**：`apps/admin-api/src/modules/auth/strategies/jwt.strategy.ts`（validate 内）；`modules/users/users.service.ts:140-144`；`modules/auth/auth.service.ts:293-294`
- **证据**：
  ```ts
  // users.service.findById:
  const user = await this.usersRepository.findOne({ where: { id } });
  if (!user) throw new NotFoundException(`User #${id} not found`);  // ← 恒抛
  // jwt.strategy.validate:
  const user = await this.usersService.findById(payload.sub);
  if (!user) throw new UnauthorizedException("User not found");      // ← 死代码
  ```
- **影响**：`findByIdOrNull`（H-3 修复）已存在，但 jwt.strategy 与 `refreshToken()` 仍用会抛 404 的 `findById`。已删除用户持旧 access token 访问任意接口 → 全局过滤器渲染 **404 "User #N not found"**（泄漏该用户曾存在 + 泄漏数字 id），而非 401；`refreshToken` 同型。REVIEW_MASTER H-3 声称已修，实际只新增了辅助方法、调用点未换。
- **修复建议**：strategy/refresh 路径改用 `findByIdOrNull`，null → `UnauthorizedException`。
- **工作量**：S

#### R-05【Bug】TOTP 登录路径缺 `clearExpiredLock`——锁过期后一次失败立即重锁 15 分钟（R10 缺陷在 TOTP 分支复活）

- **类别**：Bug（边界条件/状态机）
- **位置**：`apps/admin-api/src/modules/auth/auth.service.ts:132-184`（totpVerifyLogin）；对照 `:83-85`（login 已修）
- **证据**：
  ```ts
  // login()：if (user && user.lockedUntil) { await this.usersService.clearExpiredLock(user.id); }
  // totpVerifyLogin()：检查 lockedUntil > now 后直接进入 bcrypt —— 没有对应的 clearExpiredLock
  ... if (!check.valid) { await this.usersService.recordLoginFailure(...) } // failCount 仍 = MAX_FAIL
  ```
- **影响**：TOTP 用户锁窗过期后 `loginFailCount` 仍停留在 5；第一次验码失败 `recordLoginFailure` 即跨阈值 → 立即再锁 15 分钟。每次锁过期后只要错一次就再锁，等效永久锁（R10 注释里描述的正是这个，login 修了，`totpVerifyLogin` 漏了）。
- **修复建议**：`totpVerifyLogin` 在锁定检查后补 `clearExpiredLock(user.id)`。
- **工作量**：S

#### R-06【Bug】广播（broadcast）派发从不占坑 `runningTaskCount`，回调却统一释放——执行器容量计数系统性漂移

- **类别**：Bug（并发/计数一致性）
- **位置**：`apps/admin-api/src/modules/executor/executor.service.ts:1379-1530`（dispatchBroadcast 无占坑 UPDATE）vs `:1244-1254`（单播占坑）+ `:281-289`（releaseExecutorSlot）；`task.service.ts:1974-1980`
- **证据**：
  ```ts
  // dispatchBroadcast：Promise.allSettled(candidates.map(async (executor) => { ... axios.post ... }))
  //   —— 全程无 "runningTaskCount + 1" 的占坑 UPDATE（单播 dispatch 有）
  // handleCallback / killExecution：winnerAddress 每个上报执行器都会被
  //   releaseExecutorSlot() → GREATEST("runningTaskCount" - 1, 0)
  ```
- **影响**：广播执行回调时，每个执行器的 `runningTaskCount` 被减 1（从未加过）。该计数是单播派发的容量闸门（`runningTaskCount < max`），心跳周期内（≤30s）虚减会让同执行器超卖并发；虽然执行器心跳会上报真实值纠偏，但「admin 侧 +1/-1」与「执行器上报覆写」两套语义混在同一列上互相打架（BUG-22 修复后单播占坑仍依赖该列）。广播 + 单播混布时容量闸门形同虚设。
- **修复建议**：broadcast 在派发循环里对每个成功接单执行器做同款条件 UPDATE 占坑；或对广播执行打标（如 `result.broadcast=true` 已有），回调释放时跳过非占坑执行器。
- **工作量**：M

---

### 【P2】

#### R-07【安全】灰度健康探针绕过 SSRF 闸：probeDeployment/probeOnce 无 `assertSafeExecutorUrl`，且硬编码 `http://`

- **类别**：安全（SSRF 姿态不一致）
- **位置**：`apps/admin-api/src/modules/application/app-deployment.service.ts:2176-2280`
- **证据**：
  ```ts
  // pushDeployToExecutor（deploy 面）：
  //   this.validateExecutorAddress(...); await assertSafeExecutorUrl(url);   ← 有闸
  // probeDeployment（灰度探针面）：
  const url = this.buildProbeUrl(deployment.executorAddress, hc.port, hc.path);
  ... const ok = await this.probeOnce(url, hc.timeoutMs);   // ← 无任何校验
  return `http://${hostPart}${finalPort ? ... }`            // ← 强制 http
  ```
- **影响**：探针目标是「执行器可控地址 + manifest 可控端口/路径」，结果（成功/失败）驱动批次晋升或回滚，构成对内网 `host:port` 的盲探 oracle。deploy 面已有完整闸（R8），探针面在同一文件内没跟上同一策略；对 `EXECUTOR_ALLOW_PRIVATE_NETWORK=false` 的部署形成了绕过面。可利用性受「探针目标必须是 RUNNING 部署的 executorAddress（deploy 时已过闸）」限制，但端口可被 manifest 指向同主机任意端口。
- **修复建议**：probeDeployment 前置 `assertSafeExecutorUrl`（复用 `notifying` 开关语义），URL scheme 跟随 executorAddress；补 SSRF 拒绝矩阵测试。
- **工作量**：S

#### R-08【安全/性能】`/api/executions/callback` 的 55MB body 解析发生在限流与鉴权之前——未认证内存放大向量

- **类别**：安全（DoS）/ 性能
- **位置**：`apps/admin-api/src/main.ts:86-104`；`modules/task/execution-callback.controller.ts:76-79`
- **证据**：
  ```ts
  app.use("/api/executions/callback",
    express.json({ limit: "55mb",
      verify: (req, _res, buf) => { req.rawBody = Buffer.from(buf); } }));
  // @Throttle(CALLBACK_THROTTLE)（60/min/IP）与 verifyExecutorToken 都在 body 解析之后才生效
  ```
- **影响**：express body-parser 中间件先于 Nest 管线（ThrottlerGuard/@Public 校验）执行。任何未认证客户端可对单一公开路由并发 POST 接近 55MB 的 JSON；每请求同时持有解析对象 + rawBody 副本（`Buffer.from(buf)` 再拷贝一次）。60/min/IP 的限流管不到解析阶段；多源并发下内存尖峰 = 55MB × 并发数 × 2。该豁免是为「100 条 × 512KB 日志」的合法批量回调开的，但缺少同路径的连接级防护。
- **修复建议**：该路由专用中间件先查 `Content-Length` 上限（如 60MB）与每 IP 并发令牌；`verify` 直接引用 buf（`req.rawBody = buf`）避免复制；评估回调分页/压缩替代单批 55MB。
- **工作量**：S

#### R-09【性能】`executor_metrics_history` 无任何保留期清理——每执行器每天 2,880 行，无界增长

- **类别**：性能（无界表增长）
- **位置**：`apps/admin-api/src/modules/executor/executor.service.ts:878-897`（每次心跳 append）；`entities/executor-metrics-history.entity.ts`；全仓 grep 无 delete
- **证据**：
  ```ts
  await this.metricsHistoryRepo.save(this.metricsHistoryRepo.create({
    executorAddress: saved.address, cpuUsage: ..., runningTaskCount: ..., ...
  }));  // heartbeat 每 30s 一行；仓库内不存在对该表的任何 DELETE/retention
  ```
- **影响**：每执行器 30s 一行 ≈ 2880 行/天 ≈ 105 万行/年；读面虽只取 24h 窗口（有 `(executorAddress, createdAt)` 索引），但表体无限膨胀拖慢索引入写、备份与 VACUUM。同类的 `execution_log_lines`（30d）、executions（90d）、audit（180d）、产物、S3 对象都各有 retention cron，唯独这张表漏了。
- **修复建议**：照 `log-retention-cleanup.service` 模式加 `executor_metrics_history` 每日清理（保留 7d 足够，读面只用 24h）。
- **工作量**：S

#### R-10【性能】stale sweep 的 PENDING 清扫无 SQL 级 cutoff/take——全表 PENDING 行拉入内存

- **类别**：性能（无分页全表查询）
- **位置**：`apps/admin-api/src/modules/scheduler/scheduler.service.ts:605-614`
- **证据**：
  ```ts
  // 同函数上方 RUNNING 扫描已用 initialCutoff 限制扫描窗口（Medium-1.2）：
  const runningExecs = await this.execRepo.find({ where: { status: RUNNING, startTime: LessThan(initialCutoff) } });
  // 下方 PENDING 清扫却无任何窗口：
  const stalePending = await this.execRepo.find({ where: { status: ExecutionStatus.PENDING } });
  const stalePendingIds = stalePending.filter((exec) => exec.createdAt && now - exec.createdAt.getTime() > PENDING_GRACE_MS)
  ```
- **影响**：Redis/队列故障恢复期可能堆积数万 PENDING 行（每 10 分钟 sweep 一次把全部行物化进内存再在 JS 里过滤 `createdAt > 10min`）。RUNNING 侧同款问题已被修过（注释自证），PENDING 侧是漏网之鱼。
- **修复建议**：`where: { status: PENDING, createdAt: LessThan(now - PENDING_GRACE_MS) }` 下推 SQL，配 `take` 上限。
- **工作量**：S

#### R-11【Bug】`failRunningExecutionsAfterRestart` 逐行 `save()` 无异常隔离——乐观锁冲突使 register/heartbeat 整体 500

- **类别**：Bug（错误处理/并发）
- **位置**：`apps/admin-api/src/modules/executor/executor.service.ts:439-481`
- **证据**：
  ```ts
  for (const execution of executionsToFail) {
    ...
    await this.execRepo.save(execution);       // TaskExecution 有 @VersionColumn
    await this.releaseExecutorSlot(execution.executorAddress);
    if (task) await this.scheduleRetryAfterRecovery(task, execution);
  }   // ← 循环无 try/catch；调用方 register()/heartbeat() 也无 catch
  ```
- **影响**：执行器重启的瞬间恰有并发回调把某行写为终态（version+1），此处 `save()` 抛 `OptimisticLockVersionMismatchError` → 整个 register/heartbeat 请求 500。心跳连续失败会让该执行器被 `markStaleOffline` 判离线，放大成派发故障。其余恢复路径（sweep/COVER_EARLY/callback）都已改为条件 UPDATE，这里是唯一还用 read-modify-write 的恢复路径。
- **修复建议**：逐行 try/catch（失败行留给 stale sweep 收敛即可）；或改条件 UPDATE `WHERE status='running' AND version=...`。
- **工作量**：S

#### R-12【架构/打磨】配置收口（ARCH-27）自违：5 个 env 绕过注册/映射

- **类别**：架构（配置管理混乱）/ 打磨
- **位置**：
  - `app.module.ts`（Joi schema 缺）：`METRICS_STREAM_MAX_GLOBAL / METRICS_STREAM_INTERVAL_MS / METRICS_STREAM_IDLE_PING_MS`、`EXECUTIONS_STREAM_IDLE_PING_MS`（configuration.ts L92-111 读取）
  - `modules/executor/executor.service.ts:2009` 与 `modules/executor-package/executor-package.service.ts:455`：`configService.get("ADMIN_API_URL")` —— 既未在 configuration.ts 映射也未注册 Joi，靠 ConfigService 的 process.env 回退兜住
  - `modules/registry/registry.service.ts:47`：`config.get("NPM_REGISTRY_URL")`（注释声称"registered as optional ... in the Joi schema"，实际 schema 只有 `NPM_REGISTRY_TOKEN/USER/PASS` 三个键，**URL 未注册**，注释失实）
- **证据**：
  ```ts
  const adminApiUrl = this.configService.get<string>("ADMIN_API_URL") || "";  // 不在配置中心
  // comm 校验：configuration.ts 读取 − Joi 注册 = {METRICS_STREAM_*, EXECUTIONS_STREAM_IDLE_PING_MS, HOSTNAME}
  ```
- **影响**：ARCH-27 自己的规约是「Joi 未注册但被读取的 env 属于审计缺口，发现即补注册」。以上键 typo 时静默取空：install-cmd/push 503（`ADMIN_API_URL`）、metrics-stream 容量回退默认值（无法从 env 调整以外的方式发现拼写错误）。
- **修复建议**：三个键补 Joi + configuration.ts 映射（`app.adminApiUrl` / `registry.npm.url` / metricsStream 节），消费方改读配置节；修正 registry.service 失实注释。
- **工作量**：S

#### R-13【Bug/打磨】task.processor 的 finally 中 `connect()/startTransaction()` 在 try 之外——失败时 queryRunner 泄漏且异常覆盖原始错误

- **类别**：Bug（资源泄漏）/ 打磨
- **位置**：`apps/admin-api/src/modules/task/task.processor.ts:255-353`
- **证据**：
  ```ts
  const queryRunner = this.dataSource.createQueryRunner();
  await queryRunner.connect();            // ← 在 try 外
  await queryRunner.startTransaction();   // ← 在 try 外
  try { ... } catch { ... } finally { await queryRunner.release(); }
  ```
- **影响**：DB 抖动时 `connect/startTransaction` 抛出 → `release()` 永不执行（连接占位泄漏，池上限 20）；且该异常从 `finally` 块内抛出，会**覆盖**外层正在传播的派发失败异常，污染 BullMQ 重试分类（retryableErrors 匹配的是 Database 而非原始错误）。
- **修复建议**：`connect/startTransaction` 挪进 try（或独立 try/catch），任何路径保证 `release()`。
- **工作量**：S

#### R-14【安全/打磨】ADMIN 可删除自己与最后一名管理员，删除不 bump 会话版本

- **类别**：安全（账号生命周期）
- **位置**：`apps/admin-api/src/modules/users/users.controller.ts:144-163`；`users.service.ts:193-197`
- **证据**：
  ```ts
  @Delete(":id") @Roles(UserRole.ADMIN)
  async remove(...) { const result = await this.usersService.remove(id); ... }  // 无自删/末位 admin 校验
  async remove(id) { const user = await this.findById(id); await this.usersRepository.remove(user); }
  ```
- **影响**：唯一管理员可一键删掉自己（后续无人能管理用户，只剩 INITIAL_ADMIN 重灌路径）；被删用户的 refresh_tokens 行成为孤儿（是否 FK 级联**待复核**，见第四节）。对比 logout/update-password 都会 bump sessionVersion，删除路径没有对应收尾。
- **修复建议**：禁止自删与末位 admin 删除（409）；删除前调 `revokeAllForUser`。
- **工作量**：S

#### R-15【性能】`recoverStaleExecutions` 的重试兑现循环串行执行 kill HTTP + 入队

- **类别**：性能（串行可并行化 IO）
- **位置**：`apps/admin-api/src/modules/scheduler/scheduler.service.ts:559-599`
- **证据**：
  ```ts
  for (const row of recoveredRows) {
    await this.releaseExecutorSlot(row.executorAddress);
    ... await this.executorService.notifyExecutorKill(exec.id, exec.executorAddress); // 3s 超时 HTTP
    ... await this.executorService.scheduleRetryAfterRecovery(task, exec, "stale_recovery");
  }
  ```
- **影响**：单轮 sweep 内每行串行一次最多 3s 的 kill HTTP；一次大规模执行器宕机恢复 100 行 → 最多 5 分钟串行阻塞 cron tick（tick 无 watchdog 保护，长 tick 会推迟下一轮 `reload`）。
- **修复建议**：`Promise.allSettled` + 并发上限（p-limit 4~8）；kill HTTP 与 sweep 主链解耦为 fire-and-forget。
- **工作量**：S

#### R-16【Bug/打磨】回调对「尚未派发（executorAddress 为 NULL）」的执行接受任意持有效执行器凭据的上报

- **类别**：Bug（边界条件，标注：部分为既有取舍）
- **位置**：`apps/admin-api/src/modules/task/task.service.ts:1861-1879`
- **证据**：
  ```ts
  if (execution.executorAddress && cb.executorAddress !== execution.executorAddress) { ...reject... }
  // execution.executorAddress 为 null（PENDING，dispatch 尚未落库）时不做归属校验
  ```
- **影响**：派发落库前的秒级窗口内，任何一个持有**自己**执行器有效 token 的执行器可以指定 `executorAddress=自己` 回报一条它从未执行过的执行结果（SUCCESS/FAILED 皆可）。利用前提是持有执行器凭据（信任面内部），风险有限，但与「 dispatched 后必须同源」的防线不一致。
- **修复建议**：`execution.status === PENDING` 时拒绝带地址的回调（尚未派发本不该有回调），或将 address 归属校验扩展为「execution.executorAddress 为 null → 仅允许 dispatch 占坑后的 RETURNING 值」。
- **工作量**：S

---

### 【P3】

#### R-17【打磨】batch 端点限流分域不一致：batch/pause、batch/resume、batch/delete 无 OPS_THROTTLE

- **位置**：`apps/admin-api/src/modules/task/task.controller.ts:212-324`（无 @Throttle）vs `:173,519,739,779,838,867,923`（都有）
- **证据**：SEC-09 分域矩阵将「触发/执行干预写面」归中档 30/min，`batchTrigger` 有 `@Throttle(OPS_THROTTLE)`，三个同级的 batch 写面没有。
- **影响**：全局限流 60/min 兜底仍在，但分域语义漂移。**建议**：补齐三处装饰器。**工作量**：S

#### R-18【打磨】`BatchTaskIdsDto` 无 ArrayMaxSize——批量端点无界并发

- **位置**：`apps/admin-api/src/modules/task/dto/batch-task.dto.ts:9-18`
- **证据**：`@IsArray() @ArrayMinSize(1) @IsUUID("4", { each: true })`——无上限；`batchTrigger` 用 `Promise.all` 并发触发。
- **影响**：一次合法请求可携带数千 uuid → 数千并发事务 + 入队。**建议**：`@ArrayMaxSize(100)`。**工作量**：S

#### R-19【打磨】audit-log 实体声明的 GIN 索引实际不存在

- **位置**：`apps/admin-api/src/modules/audit/entities/audit-log.entity.ts:10-11`
- **证据**：`@Index("idx_audit_log_detail_gin", ["detail"])` + 注释 "GIN index ... for fast containment queries"；全部迁移（含 InitialSchema L144 裸 JSONB 列）均未创建该索引，且 `synchronize=false` 下实体装饰器不物化；查询面（audit.service）也从未使用 `@>`。
- **影响**：注释误导后来者以为有 GIN；若未来开 synchronize 会建成同名 b-tree。**建议**：删除死声明或补 `CREATE INDEX ... USING gin` 迁移（仅在真有 containment 查询时）。**工作量**：S

#### R-20【打磨】task.processor 注入的 `NotificationService`/`AuditService` 已是死依赖

- **位置**：`apps/admin-api/src/modules/task/task.processor.ts:18-19,42,44`
- **证据**：`grep notificationService\. / auditService\.` 在文件内 0 命中（BUG-21 将直调迁出到事件订阅者后遗留）。
- **影响**：维持着 task→notification 的编译期耦合（ARCH-21 红线只要求 task.service 零依赖，processor 仍挂着）。**建议**：删除两个注入与 import。**工作量**：S

#### R-21【打磨】`paginate()` 响应同时返回 `list` 与 `items` 两个等值键

- **位置**：`apps/admin-api/src/modules/task/task.service.ts`（common/dto/pagination.dto.ts:39-50）
- **证据**：`return { list, items: list, total, page, pageSize, totalPages }`。
- **影响**：响应体冗余一倍条目引用，且新旧消费方各取一键，API 契约漂移土壤（`application.service.analyzeHealth:488` 还在 `(result.list || result)` 双兼容）。**建议**：定版单键 + 迁移期弃用告警。**工作量**：M

#### R-22【打磨】auth login Swagger 描述与实际限流漂移

- **位置**：`apps/admin-api/src/modules/auth/auth.controller.ts:97`
- **证据**：`"Max5 attempts per minute."`，实际 `LOGIN_THROTTLE_LIMIT` 默认 20/min（同文件 L70）。
- **建议**：改为动态文案或删除数字。**工作量**：S

#### R-23【打磨】oidc.controller 用 `console.warn` 违反本仓日志纪律

- **位置**：`apps/admin-api/src/modules/auth/oidc.controller.ts:61,118`
- **证据**：`console.warn(`[OIDC] login failed: ${message}`)`——ARCH-27 收口清单之外，其余模块均用 Nest `Logger`（丢失 trace-id 上下文）。
- **建议**：改 `Logger`。**工作量**：S

#### R-24【性能】SSE 日志流空转期每秒 2 条 SQL

- **位置**：`apps/admin-api/src/modules/task/task.service.ts:1121-1235`（POLL_INTERVAL=1000ms，每轮 findOne(exec) + logLineRepo 查询）
- **证据**：全局 64 流 × 每秒 2 查询 ≈ 128 qps 常态底噪，与执行是否活跃无关。
- **影响**：QA-05 已实测瓶颈在 DB 连接池（waiting 280），空转查询加剧排队。**建议**：RUNNING 前 10s 内 1s 间隔，之后退避至 3~5s；或 idle 时仅查 `status` 轻列。**工作量**：M

#### R-25【安全/打磨】`/api/health`（@Public）暴露执行器在线数、队列深度、scheduler 统计

- **位置**：`apps/admin-api/src/modules/health/health.controller.ts:11-16,61-131`
- **证据**：`@Public() @Get()` 返回 "detailed health status and metrics"（db/redis/queue/executors/scheduler 五组件详情）。
- **影响**：未认证方可探测集群规模与队列水位（部署面信息枚举）。LB 探活只需 live/ready。**建议**：detail 端点收进 JWT 或只返回 {status}。**工作量**：S

#### R-26【架构】`@Optional + fail-open` DI 模式泛滥，静默降级不可观测

- **位置**：典型：`task.service.ts:273-294`（eventBus/tracing/reportRepo/projectAccess 四连 @Optional）；`executor.service.ts:148-166`（eventBus/tracing/audit/leaderGate/pullService 五连）；全仓 20+ 处
- **证据**：`@Optional() private readonly eventBus: DomainEventBus | null` —— provider 缺失/装配错误时事件静默不发、审计静默不写、门禁静默失效。
- **影响**：这是为存量单测「直接 new 装配」付出的运行时代价：任何一次 module 装配改动都可能把生产实例变成「永不发事件/永不写审计」而无一告警。**建议**：为可空协作方提供显式 no-op provider（如 `NULL_EVENT_BUS`），生产装配用 `APP_GUARD` 式强制绑定 + 启动时自检（Nest `onModuleInit` 内 `logger.warn` 一次「运行于降级装配」），把静默降级变成可观测状态。**工作量**：M

#### R-27【测试】批量端点与写面守卫的测试只断言「委托」，把缺陷固化

- **位置**：`apps/admin-api/src/modules/task/__tests__/task-batch.controller.spec.ts:118-133`
- **证据**：`expect(taskSvc.remove).toHaveBeenCalledWith("t1")`——mock service 层，导致 R-02 的漏传 user 无从暴露；`task.service.spec.ts` 用降级 secrets 桩，R-01 的掩码回写无回归。
- **影响**：两个 P0/P1 级缺陷都有「测试存在」的假象。**建议**：R-01/R-02/R-03 修复时同步补 service 级集成断言（真 repo/mock repo 落库值断言）。**工作量**：S

#### R-28【打磨】依赖触发链路（triggerDependentTasks → trigger）绕过审计与触发者记录

- **位置**：`apps/admin-api/src/modules/task/task.service.ts:1354-1371`
- **证据**：`await this.trigger(task.id, {})` —— user 为 undefined，`assertCanOperate` 旁路（设计使然），但 audit 无任何记录、execution.triggerType 仍为 "manual"。
- **影响**：依赖触发的执行在审计/溯源面与手动触发不可区分（triggerType 有 "dependency" 可用而未用）。**建议**：内部调用传入 `triggerType: "dependency"`（或专参），便于溯源。**工作量**：S

#### R-29【打磨】入队 job 载荷不一致：scheduler 带 `task`，trigger/rollback 不带

- **位置**：`apps/admin-api/src/modules/scheduler/scheduler.service.ts:995-999`（`{ executionId: exec.id, task }`）vs `task.service.ts:664-667,1274-1277`（`{ executionId: exec.id }`）
- **证据**：processor 统一从 DB 重读 task（`task.processor.ts:66`），载荷里的 `task` 是死重量（每 job 序列化整行任务，含 params/secrets 密文）。
- **影响**：Redis 内 job payload 膨胀 + 秘密列随 job 进 Redis（removeOnComplete 保留 1h/1000 条——**任务密文在 Redis 中驻留 1 小时**，算一个轻微的数据驻留面）。**建议**：统一去掉 `task` 字段。**工作量**：S

#### R-30【Bug/打磨】`markStaleOffline` 查询与更新间隙可能对已恢复心跳的执行器发「离线」通知/事件

- **位置**：`apps/admin-api/src/modules/executor/executor.service.ts:1644-1672`
- **证据**：先 `find`（捕获 name/address 列表），后 `update`（同条件重查，行级正确），但通知/事件循环遍历的是**先查的列表**——间隙内恢复的执行器仍会收到 executor.offline 事件与通知。
- **影响**：低概率误报（执行器在 30s 扫描间隙恰好恢复心跳）。**建议**：以 UPDATE RETURNING 结果为通知集。**工作量**：S

---

## 三、架构升级建议专节

### 3.1 执行状态机收口（建议周期：1~2 轮；收益：消灭 7+ 处散落的终态写法；风险：中）

`status IN (pending,running)` 条件 UPDATE + RETURNING winner 语义目前在 7 处各自手写：`task.service.handleCallback/killExecution`、`scheduler.recoverStaleExecutions/COVER_EARLY`、`task.processor` finally+repair、`executor.detectLostExecutions`、`executor.failRunningExecutionsAfterRestart`（唯独它没改，见 R-11）。
**步骤**：抽 `ExecutionTerminalService.transitionToTerminal(ids, patch)`（唯一条件 UPDATE + RETURNING + 可选槽位释放回调）；各调用点迁移；配「终态只允许被写一次」的回归矩阵。
**收益**：终态/槽位/事件的原子性由一处保证，R-06/R-11/R-30 类计数漂移与覆盖缺陷从结构上消失。

### 3.2 任务/应用写面守卫装饰器化（建议周期：1 轮；收益：堵住 R-03 类漂移；风险：低）

NF-03/AUTH-02 的守卫目前是 service 内手工调用，出现 `update/remove 有、updateGlue/rollback/rollbackToVersion 无` 的漂移。
**步骤**：新增 `@WriteGuard(resource)` 组合装饰器（controller 级 or interceptor），内部统一 `assertCanWriteProjectAware` + `assertCanOperate`；task/application 两个模块全部写面接入；用 metadata 扫描测试**穷举所有写端点必须有守卫元数据**，防止未来再漂移。
**收益**：RBAC 覆盖从「逐点人肉」变为「缺省拒绝 + 白名单」。

### 3.3 `app-deployment.service` 拆分（2505 行 God class）

现状一个类同时承担：部署推送 + 重试、审批三动作、心跳推进、canary rollout 状态机（进程内 batch + timer）、健康探针、版本快照、中断恢复 sweep。
**步骤**：①`DeploymentPushService`（HTTP push/SSRF/重试）；②`RolloutEngineService`（批次/租约/探针/自动回滚）；③`DeploymentApprovalService`（审批三动作）。每个 ≤600 行，模块内互相注入无环。
**收益**：R-07（探针 SSRF）这类「同一策略两处实现不同步」的缺陷自然收敛；测试面从单文件 2500 行拆为可独立覆盖。

### 3.4 配置面二次收口：外部 URL 族 + 保留期族

`ADMIN_API_URL`（install-cmd、package push）、`API_BASE_URL`（application packageUrl）、`NPM_REGISTRY_URL` 三个「对外可达地址」配置各为一家，Joi 只覆盖其一；保留期散落为 5 个独立 cron（log 30d / execution 90d / audit 180d / S3 / artifacts），metrics_history 与 event_outbox 漏配（R-09/R-11 关联面）。
**步骤**：`externalUrls` 配置节（adminApiUrl/apiBaseUrl/registryUrl，Joi 统一 uri 校验）；`RetentionService` 注册表（`{table|store, days, batcher}`），每个数据族一行声明，cron 只跑注册表。
**收益**：配置 typo 从「静默 503」变「启动失败」；新增数据族不可能再忘配清理。

### 3.5 跨模块环的长期解：事件化残余直调

`task↔executor`、`task→scheduler` 双向 forwardRef、`application→task` ModuleRef lazy、processor→notification 死注入（R-20）都是事件总线（ARCH-21）落成前的过渡态。
**步骤**：把「派发占坑/释放」「依赖触发」改为 DomainEventBus 事件（`executor.slot.released` / `execution.succeeded`），executor 模块订阅事件而非被 task 直调；processor 删除两个死注入。
**收益**：模块依赖图单向化，`forwardRef` 全部消失；事件总线已有的 fail-open+可观测面为这些旁路提供统一日志。

---

## 四、待复核项

| # | 疑点 | 复核方法 |
|---|---|---|
| W-1 | **refresh_tokens 外键级联**：`users.service.remove` 删除用户后 refresh_tokens 行是否残留（R-14 依赖此判断） | 查看 `refresh-token.entity.ts` 的 `@ManyToOne onDelete` 与 `1717473142680-RefreshTokenTable.ts` 的 FK 定义 |
| W-2 | **掩码回写在 updateGlue 路径是否同型存在**：`updateGlue` 走 `findOne`（脱敏）→ `save(t)`，t.secrets 为掩码副本，若任务带 secrets 则 `PUT /:id/glue` 同样会触发 R-01 同型破坏 | 与 R-01 同一修复一并验证：落库值逐字节断言 |
| W-3 | **broadcast 心跳纠偏的净效应**：R-06 的计数漂移会被执行器心跳上报 `runningTaskCount` 每 30s 覆写，需确认 executor-node/python 实际上报语义（是否上报、频率），据此量化漂移窗口 | 读 executor-node scheduler.sendHeartbeat 的 runningTaskCount 来源；真机双任务混布观察 `executors.runningTaskCount` 曲线 |
| W-4 | **`sse.maxStreamsGlobal` 与 `metricsStream.maxStreamsGlobal` 两套独立槽位在多实例下的真实容量**：QA-05/ARCH-31 已做全局槽位自检（`test:arch31-multi-instance`），本报告未复核其与 `SSE_MAX_STREAMS_GLOBAL`（进程内）注记的一致性 | 跑 `npm run test:arch31-multi-instance` 并核对文档矩阵 |
| W-5 | **`getExecutionLogs` level 过滤 + S3 回退路径的分页一致性**：S3 路径整流过滤（O(n) 每页重扫），大日志 + level 过滤 + 深翻页时复杂度 O(n×页数)，是否构成可感知延迟 | 对 400k 行 S3 日志做 level=ERROR 深翻页基准（`bench:micro` 扩一档） |
| W-6 | **OIDC 回调 state cookie 的 SameSite/Secure 属性**：AUTH-04 已做无状态 HMAC state，本报告未复核 cookie 属性与多实例密钥来源（HMAC key 是否绑定 JWT secret、轮转行为） | 读 `oidc.service.ts` state 签发/校验段 + ADR-014 |
| W-7 | **`trigger()` 事务中 `manager.save` 与 Bull 入队补偿的窗口**：enqueue 失败补偿 UPDATE 不带 `status IN (pending)` 谓词（task.service.ts:691-696 与 1295-1300），理论上若补偿前回调已写终态会被覆盖——窗口极小，未构造出可靠交错 | 复核该 UPDATE 是否需要补 open-status 谓词（与其余终态写法对齐） |

---

## 附：最重要 10 条（Top10）

| # | 一句话 |
|---|---|
| R-01 | 任务 PATCH 不带 secrets 会把 `******` 掩码写回库，任务凭据不可逆损毁（P0，零测试覆盖） |
| R-02 | `POST /tasks/batch/delete` 漏传 user，对包括管理员在内的所有调用方恒 403，批量删除整体失效 |
| R-03 | updateGlue / rollback / rollbackToVersion 三个配置与代码写面完全绕过 NF-03/AUTH-02 归属守卫 |
| R-06 | 广播派发不占坑 `runningTaskCount` 而回调统一释放，执行器容量闸门计数系统性漂移 |
| R-04 | jwt.strategy/refreshToken 用抛 404 的 findById，已删除用户返回 404 泄漏存在性（H-3 半修复） |
| R-05 | TOTP 登录路径漏掉 `clearExpiredLock`，锁过期后一次失败即永久再锁 |
| R-07 | 灰度健康探针绕过 `assertSafeExecutorUrl` SSRF 闸且强制 http，与同文件 deploy 面姿态不一致 |
| R-08 | 回调路由 55MB body 解析先于限流鉴权，未认证内存放大向量（rawBody 再复制一份） |
| R-09 | executor_metrics_history 每执行器每天 2,880 行且无任何清理，无界增长 |
| R-11 | 重启恢复路径逐行 save 无异常隔离，一次乐观锁冲突可让 register/heartbeat 整体 500 并连锁判离线 |
