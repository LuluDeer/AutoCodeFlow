# 任务调度与执行审查报告

**审查时间**: 2025-07
**审查范围**: task.service.ts, scheduler.service.ts, execution-callback.controller.ts, executor.service.ts, task.entity.ts, task-execution.entity.ts

---

## 问题列表

### TASK-001 [High] 执行回调鉴权存在降级路径——多 executor 地址时回退到共享 token

**文件**: `apps/admin-api/src/modules/task/execution-callback.controller.ts`, 行 68-86
**函数**: `callback()`

**问题描述**:
```typescript
if (executorAddresses.length === 1 && token) {
  // 使用 per-executor token 验证
  const isValid = await this.executorService.validateTokenByAddress(...);
} else {
  // 多地址时回退到全局共享 token
  await verifyExecutorToken(auth, ...);
}
```
当批量回调中包含来自 **多个不同 executor 地址** 的项时，认证降级为共享 token。攻击者可以在单次请求中混入一个合法 executor 和一个恶意 executor 的回调，绕过 per-executor token 验证，以共享 token 冒充任意 executor 汇报执行结果。

**修复建议**:
对批量中的每条回调项，独立验证其对应 executor 的 token，而不是全批次降级为共享 token。
```typescript
for (const item of callbacks) {
  if (item.executorAddress) {
    const valid = await this.executorService.validateTokenByAddress(item.executorAddress, token);
    if (!valid) throw new UnauthorizedException(...);
  }
}
```

---

### TASK-002 [High] 执行状态机无防护——任意状态可被回调覆盖

**文件**: `apps/admin-api/src/modules/task/task.service.ts`, handleCallback 区域
**函数**: `handleCallback()`

**问题描述**:
如果一个执行已经处于 `FAILED`/`SUCCESS`/`KILLED`/`CANCELLED` 终止状态，executor 仍然可以再次发送回调将其状态改写（例如从 FAILED 改回 SUCCESS），造成审计记录不一致，也可能引发通知重复触发。

**修复建议**:
```typescript
const TERMINAL_STATUSES = [ExecutionStatus.SUCCESS, ExecutionStatus.FAILED,
  ExecutionStatus.TIMEOUT, ExecutionStatus.KILLED, ExecutionStatus.CANCELLED];
if (TERMINAL_STATUSES.includes(exec.status)) {
  this.logger.warn(`Execution ${exec.id} already in terminal state, ignoring callback`);
  return { executionId: exec.id, success: true }; // 幂等响应
}
```

---

### TASK-003 [Medium] 竞态条件——enqueue() 与 reload() 并发可能导致重复调度

**文件**: `apps/admin-api/src/modules/scheduler/scheduler.service.ts`, 行 203-283
**函数**: `reload()`

**问题描述**:
`reload()` 每分钟运行一次，`scheduleOne()` 在任务更新时即时调用。两者之间没有互斥锁：
- `reload()` 检查 `!this.timers.has(t.id)` 时，`scheduleOne()` 可能同时执行了 `stop()` + 重新注册
- 存在短暂窗口导致同一任务注册两个 `setInterval`

**关联代码**: `reload()` 行 226-228, `scheduleOne()` 行 418-470

**修复建议**:
在 `reload()` 跳过已有定时器的逻辑前，用 `scheduleOne()` 替代直接 `setInterval`，或在内存中维护一个 `scheduling` Set 作为临界区标志。

---

### TASK-004 [Medium] recoverStaleExecutions 使用逐条 save 而非批量更新，高并发时性能差

**文件**: `apps/admin-api/src/modules/scheduler/scheduler.service.ts`, 行 125-154
**函数**: `recoverStaleExecutions()`

**问题描述**:
恢复超时执行时对每条记录单独调用 `this.execRepo.save(exec)`，在执行记录较多时会产生大量独立 UPDATE 语句，且无事务保护——部分记录更新成功而其余失败时状态不一致。

**修复建议**:
使用批量更新或事务：
```typescript
await this.dataSource.transaction(async (manager) => {
  await manager.getRepository(TaskExecution).update(
    { id: In(staleIds) },
    { status: ExecutionStatus.FAILED, endTime: new Date(), ... }
  );
});
```

---

