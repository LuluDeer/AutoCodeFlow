# R4-B 并发 / 事务 / 数据完整性审计报告（第四轮）

- 审计人：R4-B agent（只读审计）
- 日期：2026-09-02
- 范围：`apps/admin-api/src/modules`（task / scheduler / executor / application / metrics / notification / audit / config），TypeORM 0.3.31 + PostgreSQL + BullMQ + ioredis
- 方法：全量通读核心服务与实体；用 node_modules 内 TypeORM 0.3.31 源码（`UpdateQueryBuilder.js:397-403`、`persistence/SubjectExecutor.js` executeUpdateOperations、`persistence/SubjectChangedColumnsComputer.js`）核实 save()/QueryBuilder 的版本列与写列语义后下结论。
- 不含：第三轮已修项（Leader Election、claimTaskTrigger、executor 乐观锁派发、SSE 上限、日志保留清理、enqueue 失败补偿），除非发现其实现本身有新问题（本文 P0-1 即属此类——两个既有修复叠加产生的新缺陷）。

关键背景事实（后文推理依赖，已对 0.3.31 源码核实）：

- **F1**：`UpdateQueryBuilder` 在目标为实体类时自动追加 `version = version + 1`（typeorm `query-builder/UpdateQueryBuilder.js:397-403`），但 **WHERE 里从不检查 version**；`OptimisticLockVersionMismatchError` 只在 `SelectQueryBuilder.setLock('optimistic')` 路径抛出。因此 `repo.save()` 更新路径 = **无条件按主键覆盖（仅写相对加载快照变化的列）+ 自动 bump version**。
- **F2**：`save()` 只写相对加载快照发生变化的列；但只要代码**显式改了某列**（如 status），该列就会盲写覆盖并发写入。
- **F3**：`.update("表名字符串")`（如 task.service/scheduler.service 的 releaseExecutorSlot 用 `.update("executors")`）**不 bump version、不更新 UpdateDateColumn**；`.update(Executor)`（executor.service 版本）则会。
- **F4**：PostgreSQL READ COMMITTED 下，条件 UPDATE（如 `runningTaskCount < max`）在锁等待后会基于最新行版本重新评估谓词（EvalPlanQual），因此 executor.service `dispatch()` 的"版本匹配 + 容量条件 + 原子自增"确实不会超卖。

---

## Findings

---

### [P0] 调度触发去重锁被 watchdog 永久续期且从不释放 —— 每个 cron/fixed_rate 任务在一个进程生命周期内只能触发一次

**证据**

- `apps/admin-api/src/modules/scheduler/scheduler.service.ts:503` — `enqueue()` 以 `task:trigger:${task.id}` 为 key `acquireLock(lockTTL)`；
- `scheduler.service.ts:618-622` — finally 中**故意不释放**（"P1: deliberately do NOT release the dedup lock — its TTL is the dedup window across instances"）；
- `apps/admin-api/src/common/services/redis-lock.service.ts:55-66` — **High-5.1 修复给每次 acquireLock 都挂了 watchdog**，每 `ttl/3` 永久续期，直到 `release()` 或续期报错；
- 全仓 `lock.release()` 只有 `scheduler.service.ts:187`（demote）与 `:227`（onModuleDestroy），均只作用于 leaderLock，从不作用于 trigger 锁。

**推理（时序）**

1. t0：cron tick → `enqueue()` → `SET NX lock:task:trigger:T` 成功，watchdog 每 ttl/3 续期；正常创建 execution 并入队。
2. t1（下一个周期，如 fixedRate 30s 后）：tick 再次 `enqueue()` → `SET NX` 失败（key 存在且被 watchdog 一直续期，**TTL 永不过期**）→ 返回 null → `if (!lock && !claimedViaDb)` 打日志 "recently triggered by another instance, skip"。
3. 此后该任务的每一次调度触发（fixed_rate 定时器、node-cron、checkMisfires 的 FIRE_ONCE 补偿）全部命中同一把永久锁 → **永久静默跳过**。
4. `claimTaskTrigger` 的 DB claim 兜底只在 `acquireLock` **抛错**（Redis 不可用）时启用；"锁被持有"（返回 null）路径不做 DB claim——所以 Redis 越健康，任务死得越彻底。
5. 只有进程重启（watchdog 停止 → TTL 到期）或 Redis 重启后，任务才会再触发一次，然后再次锁死。`lock:task:trigger:*` 键还在 Redis 中无界累积（内存泄漏）。

这个缺陷是第三轮两个修复（"不释放锁靠 TTL 去重" + "watchdog 防长事务丢锁"）叠加产生的回归：watchdog 语义对 **leader 租约/派发期短锁**正确，对 **TTL 即去重窗口的触发锁**是错的。

**confidence: verified**（纯代码推演；两个单测文件均 mock 了 `RedisLockService.acquireLock` 每次返回新锁/固定 null，掩盖了该行为）。

**建议修复**：`RedisLockService.acquireLock(key, ttlMs, opts?: { watchdog?: boolean })`，触发去重场景传 `{ watchdog: false }`（或提供 `acquireDedupLock()`），保持"不释放、靠 TTL"原语义；同时补一个集成测试（testcontainers 起真实 Redis）断言：TTL 过期后同一任务可再次 enqueue。

**测试影响**：`scheduler.service.spec.ts`（enqueue 相关用例需改为可续期/不可续期两种锁行为）；新增 `redis-lock.service` 的 watchdog 开关用例；`__tests__/scheduler.service.spec.ts` 中 "recently triggered" 用例需区分"锁被持有"与"TTL 已过期"。

---

### [P0] 依赖任务触发是死代码：worker 收尾处 `exec.status` 永远不可能为 SUCCESS，依赖编排功能整体失效

**证据**

- `apps/admin-api/src/modules/task/task.processor.ts:321-323`：
  ```ts
  if ((exec.status as ExecutionStatus) === ExecutionStatus.SUCCESS) {
    await this.triggerDependentTasks(exec.taskId);
  }
  ```
- `handle()` 内 `exec.status` 的全部赋值：`:93`（claim → RUNNING）、`:113`（dispatch 成功 → RUNNING）、`:147-149`（catch → FAILED/TIMEOUT）。**SUCCESS 从未被赋值**——成功终态只由 executor 回调经 `TaskService.handleCallback` 的条件 UPDATE 写入（`task.service.ts:1035-1043`），而 `handleCallback` 不调用 `triggerDependentTasks`。
- 全仓 `triggerDependentTasks` 仅此一处调用（grep 核实）。

**推理**

任何执行无论成功失败，进入 finally 时 `exec.status ∈ {RUNNING, FAILED, TIMEOUT}`，`:321` 的条件恒为假 → `triggerDependentTasks` 永不执行 → **所有配置了 dependencies 的任务链永远无人触发**（创建依赖时的环检测 TASK-007 做得很好，但链路本身是死的）。且因为依赖检查读的是"最新一次执行是否 SUCCESS"，即使将来把触发点挪到 handleCallback，也要处理双路（callback 先写 SUCCESS 时 worker finally 被 `writable IN (pending,running)` 挡掉）的一致性。

**confidence: verified**（可用现有 mock 栈写单测直接证伪：构造 dispatch 成功 + 回调 SUCCESS，断言 `taskService.trigger` 从未被调用即复现）。

**建议修复**：把依赖扇出挪到 `handleCallback` 条件 UPDATE **命中后**（affected>0 且 status==='success' 的唯一赢家路径）执行；或 worker finally 中改用"回读 DB 终态"而非内存 exec.status 判断。两者都需同时修 P3 的"依赖扇出无去重"（见 P3-2），避免两个依赖同时完成时重复触发下游。

**测试影响**：`task.processor.spec.ts` 增加"dispatch 成功 + 回调成功 → 下游被触发一次"用例；`execution-callback.controller.spec.ts` / `task.service.spec.ts`（handleCallback 路径）同步补充。

---

### [P1] 多页日志回填逐页调用 storeLogLines，每页先 `delete({executionId})` 清空旧行 —— 超过 2000 行的日志最终只剩最后一页

**证据**

- `apps/admin-api/src/modules/task/task.service.ts:920-942`（backfillFullLogsFromExecutor）：
  ```ts
  for (let page = 0; page < MAX_PAGES; page++) {
    ...
    await this.storeLogLines(execution.id, chunk, fromLine);  // 每页一次
    fromLine += chunk.length;
  ```