### TASK-005 [Medium] handleCallback 未验证 executionId 归属——可跨任务篡改执行状态

**文件**: `apps/admin-api/src/modules/task/task.service.ts`
**函数**: `handleCallback()`

**问题描述**:
回调接口验证 executor token 是通过 `executorAddress` 字段，但并未验证回调中的 `executionId` 是否归属于该 executor（即该执行是否确实分配给了这个 executor）。一个合法 executor 可以汇报另一个 executor 正在执行的任务的结果。

**修复建议**:
```typescript
// 在处理每条回调前验证归属
const exec = await this.execRepo.findOne({ where: { id: item.executionId } });
if (exec.executorAddress && exec.executorAddress !== item.executorAddress) {
  throw new ForbiddenException('Execution belongs to a different executor');
}
```

---

### TASK-006 [Medium] 调度器 reload() 单实例内存锁不能跨进程——多实例部署时 Redis 锁才是唯一保障

**文件**: `apps/admin-api/src/modules/scheduler/scheduler.service.ts`, 行 34-35
**代码**:
```typescript
private runningTasks = new Map<string, boolean>(); // B-04: in-process guard
```

**问题描述**:
`runningTasks` Map 是进程内状态，多实例水平扩展时每个实例都有独立的 `runningTasks`，不共享。Redis 分布式锁 (`acquireLock`) 是阻止跨实例重复触发的唯一机制。当前 Redis 锁的 TTL 策略是 `max(taskTimeout, fixedRate)` 且**不释放**（有意设计），这意味着如果任务执行时间远小于 timeout，后续触发会被阻塞直到 TTL 过期。

**影响**: 对于超时设置为 1 小时但实际 30 秒完成的任务，锁会持续 1 小时，导致该时间内所有触发被跳过。

**修复建议**:
- 在任务执行完成（回调到达）时主动释放触发锁，而不是仅依赖 TTL 过期
- 或者将锁 TTL 改为 `max(fixedRate * 2, minLockMs)` 而非 taskTimeout

---

### TASK-007 [Low] checkCircularDependency 不防御深层嵌套依赖链的 DoS

**文件**: `apps/admin-api/src/modules/task/task.service.ts`, 行 120-186
**函数**: `checkCircularDependency()`, `detectCycle()`

**问题描述**:
递归深度没有限制。如果数据库中已存在一个很深的依赖链（例如 100 层），创建一个依赖最顶层任务的新任务时，`detectCycle` 会执行 100 次数据库查询，每次都是串行的，构成 N+1 查询问题，也是潜在的 DoS 向量。

**修复建议**:
- 添加最大递归深度限制（如 10 层）
- 或预先批量查询整个依赖图而非逐节点递归查询

---

### TASK-008 [Low] SSE 日志流没有限制最大并发连接数

**文件**: `apps/admin-api/src/modules/task/task.service.ts`, 行 559-
**函数**: `streamExecutionLogs()`

**问题描述**:
每个 SSE 连接每秒轮询一次数据库，没有对同一执行 ID 的最大并发 SSE 连接数限制。大量客户端同时打开同一执行的日志流会造成显著的数据库负载。

**修复建议**:
- 对同一 `execId` 限制最大并发 SSE 连接（如 10 个）
- 或改用 Redis Pub/Sub 将日志推送到所有监听者，而非每个连接独立轮询

---

## 正面发现

- ✅ Redis 分布式锁防止多实例重复触发（acquireLock + 不释放 TTL 设计）
- ✅ COVER_EARLY 和 DISCARD 阻塞策略正确实现
- ✅ 优化锁：enqueue 内重新查询任务状态（N8，避免 stale closure）
- ✅ 失败补偿：enqueue 失败时将 PENDING 行更新为 FAILED
- ✅ 滚动恢复：recoverStaleExecutions 和 PENDING grace window
- ✅ 回调 DTO 有 MaxLength 防止超大 payload（logs 限 512KB，errorMessage 限 4KB）
- ✅ 执行回调使用 @SkipThrottle() 避免被全局限流误杀
- ✅ Executor 重启检测逻辑（startupId + startedAt 对比）
- ✅ TaskExecution 使用 @VersionColumn() 乐观锁防止并发更新