- `task.service.ts:848-882`（storeLogLines）：**每次调用开头** `await this.logLineRepo.delete({ executionId })`，然后仅插入当前 chunk（行号用 startLineNumber 偏移）。S3 路径同理：`s3.put(executionId, lines.join("\n"))` 每页覆盖同一对象 `execution-logs/{id}.log.gz`。

**推理（时序）**

1. 回调日志带截断标记（>512KB 上限），触发 backfill；日志共 5000 行。
2. page0：`delete(全部)` → 插入行 0-1999；page1：`delete(全部，含 page0 的 2000 行)` → 插入 2000-3999；page2：delete 全部 → 插入 4000-4999。
3. 结束：DB/S3 中**只有最后 2000 行**，前 3000 行永久丢失（executor 侧可能也只保留有限滚动日志）。日志查看器/SSE 只能看到尾部；日志总量与 `totalPersisted` 统计不符。
4. 附带：非事务的逐页 delete+insert 期间，SSE 轮询会读到"行数先增后清零再增"的抖动视图。

**confidence: verified**（代码直读即可确认；单测思路见下）。

**建议修复**：回填路径改为**一次性**写库：跨页累积到临时数组后调用一次 storeLogLines；或给 storeLogLines 增加 `replace: boolean` 参数，回填首页 replace=true、后续页 append（仅 S3 路径可整对象重传，DB 路径 append 直接 insert 且 delete 只发生在首页）。同时把 delete+insert 包进一个事务。

**测试影响**：`task.service.spec.ts` / `task-service-s3.integration.spec.ts` 增加"3 页回填后 logLineRepo 中共 5000 行、行号 0..4999 连续"断言；现有 `s3-log-storage.spec.ts` 不受影响。

---

### [P1] 三处对 RUNNING 执行的"终态化"仍用盲写 save() —— 可覆盖并发回调写入的 SUCCESS 并双重释放 executor 槽位（与 TASK-004 修复不一致）

**证据**

- `apps/admin-api/src/modules/executor/executor.service.ts:179-191`（failRunningExecutionsAfterRestart，executor 重启/心跳检测到重启时调用）：
  ```ts
  execution.status = ExecutionStatus.FAILED; ...
  await this.execRepo.save(execution);            // 盲写
  await this.releaseExecutorSlot(execution.executorAddress);
  if (task) await this.scheduleRetryAfterRestart(task, execution);  // 还会再建一条 PENDING 重试
  ```
- `executor.service.ts:740-748`（detectLostExecutions 定时扫描）：同样 `save()` 盲写 + 释放槽位。
- `apps/admin-api/src/modules/scheduler/scheduler.service.ts:553-566`（enqueue 的 COVER_EARLY 策略）：
  ```ts
  running.status = ExecutionStatus.CANCELLED; ...
  await this.execRepo.save(running);              // 盲写
  await this.releaseExecutorSlot(running.executorAddress);
  ```
- 对比：`scheduler.service.ts:335-393`（recoverStaleExecutions，TASK-004）已改为"条件 UPDATE `status IN (pending,running)` + RETURNING + 仅对命中行释放槽位"——这三处漏改。

**推理（交错时序，以 detectLostExecutions 为例）**

1. t0：execution E 处于 RUNNING（startTime 已超 task.timeout+5min，executor 实际仍在跑）。
2. t1：detectLostExecutions `getMany()` 读到 E（RUNNING 快照），随后批量取 tasks/executors（引入数百 ms 窗口）。
3. t2：E 真正跑完，executor 回调 → `handleCallback` 条件 UPDATE 命中（pending/running→success），`releaseExecutorSlot` 一次（计数 -1）。
4. t3：detectLost 对内存快照盲写 `save()`：status/endTime/failureReason/logs 相对快照已变更 → 按 id 无条件 UPDATE（F1/F2）→ **success 被覆盖为 failed**，且 version 被无条件再 +1。
5. t4：detectLost 再次 `releaseExecutorSlot` → 计数**第二次 -1** → `runningTaskCount` 低于真实值 → 后续 dispatch 容量检查（`runningTaskCount < maxConcurrentTasks`）放行超额任务 → **超出 maxConcurrentTasks 超卖**（GREATEST(...-1,0) 只防负数不防多减）。executor 下一次心跳自报 runningTaskCount 才会纠正（executor-node/executor-python 均上报自身计数，已核实），窗口内超卖已发生。
6. failRunningExecutionsAfterRestart 更糟：还会 `scheduleRetryAfterRestart` 造出一条多余的重试执行 → 同一业务任务被重复执行（副作用双跑）。
7. COVER_EARLY 同理：成功执行被改判 cancelled，回调被终态门（`open IN (pending,running)`，task.service.ts:1040-1042）拒绝，真实结果/日志永久丢失 + 双重释放。

**confidence: verified**（竞态窗口=读快照到 save 之间的毫秒~秒级；回填/重启风暴时窗口放大。单测可复现：mock getMany 返回 RUNNING 行 → 先执行 handleCallback → 再执行 detectLost 循环体 → 断言 status 被错误覆盖、release 被调两次）。

**建议修复**：三处统一改成与 TASK-004 相同的模式：`UPDATE ... SET 终态 WHERE id IN (...) AND status IN ('pending','running') RETURNING id, executorAddress`，仅对 RETURNING 命中行释放槽位/建重试。COVER_EARLY 单行版本同理。

**测试影响**：`executor.service.spec.ts`（failRunningExecutionsAfterRestart / detectLostExecutions 各加"并发回调先赢"用例）；`scheduler.service.spec.ts`（COVER_EARLY 加同款用例）。

---

### [P2] 多实例 @Cron 未接 Leader 门禁：markStaleOffline / detectLostExecutions / cleanupOldRecords / cleanupOfflineExecutors / detectStuckDeployments / handleDailyCleanup 在每个实例并行执行

**证据**：`executor.service.ts:688,756,770,811`、`app-deployment.service.ts:591`、`log-retention-cleanup.service.ts:36`、`audit.service.ts:36`、`auth.service.ts:146` 均为裸 `@Cron`，无 `isLeader` 判断（scheduler.service 的 reload/recoverStaleExecutions 有， TASK-006 只覆盖了 scheduler 模块）。执行器离线通知（`markStaleOffline` → notifyExecutorOffline）会按实例数重复发送；`detectLostExecutions` 双实例并发使 P1-4 的盲写竞态窗口翻倍；清理类删除虽幂等但并发抢锁。

**confidence: verified**（行为层面；重复告警可测）。**建议**：抽一个 `@LeaderOnly()` 装饰器/守卫或在各 cron 入口复用 `isLeader` 判断（fail-open 语义与 TASK-006 一致）。**测试影响**：为各服务补 isLeader=false 直接 return 的用例。

---

### [P2] cleanupOldRecords / cleanupOldAuditLogs 为单条无界 DELETE —— 百万行级长事务锁表（与 DB-002 分批方案不一致）

**证据**：`executor.service.ts:758-767`（task_executions >90d，一条 `execRepo.delete({createdAt: LessThan(...)})`）；`audit.service.ts:38-41`（audit_logs >180d 同款）。表是写入最热的 task_executions，一次百万行 DELETE 会长时间持锁、阻塞回调路径的条件 UPDATE 并造成 WAL 膨胀；多实例（P2-1）还会并发执行。execution_log_lines 有 30 天保留（<90 天），执行行删除后不会留下永久孤儿日志行——这点已核实无问题。

**confidence: verified**。**建议**：复用 `LogRetentionCleanupService.cleanupExpiredLines` 的 `id IN (SELECT ... LIMIT 5000)` 分批模式。**测试影响**：log-retention-cleanup.service.spec 的分批逻辑可参数化复用。

---

### [P2] executorAddress 在 dispatch HTTP 返回后才落库 —— 超快回调窗口：槽位泄漏 + 回调地址校验被绕过；dispatch 网络错误重试可双执行

**证据**

- `task.processor.ts:99-110`：axios.post 返回**之后**才 `execRepo.update(exec.id, { executorAddress })`；dispatch 内部（`executor.service.ts:557`）只是内存赋值。
- `task.service.ts:987-999`：地址校验为 `execution.executorAddress && cb.executorAddress !== execution.executorAddress` —— 行上地址为 null 时**跳过校验**。
- `task.service.ts:1052-1054`：`releaseExecutorSlot(execution.executorAddress)` 用的是**读取时**的地址。

**推理**

窗口 A（槽位泄漏）：executor 接受任务后毫秒级完成并回调，早于 worker 的 executorAddress UPDATE 提交 → 回调读到 null 地址 → 校验跳过、状态写成功，但 `releaseExecutorSlot(null)` 为 no-op → dispatch 的 +1 永不回收 → 该 executor 容量永久少一个（心跳自报可自愈，见 P3-3）。
窗口 B（双执行）：dispatch 因"连接已建立但响应丢失"（socket hang up）抛错 → BullMQ 重试（非 TIMEOUT 错误会 retry，TIMEOUT 已用 UnrecoverableError 防住，task.processor.ts:199-204）→ 重试重新 claim（FAILED 仍 claimable，:79-85）并派发到另一台 executor；期间第一台 executor 实际已开跑 → 同一 executionId 在两台机器执行，副作用双跑。at-least-once 语义下无法根除，但可收窄。

**confidence: verified（窗口存在性）/ suspected（生产触发频率，需按真实任务最短时长评估）**。验证：集成测试让 executor 端点在响应前就异步回调（窗口 A）；让 axios 中途 ECONNRESET 而服务端已受理（窗口 B）。

**建议**：claim 后、axios.post **之前**就 `execRepo.update(exec.id, { executorAddress: matched.address })`（同时把 claim 与地址写入合并为一条条件 UPDATE）；回调校验把 null 地址也按"已派发但地址未知"处理（宽限期后拒绝）。**测试影响**：task.processor.spec / executor.service.spec 的 dispatch 用例需断言地址写库先于 HTTP 调用。

---

### [P2] saveVersion 的 MAX+1 仍是读-改-写，task_versions 缺 (taskId, version) 唯一索引 —— 并发保存产生重复版本号

**证据**：`task.service.ts:1095-1102`（注释称"Use MAX(version)+1 to avoid race condition"——实际只避免了 COUNT 漂移，两个并发事务可同读 MAX=5 各插一条 v6）；`task-version.entity.ts:12-13` 仅有**非唯一**索引 `idx_task_versions_taskId_version`。对比 application-version.entity.ts:17-19 已有 DB-004 唯一索引——同类问题两处修法不一致。

**confidence: verified**。**建议**：补唯一索引（需先清历史重复数据）+ 冲突重试；或 INSERT 时用 `INSERT ... SELECT COALESCE(MAX..)+1` 单语句。**测试影响**：task.service.spec 增加 Promise.all 两次 saveVersion 断言一胜一败/版本号不重复。

---

### [P2] rollbackToVersion 换 cron 后不重注册调度器 —— 旧 cron 定时器永久残留并继续按旧配置触发

**证据**：`task.service.ts:1158-1170`（rollbackToVersion 只 save 任务）；对比 `update()`（:238-249）会 `stop(id)` + `scheduleOne`。`scheduler.service.ts:484-487`（reload）对已在 `timers/cronTasks` 中的任务直接 `continue`，**不会**按新配置重挂。于是版本回滚改了 cronExpression 后：旧 cron 继续按旧计划触发（enqueue 会重读最新任务，但触发时刻表是旧的），新计划永不生效，直到任务被 update/pause/进程重启。

**confidence: verified**。**建议**：rollbackToVersion 保存后调用 `this.schedulerService.stop(id)` + `scheduleOne(saved)`（与 update/rollback 一致）。**测试影响**：task.service.spec 增加"回滚版本后 timers 被重建"断言。

---

### [P2] killExecution / COVER_EARLY 只改数据库，不向 executor 传播取消 —— 记录与真实执行背离

**证据**：`task.service.ts:1211-1251`（killExecution 无任何对 executor 的停止调用，返回消息即 "marked as terminated"）；`scheduler.service.ts:553-566`（COVER_EARLY 同）。后果：executor 继续跑完（消耗资源、产生真实副作用），结果被终态门丢弃；admin 侧已提前 `releaseExecutorSlot` → 真实并发 > 计数（心跳自报可纠正）。

**confidence: verified（行为）/ suspected（是否算缺陷取决于产品语义，但当前 UI 文案"Force-cancel"有误导）**。**建议**：有 executorAddress 时尽力发一次取消信号（fire-and-forget），并接受"尽力而为"语义。**测试影响**：executor.service.spec 需新增 mock 停止端点用例。

---

### [P2] storeLogLines 的 delete+insert 无事务 —— 中途失败把该执行已有日志行清空

**证据**：`task.service.ts:870-881`：先 `delete({executionId})`，随后按 500 行分片 `save`；任一分片抛错（连接抖动/约束冲突）即止，已删旧行不回滚。缓解因素：`handleCallback` 在此之前已把 cb.logs 原文写进 `exec.logs` 列（条件 UPDATE 的 patch.logs，:1030-1032），日志查看器可回退到该列——但 SSE 流式路径（logLineRepo）将为空。

**confidence: verified**。**建议**：事务包裹（或先插后删换名方案）。**测试影响**：task.service.spec 增加"第二分片失败时旧行保留"用例。

---

### [P3] runningTaskCount 双源写入：executor 心跳自报值直接覆盖服务端计数

**证据**：`executor.service.ts:302-317`（heartbeat `Object.assign(e, metricValues, ...)`，metricValues 含 executor 自报 runningTaskCount；executor-node `scheduler.ts:80` / executor-python `scheduler.py:76` 均上报）。在途心跳携带的旧快照可冲掉 dispatch 刚 +1 的值（save() 无版本检查，F1）。因为自报值本质是"executor 真相"，该机制同时是 P1-4 泄漏的自愈通道与偶发超卖来源。**建议**：心跳只在上报值与服务端计数差值超过阈值时采纳，或字段改名分离"自报负载(用于打分)"与"权威计数(用于容量)"。

---

### [P3] 依赖扇出无去重 + checkDependencies 无界查询（修复 P0-2 时须一并处理）

**证据**：`task.processor.ts:365-395` checkDependencies `execRepo.find({ where: { taskId: In(deps) }, order: createdAt DESC })` 无 take（依赖任务历史全量进内存）；两个上游依赖几乎同时成功时，两个 worker 的 checkDependencies 都判"全部满足"→ 下游被 trigger 两次（trigger 无锁、manual 路径不走 blockStrategy）。**建议**：下游触发改走带 DB claim 的 enqueue（`claimTaskTrigger` 思路）或给 trigger 增加按 taskId 的短窗去重；find 加 `take`。

---

### [P3] Task / Application 无 @VersionColumn —— 管理端并发写 last-writer-wins

**证据**：task.entity.ts / application.entity.ts 无版本列；`task.service.ts:238-249`（update）、`:251-256`（updateGlue）、`:1158-1170`（rollbackToVersion 整快照 Object.assign）、`application.service.ts:106-110` 均为 findOne→assign→save。低频管理操作，丢更新后果是配置回退而非数据损坏。**建议**：给 Task 补 @VersionColumn（executor/execution 已有，模式现成）。

---

### [P3] 热查询缺索引/全表聚合

**证据**：`metrics.service.ts getSummary` 对 task_executions 全表 `GROUP BY status`（无时间界，行数百万级时每次面板刷新全扫）；`task.processor.ts:335-338` triggerDependentTasks 每次成功后 `dependencies IS NOT NULL` 全扫 tasks 表（JSONB 无法走索引）；`task.service.ts:218,374-381` 与 `audit.service.ts` 的 `ILIKE '%..%'` 前置通配天然无索引。均为性能而非正确性问题。**建议**：getSummary 加 createdAt 界限；依赖扫描改为启动时缓存或专表；搜索改 pg_trgm 或前缀匹配。

---

### [P3] metrics.getTodayReport 并发首次访问撞唯一索引返回 500

**证据**：`metrics.service.ts` getTodayReport findOne→无则 generateReport→save；execution-report.entity.ts `@Index(["triggerDay"], { unique: true })`。两请求同时首访 → 一方唯一约束冲突 500。**建议**：upsert（`ON CONFLICT DO NOTHING`）后重读。

---

## 已核实无问题的检查项

1. **handleCallback 终态条件 UPDATE**（task.service.ts:1035-1049）：pending/running 门 + 重复回调返回 success 不重复释放槽位、KILLED 不可被回调覆盖（R-P0-007）——正确；失败原因推断与 TIMEOUT/FAILED 映射一致。
2. **recoverStaleExecutions**（scheduler.service.ts:271-445）：单事务 + 条件批量 UPDATE + RETURNING 仅对命中行释放槽位；PENDING 宽限 10 分钟清理亦有终态保护——正确（与 P1-4 三处形成对照，证明模式已存在，只是没推广）。
3. **Worker finally ownedPatch**（task.processor.ts:229-259）：只写 worker 自有列 + writable 终态门 + 失败后 repair 路径先复查 RUNNING——不会覆盖回调/kill 结果。
4. **dispatch 容量不超卖**（executor.service.ts:520-547）：`version = :version` + `runningTaskCount < max` + 原子自增，Postgres 锁等待后重评谓词（F4），并发派发不会突破 maxConcurrentTasks；派发失败回滚自增（:569-577）。
5. **SSE 槽位生命周期**（task.service.ts:627-655, 742-768; task.controller.ts:606-642）：预占 + 内层 finally + 外层 finally 三重释放且幂等（released 标志）；`sseStreamsPerExecution` 计数归零即 `delete(key)`，**无 key 无界增长**；MAX_RUNTIME 30 分钟兜底；abort 监听 `{once:true}` + clearTimeout 无累积；abort 后 `done()` 对已销毁 socket 的 write 在 Node http 层静默丢弃（`_writeRaw` 对 destroyed socket 返回 false），不会崩溃。
6. **Leader Election 生命周期**（scheduler.service.ts:132-229）：verify/retry 定时器 unref 且 onModuleDestroy 全部清理；demote 清空本地 timers/cronTasks；fail-open 期间若他实例已真正持锁会主动让位；锁续期/释放均 Lua compare-and-operate（redis-lock.service.ts:63-92），watchdog unref、释放幂等。
7. **enqueue 失败补偿**：trigger（task.service.ts:318-330）/ rollback（:808-819）/ enqueue（scheduler.service.ts:597-609）三条入队路径均在 add 失败时把 PENDING 置 FAILED——不会悬挂；misfire 的 lastTriggerTime 已回填。
8. **rollback 事务**（task.service.ts:777-793）：task.gitCommit 更新与 PENDING 执行创建同事务；trigger 的执行创建亦在事务内。
9. **日志保留清理**（log-retention-cleanup.service.ts:60-90）：`id IN (SELECT ... ORDER BY id LIMIT 5000)` 分批、循环终止条件正确、跨实例幂等；createdAt 索引匹配；30 天日志保留 < 90 天执行保留，执行行清理后无永久孤儿日志行。
10. **BullMQ**：队列经 `BullModule.registerQueue` 注册，无手工 worker 事件监听（无重复注册）；TIMEOUT 用 UnrecoverableError 防止超时后双派发（task.processor.ts:199-204）；`attempts: Math.max(1, maxRetry)` 防零重试。
11. **分页/内存上限**：pageSize≤100（pagination.dto）、SSE/日志 limit≤2000、回调批次≤100、回填 64MB/200 页上限、S3 解压上限 100MB（s3-log-storage.ts:21,98-125）——无无界 findAll 暴露给用户输入（executor findAll/getTags 亦有 take）。
12. **回调鉴权**（execution-callback.controller.ts:76-113）：逐地址校验 token、多 executor 批次禁止共享 token 回退；与 service 层地址一致性校验双保险。
13. **通知/审计定时器**：notification.service 的 silence 清理 setInterval 有 onModuleDestroy；audit/auth 的每日清理无定时器泄漏。
14. **COVER_EARLY/DISCARD 在调度路径**（scheduler enqueue）内先查再触发的窗口受 Redis 触发锁 + 不释放语义保护，单实例内 fixed_rate 另有 runningTasks 防重入——除 P0-1 外逻辑成立。

---

## 统计

| 级别 | 数量 | 编号 |
| --- | --- | --- |
| P0 | 2 | 触发去重锁永久续期致调度一次性；依赖触发死代码 |
| P1 | 2 | 多页日志回填只剩最后一页；三处盲写 save() 覆盖 SUCCESS + 双释放槽位 |
| P2 | 7 | @Cron 无 Leader 门禁；无界单条 DELETE；executorAddress 晚落库/重试双执行；saveVersion 重复版本号；rollbackToVersion 旧 cron 残留；kill 不传播；storeLogLines 无事务 |
| P3 | 5 | 心跳覆盖计数；依赖扇出去重/无界查询；Task 无乐观锁；热查询缺索引；getTodayReport 并发 500 |
