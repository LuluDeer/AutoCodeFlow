# Patch 方案：12:00 定时任务丢点与进程冻结（2026-10-28）

> 状态：**P2-2 / P0-1 / P0-3 已落地**；P0-2 与 P1 系列仍待实施
> 基线：`b2e7c8a4`（工作区 HEAD）
> 关联：生产端事故报告 `incident-2026-10-28-cron-12h-miss.md`（外部，未入库）

## 落地进度

| 项 | 状态 | 验证 |
|---|---|---|
| **P2-2** manual/webhook 过滤 | ✅ 已落地 | 2 条新 spec；`scheduler` 182 测试全绿 |
| **P0-1** demote 保表 + `runningTasks.clear()` + 代际标记 | ✅ 已落地 | 6 条 spec（含 2 条边界对照）；`scheduler` 全绿 |
| **P0-3** `missedExecutionTolerance` + `execution:missed` | ✅ 已落地 | `createTask` 断言 + 监听器挂载断言 |
| **P0-2** 日志异步化（stdout+stderr） | ✅ 已落地，**部署改造待排期** | 7 条 spec（含子进程真实文件场景）；541 测试全绿 |
| **P1-1/1-2/1-3、P2-1** | ⬜ 待实施 | — |

> **实施中发现并修正的一个设计缺陷**（§2.5.7）：代际快照必须取**回调开始
> 时刻**，不能取**注册时刻**——否则 demote 之前注册的定时器在 demote 之后
> 正常触发时会被误杀，等于把 P0-1 想保住的落点又丢掉。已由 spec 固化。
>
> **P0-2 的实测数据**（Node v24.21.0）：写 32MB 到普通文件，未安装时主线程
> 耗时 **22.9ms**（同步写页缓存），安装后 **4.5ms**（异步），且积压到 8MB
> 后开始丢弃——即"不再钉住主线程"与"不无界增长内存"同时成立。磁盘真正卡死
> 时这个差距会从毫秒级放大到数十秒级，正是本次事故的机制。

---

## 0. 结论摘要

| # | 改动 | 位置 | 行数量级 | 性质 |
|---|---|---|---|---|
| **P0-1** | `demote()` 不再清空定时器（**+ `runningTasks.clear()` + 代际标记**） | `scheduler.service.ts` | ~55 | 兜底，消除"丢锁=丢调度" |
| **P0-2** | 日志异步化 **+ 有界丢弃**，**stdout 与 stderr 双流**，模块级安装 | `main.ts` | ~80 | 切断放大器 |
| **P0-3** | 打开 `missedExecutionTolerance` + 接 `execution:missed` | `scheduler.service.ts` + metrics | ~35 | 覆盖"冻结跨整分" |
| **P1-1** | 落点对账告警（检测漏跑） | `scheduler.service.ts` + metrics | ~50 | 补缺失的检测能力 |
| **P1-2** | event-loop lag 指标 | 新文件 + metrics | ~40 | 补盲区 |
| **P1-3** | Leader TTL 解耦 | `scheduler.service.ts` + config | ~20 | 降触发频率 |
| **P2-1** | misfire 落点判定为主判据 | `scheduler.service.ts` | ~40 | 降噪 |
| **P2-2** | manual/webhook 前置过滤 | `scheduler.service.ts` | ~5 | 降噪（一行） |

**部署侧另有 2 项必须与 P0-2 同时做**（§7），否则代码修了也不生效。

**已定事项**：补偿策略业务侧已拍板——**默认只告警、不自动补跑**，
仅"考勤数据统计"作 opt-in 试点（§10）。

**四个必须一起做的配套**（漏了任何一个，对应改动会失效或引入新故障）：

1. P0-1 必须同时 `runningTasks.clear()`，否则 demote 瞬间在飞的任务永久卡死（§2.2）
2. P0-1 还必须加**代际标记**，否则 clear() 会放行"旧回调复活"造成重复执行（§2.5）
3. P0-2 必须**同时改 stderr**，否则 `logFatal` 那条同步写仍在（§4.2）
4. P0-2 必须放**模块级顶层**，且部署变更避开**整点前 5 分钟**（§4.2 / §4.3）

**已否决的方案**（评审中提出、经验证不可行，记录以免重复讨论）：

- **BullMQ `jobId` 幂等**（§2.5.4）：会卡死互斥唤醒路径。`wakeMutexQueuedExecutions`
  每 10s 对**同一个 `exec.id`** 重新入队，而 `removeOnComplete: {age:3600}`
  让旧 job key 稳定存活 1 小时 → `handleDuplicatedJob` 静默不建新 job →
  执行停在 PENDING 永不派发。**两处 `queue.add` 都不能加 `jobId`。**
  > 生产端已用真实 BullMQ 复现确认：`add({jobId:'X'})` 返回 `'X'`，但
  > `waiting=0`、`state` 仍是 `completed` —— 无声失效。且 10s 唤醒周期
  > 对 3600s 保留窗口，**必然撞上**，不是概率问题。

**已知残余风险**（不在 P0-1 范围，见 §11.3）：`queue.add()` 挂起期间发生
demote，恢复后仍会入队一次，而该行可能已被 stale sweep 判 `FAILED`——worker
的 claimable 含 `FAILED`，会真的执行。代际标记覆盖不到（检查点在 `enqueue()`
之前），`jobId` 又不能加。

> **收敛方案**（§11.3）：worker 侧拒绝 `FAILED + NEVER_DISPATCHED` 的 claim。
> 判定不需要 Redis，且已逐一核对不挡合法重试。**注意不能用
> `retryCount >= maxRetry` 作判据**——`retryCount` 只在新行创建时递增，
> 僵尸行恒为 0，该条件永不命中。

---

## 1. 必须先纠正的三个前提

在动手前，有三处结论需要修正，否则 patch 会打偏。

### 1.1 P0-2 的机制：`SyncWriteStream` 成立，但"改异步"会换一个故障

实测（Node v24.21.0，本机）：

```
stdout → 普通文件 : process.stdout.constructor.name === 'SyncWriteStream'  ← 同步
stdout → 管道/socket: 'Socket' / 'WriteStream'                              ← 异步
```

所以 `nohup ... &>> AutoCodeFlow.log` 确实让每次 `console.log` 变成主线程上的
`writeSync`。**这条成立。**

但**不能简单换成 `fs.createWriteStream({ fd: 1 })`**。实测同一个流在写入端
被卡住时的行为：

```
2000 × 64KB (128MB) 连续 write：
  主线程耗时      = 1ms      ← 事件循环确实不被阻塞了
  writableLength  = 125.0 MB ← 全部堆在用户态内存里，无上界
```

即：**从"事件循环被钉住"换成"内存无界增长"**。这台机器 7.6GB 内存、`overcommit_memory=1`、
Swap 已用 2.3GB——无界堆积会把 OOM killer 引过来，那是比卡 40 秒更糟的结局。

> **因此 P0-2 的正确形态是「异步 + 有界丢弃」，不是「异步」。** 见 §4.2。

### 1.2 P0-1 的写法：不能加 `isLeader` 门禁

生产端已经指出这一点，这里记录原因以防实现时被"优化"掉：

事故中 `isLeader` 直到 **12:00:00.91** 才恢复，而 12:00:00.000 那一拍
`isLeader === false`。若在 fire 回调入口加 `if (!this.isLeader) return;`，
等于把事故原样复现。

**正确做法**：照常 fire → 交给 `enqueue()` → 由 `claimTaskTrigger()` 的
DB 条件 UPDATE 做去重判决（`scheduler.service.ts:1947`）。这与 ADR-002 一致：
"DB claim 是判决，Redis 锁只是快筛"。已核实 `enqueue()` 全函数（1718–1933）
**不含任何 `isLeader` 门禁**，无需改动。

单实例部署下更无风险。

### 1.3 P0-3 不是 P0-1 的替代，是它的补充

两者覆盖冻结的**不同相位**：

| 冻结窗口 | P0-1 够吗 | 需要 P0-3 吗 |
|---|---|---|
| 11:59:16 → 11:59:44（本次，**整分之前结束**） | ✅ 够，12:00:00 定时器正常触发 | 不需要 |
| 11:59:50 → 12:00:20（**跨过整分**） | ❌ 醒来已 12:00:20 | ✅ 需要（20s ≤ 30s） |

---

## 2. P0-1：`demote()` 保留定时器

### 2.1 现状

```ts
// scheduler.service.ts:554-570
private demote(reason: string): void {
  this.isLeader = false;
  this.stopLeaderVerification();
  const lock = this.leaderLock;
  this.leaderLock = null;
  if (lock) {
    lock.release().catch(() => undefined);
  }
  // 已注册的定时器/ Cron 必须清空，否则 demote 后本节点仍会触发 enqueue，
  // 与新 Leader 产生竞争（enqueue 有 Redis 锁 + DB claim 双保险，但能免则免）
  for (const id of [...this.timers.keys()]) this.stop(id);      // ← 删
  for (const id of [...this.cronTasks.keys()]) this.stop(id);   // ← 删
  this.logger.warn(
    `Scheduler leadership lost (${reason}) — local schedules stopped, will re-contend later`,
  );
  this.scheduleLeaderRetry();
}
```

注释自己就写了"enqueue 有 Redis 锁 + DB claim 双保险，但能免则免"——这个
"能免则免"的收益是**省掉重复扫描开销**，代价是**丢一整个调度落点**。代价远大于收益。

### 2.2 diff 草案

```diff
--- a/apps/admin-api/src/modules/scheduler/scheduler.service.ts
+++ b/apps/admin-api/src/modules/scheduler/scheduler.service.ts
@@
-  /** 交出 Leader 身份：停本地全部调度，非 Leader 只保留竞选重试 */
+  /**
+   * 交出 Leader 身份。
+   *
+   * INCIDENT-2026-10-28：此前这里无条件 `stop()` 掉全部 timers/cronTasks，
+   * 代价是**丢失整个调度落点**——10-28 11:59 进程冻结 28s 打穿 30s 租约，
+   * demote 清掉 56 个 cron 定时器，12:00:00.000 那拍 reload 因 isLeader=false
+   * 早退，12:01 才重建，node-cron 从 12:01 起算 → 12:00 永久跳过。
+   *
+   * 现在保留定时器：定时器存活期间照常 fire，跨实例/跨 Leader 的重复派发由
+   * enqueue() → claimTaskTrigger() 的 DB 条件 UPDATE 判决（ADR-002：DB claim
+   * 是判决，Redis 锁只是快筛）。这是 fail-open 路径早就采用的语义。
+   *
+   * ⚠️ 不要在 fire 回调里加 `isLeader` 门禁：事故中 isLeader 到 12:00:00.91
+   * 才恢复，加门禁等于复现事故。见本文档 §1.2。
+   *
+   * ⚠️ **必须同步清 runningTasks**（见下方 `this.runningTasks.clear()`）：
+   * 旧实现靠 `stop()` 顺带清掉它（`stop()` 内有 `runningTasks.delete`），
+   * 不再调 stop() 后这个 Map 失去了唯一的整表清理点。而 cron 回调的重入闸是
+   * `if (this.runningTasks.get(taskId)) return;`——一旦某任务在 demote 瞬间
+   * 卡在 `set(true)` 与 `delete` 之间，它会被**永久**判定为"仍在运行"，
+   * 此后每一次落点都静默跳过。这是 P0-1 引入的新失效模式，必须一并堵上。
+   *
+   * 为什么是 clear() 而不是逐个 delete：demote 的语义是"本节点放弃 Leader
+   * 身份"，此刻**所有**在飞标记都不再可信（既无法确认对应回调还在跑，也无法
+   * 确认它何时结束）；逐个删需要知道哪些是"真在跑"，而我们恰恰不知道。
+   *
+   * ⚠️ **已知取舍：clear() 会放行「旧回调复活」的重复执行**，见 §2.5。
+   * 不 clear 是"永久丢落点"，clear 是"低概率重复执行"——后者可由代际标记
+   * 收敛，前者不能。因此选 clear() + 代际标记（§2.5），而不是二选一。
+   */
   private demote(reason: string): void {
     this.isLeader = false;
     this.stopLeaderVerification();
     const lock = this.leaderLock;
     this.leaderLock = null;
     if (lock) {
       lock.release().catch(() => undefined);
     }
-    for (const id of [...this.timers.keys()]) this.stop(id);
-    for (const id of [...this.cronTasks.keys()]) this.stop(id);
+    // 见上方注释：stop() 不再被调用，runningTasks 的整表清理点随之消失，
+    // 不清会让「demote 瞬间在飞」的任务永久卡在重入闸里。
+    // 同时推进代际号，让仍卡在旧回调里的任务在恢复后识别自己是上一代（§2.5）。
+    this.runGeneration += 1;
+    this.runningTasks.clear();
     this.logger.warn(
-      `Scheduler leadership lost (${reason}) — local schedules stopped, will re-contend later`,
+      `Scheduler leadership lost (${reason}) — local schedules KEPT (dedup falls ` +
+        `back to the DB claim), will re-contend later`,
     );
     this.scheduleLeaderRetry();
   }
```

### 2.3 必须一起改的地方

**(a) `tryAcquireLeadership()` 晋升钩子补 `reloadActiveTasks()`**

生产端原报告 §7① 主张这个。**在 P0-1 落地后它的必要性下降了**（定时器还在，
本就不需要重建），但仍有独立价值：覆盖「进程重启后首次竞选成功」与
「长时间 follower 后接管」——这两种情况本地注册表是空的。

```diff
@@ private async tryAcquireLeadership()
         if (!wasLeader) {
           this.logger.log(
             "Scheduler leadership acquired — this node is now the leader",
           );
+          // INCIDENT-2026-10-28：晋升瞬间重建调度表。P0-1 之后 demote 不再清表，
+          // 本调用主要覆盖「进程启动后首次竞选成功」与「长期 follower 接管」——
+          // 这两种情况本地注册表为空，等下一分钟 reload 会留下最多 60s 真空。
+          // fire-and-forget：不阻塞竞选路径，失败由下一轮 reload tick 覆盖。
+          void this.reloadActiveTasks().catch((err: unknown) => {
+            this.logger.warn(
+              `Post-promotion schedule rebuild failed: ${
+                err instanceof Error ? err.message : String(err)
+              }`,
+            );
+          });
           void this.checkMisfires().catch((err: unknown) => { ... });
         }
```

**(b) `onModuleDestroy` 保持不变**——进程退出时仍应停表，那里是 `clearInterval` /
`cronTask.stop()` 直接操作 Map，不走 `demote()`，不受影响。

**(c) `stop()` 的指纹清理语义不变**（`scheduler.service.ts:1994`）。P0-1 只是
不再在 demote 时调用 `stop()`，`stop()` 自身行为不需要改。

### 2.4 风险与回归

| 风险 | 评估 | 缓解 |
|---|---|---|
| 多实例双活时重复触发 | 低。`claimTaskTrigger` 条件 UPDATE 是唯一判决，已在 fail-open 路径验证 | 已有 spec 覆盖；建议补一条"demote 后 fire 仍被 DB claim 去重" |
| demote 后本节点仍在跑 cron 回调，浪费 CPU | 低。56 个任务，每分钟最多几十次回调，DB claim 命中即返回 | 可接受，不做额外优化 |
| 生产端已确认单实例 | — | 风险进一步降低，但**不要**为此写死单实例假设 |

**需补的 spec**（`scheduler.service.spec.ts`，现有 `demotes when the leader lease
is lost` 在 283–299 行，需改写）：

```ts
it("demote keeps local schedules alive (INCIDENT-2026-10-28)", async () => {
  await makeLeader();
  const task = makeTask({ triggerType: TaskTriggerType.CRON, cronExpression: "0 12 * * *" });
  await service.scheduleOne(task);
  expect(service.getStats().activeCronTasks).toBe(1);

  redisLockService.extendLock.mockResolvedValue(false);
  await (service as any).verifyLeadership();

  expect(service.getStats().isLeader).toBe(false);
  // 旧断言是 toBe(0)；新语义是保留
  expect(service.getStats().activeCronTasks).toBe(1);
});

it("a demoted node's cron fire is still deduped by the DB claim", async () => {
  // ⚠️ 这条 spec 是「防止有人把 isLeader 门禁加回 fire 回调」的**唯一保障**，
  //    不能写成空壳。它断言的是「回调一定会走到 enqueue/claim」，而不是
  //    「enqueue 内部去重正确」——后者已有其它 spec 覆盖。
  await makeLeader();
  const task = makeTask({
    triggerType: TaskTriggerType.CRON,
    cronExpression: "0 12 * * *",
  });
  await service.scheduleOne(task);

  // demote（此时 isLeader=false），但定时器必须仍然存活
  redisLockService.extendLock.mockResolvedValue(false);
  await (service as any).verifyLeadership();
  expect(service.getStats().isLeader).toBe(false);
  expect(service.getStats().activeCronTasks).toBe(1);

  // 直接取出已注册的 node-cron 任务，手动触发一次回调——模拟"demote 后
  // 定时器照常 fire"。若将来有人在回调第一行加 `if (!this.isLeader) return`，
  // 下面的 enqueue spy 就永远收不到调用，本用例会失败。
  const enqueueSpy = jest.spyOn(service, "enqueue");
  const cronTask = (service as any).cronTasks.get(task.id);
  expect(cronTask).toBeDefined();
  await (cronTask as any).execute(); // node-cron 的 ScheduledTask.execute()

  expect(enqueueSpy).toHaveBeenCalledWith(
    expect.objectContaining({ id: task.id }),
    "cron",
    expect.any(Number),
  );
});
```

> **`execute()` 在未 `start()` 状态下可用——已实测确认。**
> 生产端在评审中提醒了这一点（担心 `stateMachine === 'stopped'` 早退），
> 实测结论是**不必担心**：
>
> ```
> createTask 后 status = stopped
> execute() 返回 = "ok" | 回调命中 1 次
> => 未 start 状态下 execute() 可用 ✅
> ```
>
> 原因是 `Runner.execute()`（`dist/_shared.js:377`）**不检查 `this.running`**，
> 直接走 `beforeRun → onMatch → onFinished`；而 `onFinished` 无论 running
> 与否都会 `emit('execution:finished')`（`_shared.js:1077-1080`）。
>
> 另外两条实测结论对写 spec 有用：
> - **回调抛错时 `execute()` 会 reject**（不是 resolve），所以 spec 里若回调
>   路径可能抛错，需要 `await expect(...).rejects` 或先 mock 掉；
> - **`execute()` 可重复调用**（同一 task 连调两次，回调命中 2 次），便于
>   在一条 spec 里验证多次 fire。
>
> 但注意：本仓 `scheduleOne` 走的是 `createTask` + `void cronTask.start()`
> （§3.3），所以真实运行态下 `getStatus()` 是 `running` 或 `idle`，spec 里
> 看到的 `stopped` 只是 `execute()` 恰好不依赖它。

```ts
it("demote clears runningTasks so a stuck task is not wedged forever", async () => {
  await makeLeader();
  const task = makeTask({
    triggerType: TaskTriggerType.CRON,
    cronExpression: "0 12 * * *",
  });
  await service.scheduleOne(task);

  // 模拟：某任务在 demote 瞬间正卡在回调里（set(true) 已执行、delete 未到）
  (service as any).runningTasks.set(task.id, true);
  expect((service as any).runningTasks.size).toBe(1);

  redisLockService.extendLock.mockResolvedValue(false);
  await (service as any).verifyLeadership();

  // 不清的话，此后每次落点都会命中重入闸被静默跳过
  expect((service as any).runningTasks.size).toBe(0);
});
```

### 2.5 ⚠️ `clear()` 的边界：旧回调复活导致重复执行

生产端在评审时指出了这个场景。**它成立，但机制与描述的略有不同，且比描述的更糟。**

#### 2.5.1 先纠正两处机制

**(a) "DB claim 挡住新触发"只在 1 秒内成立。**

cron 的去重窗口是 `TRIGGER_DEDUP_MIN_TTL_MS = 1_000`（`scheduler.service.ts:98`，
cron 分支直接返回它），`claimTaskTrigger` 的条件是
`lastTriggerTime < now - lockTtlMs`（`scheduler.service.ts:1951`）。所以 **1 秒后
窗口就开了**——下一次落点（几分钟到几小时后）必然能 claim 成功。

真实情况不是"新触发被挡住"，而是：**新落点正常执行，旧回调恢复后又 add 一次**。

**(b) 旧回调 add 的那一行，可能已经被判 FAILED。**

`queue.add()` 确实能无限挂起：BullMQ 连接配了 `maxRetriesPerRequest: null`
（`app.module.ts:635`），而 ioredis 的 retry 上限判定是
`if (typeof maxRetriesPerRequest === "number")`（`ioredis/built/redis/
event_handler.js:338`）——`null` 不满足，**离线队列永不 flush**，
`enableOfflineQueue: true`（`app.module.ts:628`）让命令一直排队。

与此同时，stale sweep 每 2 分钟跑一次，把 `createdAt` 超过 **10 分钟**
（`PENDING_GRACE_MS = 10 * 60 * 1000`，`scheduler.service.ts:1097`）的 PENDING 行
置为 `FAILED` + `NEVER_DISPATCHED`（`scheduler.service.ts:1127`）。

**而 worker 的 claimable 列表包含 `FAILED`**（`task.processor.ts:172-177`，
注释明说"FAILED is still claimable because BullMQ retries run through here again"）。

所以完整链路是：

```
T+0      回调A: claim 成功(lastTriggerTime=T+0) → save(PENDING, execA) → queue.add() 卡住
T+10m    stale sweep: execA 超 10min → 置 FAILED / NEVER_DISPATCHED
T+20m    下一次落点: claim 成功(1s 窗口早过) → save(PENDING, execB) → add → 正常执行 ✅
T+20m+   回调A 恢复: queue.add(execA) 成功
         → worker 消费 job A → execA 是 FAILED，但在 claimable 里 → 置 RUNNING → 真的执行 ❌
```

**结果是"一条标着 NEVER_DISPATCHED 的失败记录，实际上又跑了一遍"**——比单纯的
"两个 job 各跑一次"更难排查，因为观测面（执行记录）与实际行为不一致。

#### 2.5.2 代际标记方案

生产端建议的"代际标记"是对的，实现如下：

```diff
@@ class SchedulerService
   private runningTasks = new Map<string, boolean>();
+  /**
+   * INCIDENT-2026-10-28 §2.5：调度代际号。每次 demote 递增。
+   *
+   * 用途：让"卡在旧回调里、demote 之后才恢复"的触发识别出自己属于上一代，
+   * 从而放弃入队——否则 clear() 会让它在恢复后补一次 add，与 demote 后的
+   * 新落点叠加成重复执行（且那一行可能已被 stale sweep 判为 NEVER_DISPATCHED，
+   * 因为 worker 的 claimable 含 FAILED）。
+   *
+   * 为什么用代际号而不是"检查 isLeader"：isLeader 在 demote 后可能因重新
+   * 竞选而变回 true，届时旧回调会误判为"我是现任"，代际号单调递增则不会。
+   */
+  private runGeneration = 0;
```

回调处（cron 与 fixed_rate 两个分支都要改）：

```diff
         const taskId = task.id;
+        const generationAtRegister = this.runGeneration;
         const cronTask = nodeCron.createTask(
           task.cronExpression,
           async () => {
             if (this.runningTasks.get(taskId)) { ... return; }
             const fireTime = Date.now();
             this.runningTasks.set(taskId, true);
             try {
               const latest = await this.taskRepo.findOne({ ... });
-              if (latest) await this.enqueue(latest, "cron", fireTime);
+              // §2.5：demote 会让本代作废——旧回调恢复后不得再入队
+              if (this.runGeneration !== generationAtRegister) {
+                this.logger.warn(
+                  `Cron "${task.name}" fire abandoned: generation changed ` +
+                    `(${generationAtRegister} -> ${this.runGeneration}) while the ` +
+                    `callback was in flight — the fire point was superseded by demote`,
+                );
+                return;
+              }
+              if (latest) await this.enqueue(latest, "cron", fireTime);
             } finally {
               this.runningTasks.delete(taskId);
             }
           },
```

#### 2.5.3 ⚠️ 代际标记**挡不住**真正的挂起点（评审修正）

生产端在评审中指出，我上一版写的"窗口压缩到几十毫秒"是**错的**，成立：

```
gen = N
findOne()
if (gen !== runGeneration) return   ← 检查通过（此时尚未 demote）
enqueue()
  └─ queue.add()   ← 真正无限挂起的地方，在检查点之后
     demote() → runGeneration = N+1
     add() 恢复 → job 入队，但已是"上一代"
```

**代际检查在 `enqueue()` 之前，而 `queue.add()` 在 `enqueue()` 内部**——检查
点覆盖不到。而"`add()` 可能永不返回"正是 `maxRetriesPerRequest: null` 的前提
场景。所以代际标记只能覆盖「`findOne` 期间 demote」，**覆盖不了「`add()` 挂起
期间 demote」**，后者才是主场景。

#### 2.5.4 ❌ 为什么不能改用 BullMQ `jobId` 幂等（评审提案的否决理由）

生产端提案：`queue.add(..., { jobId: exec.id })`，利用 BullMQ 的 jobId 去重
挡住重复入队，一行搞定、维护成本低。**思路正确，但在本仓会卡死互斥唤醒路径，
不能采用。**

机制（已核实 `addStandardJob-9.lua:90-95` + `handleDuplicatedJob.lua:8-26`）：

```lua
jobId = args[2]
jobIdKey = args[1] .. jobId
if rcall("EXISTS", jobIdKey) == 1 then
    return handleDuplicatedJob(...)   -- 返回已有 jobId，不创建新 job
end
```

去重的**唯一依据是 `EXISTS jobIdKey`**——只要那个 job 的 Redis key 还在，
第二次 `add` 就静默返回旧 id，**不入队、不报错**。

**冲突点：互斥组满时，同一个 `exec.id` 会被合法地重新入队。**

```
T+0    worker 消费 job(execId=X) → 命中 [mutex_wait]
       → exec.status = WAITING
       → return（不 rethrow，task.processor.ts:262-268）
       → BullMQ 判定 job 成功完成 → 进入 completed 集合
       → removeOnComplete: { age: 3600 }（app.module.ts:689）
       → **job X 的 key 在 Redis 里稳定保留 1 小时**

T+10s  wakeMutexQueuedExecutions（每 10s，scheduler.service.ts:1351）
       → WAITING → PENDING（条件 UPDATE 成功）
       → queue.add("execute", { executionId: X }, { jobId: X })
       → lua: EXISTS jobIdKey == 1 → handleDuplicatedJob → **不创建新 job**
       → woken++（代码以为唤醒成功）
       → 但队列里没有任何新 job

结果：exec 停在 PENDING 永不派发
  · 唤醒 sweep 只扫 WAITING，PENDING 不在它的范围
  · stale PENDING sweep 要等 10 分钟才置 FAILED(NEVER_DISPATCHED)
  · 互斥排队任务全部卡死 —— 比"重复执行"严重得多
```

关键细节：`removeOnComplete` 的 `age` 清理是**惰性且滞后的**——
`removeJobsByMaxAge` 只在**下一次有 job 完成时**才执行，且只清 `age` 之前的
条目（`moveToFinished-14.lua:181-182`）。所以刚完成的 job X 一定会完整存活
1 小时，互斥唤醒（10s 级）**必然撞上**。

> **补充**：即使把 `removeOnComplete` 改成 `true`（完成即删）也不安全——job
> 从完成到被删之间仍有窗口，且会牺牲排障能力。**`jobId` 与本仓的"同一
> execId 可合法多次入队"语义根本不兼容。**

**关于生产端提的第 4 点（`wakeMutexQueuedExecutions` 也缺 `jobId`）**：
恰恰相反——**这条路径正是 `jobId` 不能加的证据**。它不是"唤醒路径顺带也
该幂等"，而是"同一 `exec.id` 必须能被重新入队"的**活证据**：

- 调度入队（1893 行）与唤醒入队（1442 行）对同一个 `exec.id` 是**接力关系**，
  不是重复；
- 若两处都加 `jobId`，互斥排队任务会在第一次 job 完成后被永久锁死（见上）；
- 若只给调度入队加、唤醒不加，则两者语义不一致，后续维护者会误以为
  `jobId` 是安全惯例而扩散到其它路径。

**结论：两处都不加 `jobId`。**

> 生产端已复现确认并撤回提案：`add({jobId:'X'})` 返回 `'X'`，但 `waiting=0`、
> `state` 仍是 `completed`——**无声失效**。其自述教训是"只验证了『同 jobId
> 两次 add 只入队一次』，没验证『第一次 job 完成后用同 jobId』，这两个场景
> 语义完全相反"。这条记录保留，防止后续再被提出。

#### 2.5.5 代际标记的代价与边界（修正后）

| 项 | 说明 |
|---|---|
| **会不会误杀正常触发** | 不会。`runGeneration` 只在 `demote()` 里递增，正常运行期恒定 |
| **覆盖范围** | 仅「`findOne` 期间发生 demote」。**不覆盖**「`queue.add()` 挂起期间 demote」 |
| **代价：demote 瞬间的在飞回调会被丢弃** | 期望行为——那一拍由新落点或 P0-3 的 `missedExecutionTolerance` 覆盖。丢弃优于重复 |
| **fixed_rate 也要改** | 同一模式（`scheduler.service.ts:2042-2065`），否则只堵住一半 |
| **残余风险** | `add()` 挂起期间 demote → 恢复后仍会入队一次。此时 execA 已 save 且可能已被 sweep 判 `FAILED`（>10min），worker 的 claimable 含 `FAILED` → 会执行 |

**残余风险的真实概率**：需要「`queue.add()` 挂起 > 一个落点间隔」**且**「期间
发生 demote」。前者要求 Redis 连续不可用数分钟（`retryStrategy` 封顶 3s 重连，
通常几秒内恢复）；后者要求同时打穿 90s 租约。**两者叠加概率低，但不是零。**

> 若要彻底闭合这条残余风险，正确方向不是 `jobId`，而是 **worker 侧拒绝
> `FAILED + NEVER_DISPATCHED` 的 claim**（详见 §11.3）。该改动不需要 Redis，
> 也不涉及入队侧语义，**不在 P0-1 范围**。

#### 2.5.7 ⚠️ 实施时发现的设计缺陷：代际快照必须取「回调开始时刻」

初版实现把 `generationAtRegister` 放在 `scheduleOne` 里（注册时取快照），
**这是错的**，会让 P0-1 白做。测试当场暴露了它。

**错误版本的后果**：

```
T+0     scheduleOne 注册定时器，generationAtRegister = 0
T+1     11:59:16 进程冻结
T+2     11:59:44 demote → runGeneration = 1
T+3     12:00:00.000 定时器照常触发（P0-1 保住了它）
        → 回调比对：0 !== 1 → **放弃入队**
        → 12:00 依然丢点，与修复前完全一样
```

即：demote **之前**注册的定时器在 demote 之后正常触发——这正是 P0-1 要保住
的那个落点，却被注册期快照误杀。

**正确做法**：快照取**回调开始时刻**。

```ts
async () => {
  // 回调开始时刻的代际快照（不是注册时刻）
  const generationAtFire = this.runGeneration;
  ...
  const latest = await this.taskRepo.findOne({ ... });
  if (this.runGeneration !== generationAtFire) { /* 放弃 */ }
  if (latest) await this.enqueue(latest, "cron", fireTime);
}
```

**语义边界因此变得清晰**：

| 情形 | `generationAtFire` | demote 后 | 行为 |
|---|---|---|---|
| 回调在 demote **之后**才开始 | = 新代际 | 相同 | ✅ 正常入队（P0-1 目标） |
| 回调在 demote **之前**开始、卡在 `findOne` | = 旧代际 | 不同 | ❌ 放弃（防重复） |

这条边界由两个**对照 spec** 钉住（`scheduler.service.spec.ts`）：

- `a demoted node's cron fire still reaches enqueue (no isLeader gate)`
  —— demote 后重建的定时器必须能入队（同时防止有人加回 `isLeader` 门禁）
- `a fire that started before demote and resumes after it is abandoned`
  —— 跨越 demote 的在飞回调必须放弃

> 写这两条 spec 时也踩了一个坑，记录以备后来者：`scheduleOne` 对非 Leader
> **早退**（既有设计），所以"模拟 demote 后重建"必须先 `makeLeader()` 再
> `scheduleOne`，否则 `createTask` 根本不会被调用。

#### 2.5.6 已落地的 spec

以下用例已写入 `apps/admin-api/src/modules/scheduler/__tests__/scheduler.service.spec.ts`
并通过（`scheduler` 模块 182 测试全绿）：

| 用例 | 守护的规则 |
|---|---|
| `demotes when the leader lease is lost` | demote 后定时器**保留**（原断言是 `toBe(0)`，已改为 `toBe(1)`） |
| `demote clears runningTasks so a stuck task is not wedged forever` | §2.2 的泄漏风险 |
| `demote bumps the schedule generation` | §2.5 代际号递增 |
| `a demoted node's cron fire still reaches enqueue (no isLeader gate)` | **防止 `isLeader` 门禁被加回** |
| `a fire that started before demote and resumes after it is abandoned` | 跨 demote 的在飞回调放弃 |
| `cron registration uses createTask and attaches the missed listener before start` | §3.3 的 `createTask` + 监听器时序 |
| `skips manual/webhook tasks entirely` | P2-2 过滤生效 |
| `still reports misfires for cron tasks` | P2-2 不是"一刀切跳过"（反证） |

实现细节与初版草案的差异见 §2.5.7（代际快照的取值时刻）。

---

## 3. P0-3：`missedExecutionTolerance` + `execution:missed`

### 3.1 引擎能力（已实测确认）

`apps/admin-api/node_modules/node-cron` 版本 **4.6.0**：

- `TaskOptions.missedExecutionTolerance?: number`（`dist/node-cron.d.ts:37`）
- 默认值 `1000` ms（`dist/_shared.js:153`）
- 判定逻辑 `planBeat()`（`dist/_shared.js:129-151`）：
  ```js
  const lateBy = nowMs - slotMs;
  if (lateBy <= toleranceMs && lateBy < gap) return { missed, run: slot, next };
  ```
  即：迟醒 ≤ tolerance **且** 未越过后一个落点 → **仍然执行该落点**。
- 超出则推入 `missed[]`，逐个派发 `onMissedExecution(slot)` / `execution:missed` 事件
  （`dist/_shared.js:315`）。
- `TaskContext = { date, dateLocalIso, task?, execution?, triggeredAt, ... }`
  （`dist/node-cron.d.ts:16`）——**missed 事件的 `context.date` 就是丢失的那个落点**。
- 另有 `suppressMissedWarning?: boolean`（`dist/node-cron.d.ts:36`）：不设监听器时
  引擎自己打 warn；设了监听器就不打（`dist/node-cron.js:576-578`）。

### 3.2 diff 草案

```diff
--- a/apps/admin-api/src/modules/scheduler/scheduler.service.ts
+++ b/apps/admin-api/src/modules/scheduler/scheduler.service.ts
@@
+/**
+ * INCIDENT-2026-10-28：node-cron 的漏跑容错窗口。
+ *
+ * 引擎默认 1000ms：定时器迟醒 ≤1s 仍执行该落点，超出记 missed。生产上事件
+ * 循环被钉住 28~40s，1s 窗口形同虚设——落点被静默丢弃，且引擎的 warn 走的是
+ * node-cron 内部 logger，不进我们的结构化日志。
+ *
+ * 取值 min(30s, period/2)：
+ *  - 上限 30s：覆盖本次实测的 28s 冻结，并与 P1-2 的 event-loop lag 告警阈值
+ *    对齐（>1s 即告警，>30s 即确认丢拍）。再长会让"确实该丢的落点"被延迟
+ *    执行，与下一次落点挤在一起。
+ *  - 下限 period/2 是**保守选择，不是引擎的硬性要求**：planBeat 的判定是
+ *    `lateBy <= toleranceMs && lateBy < gap`，其中 `lateBy < gap`（gap = 到
+ *    下一落点的间隔）已经保证了容错窗口不会越过后一个落点，所以即使
+ *    tolerance > period 引擎也不会连跑两拍。取 period/2 的理由是语义上的
+ *    克制：容错窗口不应超过半个周期，否则"补跑"这件事在观感上已接近
+ *    "把上一拍挪到下一拍"。
+ *  - 最小 1s：与引擎默认值对齐，避免把容错关掉。
+ */
+export function computeMissedToleranceMs(task: Task): number {
+  const periodMs =
+    task.triggerType === TaskTriggerType.CRON && task.cronExpression?.trim()
+      ? estimateCronPeriodMs(task.cronExpression.trim(), task.timezone?.trim() || undefined)
+      : task.triggerType === TaskTriggerType.FIXED_RATE
+        ? (task.fixedRate || 60) * 1000
+        : null;
+  const cap = periodMs != null && Number.isFinite(periodMs) && periodMs > 0
+    ? Math.min(30_000, Math.floor(periodMs / 2))
+    : 30_000;
+  return Math.max(1_000, cap);
+}
```

注册处（`scheduleOne`，`scheduler.service.ts:2081`）：

```diff
-        const cronTask = nodeCron.schedule(
-          task.cronExpression,
-          async () => { ... },
-          this.getCronOptions(task),
-        );
-        this.cronTasks.set(task.id, cronTask);
+        // INCIDENT-2026-10-28：改用 createTask + 先挂监听再 start——
+        // schedule() 会同步 start()，导致首拍 missed 事件无人接收（见 §3.3）。
+        const cronTask = nodeCron.createTask(
+          task.cronExpression,
+          async () => { ... },
+          {
+            ...this.getCronOptions(task),
+            // 见 computeMissedToleranceMs 注释
+            missedExecutionTolerance: computeMissedToleranceMs(task),
+            // 挂了 onMissedExecution 后引擎不再自打 warn（node-cron.js:577），
+            // 由我们的监听器统一走结构化日志 + 指标。
+            suppressMissedWarning: true,
+          },
+        );
+
+        // 漏跑落点显式记账。context.date 是丢失的那个落点。
+        cronTask.on("execution:missed", (ctx) => {
+          const missedAt =
+            ctx.date instanceof Date ? ctx.date : new Date(ctx.date);
+          const lagMs = Date.now() - missedAt.getTime();
+          this.logger.warn(
+            `Cron fire point MISSED for "${task.name}" at ${missedAt.toISOString()} ` +
+              `(expression=${task.cronExpression}, late by ${lagMs}ms — event loop was blocked)`,
+          );
+          this.schedulerMetrics.recordCronSlotMissed();
+        });
+
+        void cronTask.start();
+        this.cronTasks.set(task.id, cronTask);
```

### 3.3 ⚠️ 监听器必须用 `createTask`，不能用 `schedule`

**这是本方案最容易写错的一处，已实测确认。**

`nodeCron.schedule()` 内部会**同步**调用 `task.start()`（`dist/node-cron.js:635`），
而 `Runner.start()` 也是同步的——它立刻算 `expectedNextExecution` 并
`armHeartBeat()` 挂上第一个 `setTimeout`（`dist/_shared.js` 的 Runner.start）。
`getDelay()` 在 delay ≤ 0 时返回 `Math.max(0, delay)`，即**可能 0ms 后立即触发**。

所以下面这种写法会丢第一拍：

```ts
const cronTask = nodeCron.schedule(expr, fn, opts);  // ← 已经 start 了
cronTask.on("execution:missed", handler);            // ← 可能已经错过
```

`node-cron` 4.6 导出了 `createTask()`（`dist/node-cron.d.ts:101`），它与
`schedule()` 唯一区别就是**不自动 start**：

```js
// dist/node-cron.js:632-648
function schedule(expression, func, options) {
    const task = createTask(expression, func, options);
    let started;
    try { started = task.start(); } catch (error) { ... }
    return task;
}
```

**正确写法**：

```ts
const cronTask = nodeCron.createTask(expr, fn, { ...opts });
cronTask.on("execution:missed", handler);   // 先挂监听
void cronTask.start();                      // 再启动
```

### 3.4 为什么不直接用引擎的 `logger`

`node-cron` 用的是自己的 `logger`（可 `setLogger` 全局替换），但它只有
`info/warn/error/debug` 四个方法，拿不到任务名、表达式、落点时间。用
`execution:missed` 事件才能拿到 `context.date`。

### 3.5 配套的 metrics 改动

上面的 diff 引用了 `recordCronSlotMissed()`，它目前**不存在**，需要新增。
`scheduler-metrics.service.ts` 的计数器是纯内存单调计数（零新依赖），按现有
`recordXxx()` 模式加即可：

```diff
--- a/apps/admin-api/src/modules/scheduler/scheduler-metrics.service.ts
+++ b/apps/admin-api/src/modules/scheduler/scheduler-metrics.service.ts
@@ public interface SchedulerMetricsSnapshot {
   /** B-6：misfire 补偿因依赖未满足被跳过数（依赖闸，非故障态） */
   misfiresSkippedDependencies: number;
+  /**
+   * INCIDENT-2026-10-28：**计划落点被丢弃**的次数（node-cron
+   * execution:missed 事件计数）。与 triggersFailed 语义不同——后者是
+   * "触发了但入队失败"，本计数是"压根没触发"。
+   *
+   * 这是本次事故唯一能直接反映"丢了一个落点"的指标：12:00 丢点时，
+   * task_executions 里没有行、misfire 告警静默、日志里什么都没有。
+   */
+  cronSlotsMissed: number;
   triggersFailed: number;
@@ private misfiresSkippedDependencies = 0;
+  private cronSlotsMissed = 0;
   private triggersFailed = 0;
@@ /** B-6: 记录一次 misfire 补偿因"依赖未满足"被跳过（预期态，非故障） */
   recordMisfireSkippedDependencies(): void {
     this.misfiresSkippedDependencies++;
   }
 
+  /**
+   * INCIDENT-2026-10-28：记录一个被引擎丢弃的计划落点。
+   *
+   * 触发来源：node-cron 的 `execution:missed` 事件——定时器迟醒超过
+   * `missedExecutionTolerance` 时派发。正常情况下恒为 0；非 0 即说明
+   * 事件循环曾被阻塞到丢拍，是本次事故类问题的直接信号。
+   */
+  recordCronSlotMissed(): void {
+    this.cronSlotsMissed++;
+  }
+
   /** 记录一次触发失败（入队/补偿失败等） */
   recordTriggerFailed(): void {
     this.triggersFailed++;
   }
@@ get snapshot(): SchedulerMetricsSnapshot {
       misfiresSkippedDependencies: this.misfiresSkippedDependencies,
+      cronSlotsMissed: this.cronSlotsMissed,
       triggersFailed: this.triggersFailed,
```

**告警建议**：`cronSlotsMissed` 是单调计数，适合做"5 分钟内增量 > 0 即告警"。
这是**唯一一个"丢了就一定能看到"**的信号，优先于 P1-1 的落点对账（后者是
兜底，能覆盖"连引擎都没跑起来"的情形）。

---

## 4. P0-2：日志异步化 + 有界丢弃

### 4.1 目标

切断这条链：

```
盘 IO 抖动 → Node 主线程 writeSync(fd1) 阻塞 → 事件循环钉住 40s
          → watchdog setInterval 一次没跑 → leader 租约 30s 过期 → demote
```

**只要主线程不再同步写盘，这条链就断了**——即使盘还在抖，事件循环照常跑，
watchdog 照常续期，租约不会丢。

### 4.2 实现（`main.ts`）

核心是：`fs.createWriteStream({ fd: 1 })` **+ 有界队列**。不能裸用，因为
§1.1 实测它会把内存堆到 125MB 且无上界。

```diff
--- a/apps/admin-api/src/main.ts
+++ b/apps/admin-api/src/main.ts
@@
+/**
+ * INCIDENT-2026-10-28：把 stdout 从「同步写」换成「异步写 + 有界丢弃」。
+ *
+ * 背景：`nohup node dist/main.js &>> AutoCodeFlow.log` 让 fd1 指向普通文件，
+ * Node 对此实现为 SyncWriteStream——每次 console.log 都是主线程上的
+ * writeSync(2)。盘一旦 stall（本机 Redis AOF fsync 历史累计 1018 次超时），
+ * 主线程被钉住，定时器/watchdog/HTTP 全部停摆。10-28 11:59 因此冻结 40s，
+ * 打穿 30s 的 Leader 租约。
+ *
+ * 为什么不是简单的 createWriteStream：实测连续写 128MB 时主线程确实不阻塞了，
+ * 但 writableLength 堆到 125MB 且无上界。这台机器 7.6GB 内存 +
+ * overcommit_memory=1 + Swap 已用 2.3GB，无界堆积会招来 OOM killer。
+ *
+ * 因此：超过 MAX_BUFFERED_BYTES 的日志**直接丢弃并计数**。日志是诊断手段，
+ * 不是业务数据——宁可丢日志也不能 OOM。丢弃期间的首末各打一条自身日志
+ * （走 stderr，不受本开关影响）。
+ *
+ * 开关：LOG_ASYNC_STDOUT（默认 true）。设为 false 恢复旧行为，用于排查
+ * 「日志本身丢太多」的现场。
+ */
+/**
+ * INCIDENT-2026-10-28：把 stdout **与 stderr** 从「同步写」换成「异步写 + 有界丢弃」。
+ *
+ * 背景：`nohup node dist/main.js &>> AutoCodeFlow.log` 让 fd1/fd2 都指向普通
+ * 文件，Node 对此实现为 SyncWriteStream——每次 console.log 都是主线程上的
+ * writeSync(2)。盘一旦 stall（本机 Redis AOF fsync 历史累计 1018 次超时），
+ * 主线程被钉住，定时器/watchdog/HTTP 全部停摆。10-28 11:59 因此冻结 40s，
+ * 打穿 30s 的 Leader 租约。
+ *
+ * 为什么 stderr 必须一起改（评审意见）：Nest 的 `Logger.error` / `fatal` 走
+ * stderr（`console-logger.service.js:103,141` 的 writeStreamType='stderr'），
+ * 而本仓 `main.ts` 的 `logFatal()` 全部走 `Logger.error`——**那恰恰是最需要
+ * 可靠落盘的时刻**（启动校验失败、bootstrap 崩溃、未捕获异常）。只改 stdout
+ * 等于把放大器切断了一半。
+ *
+ * 为什么不是简单的 createWriteStream：实测连续写 128MB 时主线程确实不阻塞了，
+ * 但 writableLength 堆到 125MB 且无上界。这台机器 7.6GB 内存 +
+ * overcommit_memory=1 + Swap 已用 2.3GB，无界堆积会招来 OOM killer。
+ *
+ * 因此：超过 MAX_BUFFERED_BYTES 的日志**直接丢弃并计数**。日志是诊断手段，
+ * 不是业务数据——宁可丢日志也不能 OOM。丢弃期间的首末各打一条自身日志
+ * （写原始 fd，绕过被替换的 write，避免递归）。
+ *
+ * 开关：LOG_ASYNC_STDOUT（默认 true）。设为 false 恢复旧行为，用于排查
+ * 「日志本身丢太多」的现场。
+ */
+export function installAsyncStdout(): void {
+  const MAX_BUFFERED_BYTES = 8 * 1024 * 1024; // 8MB ≈ 数万行 JSON
+  if (process.env.LOG_ASYNC_STDOUT === "false") return;
+
+  // 原始 fd 写：用于 sink 自身的错误/丢弃告警，绕过被替换的 write 防递归。
+  const rawWrite = (fd: number, text: string): void => {
+    try {
+      fs.writeSync(fd, text);
+    } catch {
+      /* 诊断通道，失败即放弃 */
+    }
+  };
+
+  const install = (name: "stdout" | "stderr", fd: 1 | 2): void => {
+    const stream = process[name];
+    // 只在目标指向普通文件时介入：管道/socket 本来就是异步的（实测
+    // constructor.name === 'Socket'），替换反而丢掉 backpressure。
+    if (stream.constructor.name !== "SyncWriteStream") return;
+
+    const sink = fs.createWriteStream(null, { fd, autoClose: false });
+    sink.on("error", (err: Error) => {
+      rawWrite(2, `[async-${name}] sink error: ${err.message}\n`);
+    });
+
+    let dropped = 0;
+    (stream as any).write = ((
+      chunk: string | Buffer,
+      encoding?: BufferEncoding | ((err?: Error | null) => void),
+      cb?: (err?: Error | null) => void,
+    ): boolean => {
+      if (sink.writableLength > MAX_BUFFERED_BYTES) {
+        dropped += 1;
+        if (dropped === 1 || dropped % 10_000 === 0) {
+          rawWrite(
+            2,
+            `[async-${name}] sink backlog ${sink.writableLength}B exceeds ` +
+              `${MAX_BUFFERED_BYTES}B — dropped ${dropped} log line(s) so far ` +
+              `(disk is stalling)\n`,
+          );
+        }
+        const done = typeof encoding === "function" ? encoding : cb;
+        if (done) process.nextTick(done);
+        return true; // 声称已接受，避免调用方因 false 而重试
+      }
+      return typeof encoding === "function"
+        ? sink.write(chunk, encoding)
+        : sink.write(chunk, encoding as BufferEncoding | undefined, cb);
+    }) as typeof stream.write;
+
+    // 退出前排空，避免尾部日志丢失（进程退出时 sink 可能还有积压）
+    const flush = () => {
+      try {
+        sink.end();
+      } catch {
+        /* 退出路径尽力而为 */
+      }
+    };
+    process.on("exit", flush);
+    process.on("beforeExit", flush);
+  };
+
+  // 顺序：先 stderr 再 stdout——若 stdout 的 sink 创建失败，stderr 已可用，
+  // 告警不会因 stdout 安装失败而丢失。
+  install("stderr", 2);
+  install("stdout", 1);
+}
```

在**模块级顶层**调用，位置紧跟 `loadEnvFile(...)` 之后：

```diff
 import { config as loadEnvFile } from "dotenv";
 loadEnvFile({ path: path.resolve(__dirname, "..", ".env") });
+// INCIDENT-2026-10-28：stdout 异步化必须**早于任何日志输出**。
+// 放在模块级而非 bootstrap() 开头——后者晚于所有 import 的模块体求值。
+installAsyncStdout();
 const importAppModule = async () => (await import("./app.module")).AppModule;
```

#### ⚠️ 为什么是模块级：`bootstrap()` 开头已经太晚

这是生产端指出、我实测确认的一点。TS 编译为 CommonJS（`apps/admin-api/tsconfig.json`
的 `"module": "commonjs"`）后，**所有静态 `import` 都被提升为文件顶部的
`require()`**——它们**先于**任何模块级语句执行。实测：

```
$ node main.js          # dep.js 由 require 加载
[dep] 模块体执行        ← 先
[main] 模块级语句执行    ← 后
[main] bootstrap() 执行  ← 最后
```

所以把 `installAsyncStdout()` 放在 `bootstrap()` 第一行，意味着 `app.module`、
`configuration.ts` 等模块的**模块体求值期日志**全部走同步写。生产上这些日志
虽然量小，但 `configuration.ts:179/189/477` 的启动期校验会在配置错误时
`throw` 并触发 `logFatal`——**恰恰是最需要可靠落盘的时刻**。

> 补充一个边界（诚实说明）：`loadEnvFile` 之上的那些 `import`（`@nestjs/core`、
> `helmet`、`typeorm` 等）在模块级语句之前就已求值，`installAsyncStdout()`
> 拦不到它们。但第三方库的模块体日志极少，且本仓 `src` 内静态 import 的模块
> （`shutdown-guard.util.ts` 等）经核实**模块体均不打日志**（logger 只在函数内
> 使用）。所以模块级放置已经覆盖了实际存在的全部启动期日志。

#### ⚠️ 替换 `process.stdout.write` 的有效性已实测，并需单测固化

这是 P0-2 生效的前提。实测（Node v24.21.0）：

```
1. 赋值前 ctor = SyncWriteStream
2. 赋值后 ctor = SyncWriteStream          ← 原型不变
3. process.stdout.write 是自有属性? true   ← 实例上的赋值生效
4. 自定义 write 被调用次数 = 1             ← 确实拦到了
```

另外确认了 Nest `ConsoleLogger` 的写出方式（`@nestjs/common/services/
console-logger.service.js:234,252`）：

```js
process[writeStreamType ?? 'stdout'].write(formattedMessage);
```

是**运行时查属性**，不是提前绑定的引用——所以替换 `process.stdout.write`
能拦到 Nest 的全部日志（`log`/`warn`/`debug`/`verbose` 走 stdout）。

**`error` / `fatal` 走 stderr**（`console-logger.service.js:103,141` 传入
`writeStreamType='stderr'`，最终落到 252 行的 `process[type].write(...)`）。
**必须一起改**，理由在评审中被指出且成立：

- 本仓 `main.ts` 的 `logFatal()` 全部走 `Logger.error`（`dist/main.js:67` 起
  的 5 个分支都是 `Logger.error(...)`）；
- 它的用途正是**启动校验失败 / bootstrap 崩溃 / 未捕获异常**——最需要可靠
  落盘的时刻；
- 只改 stdout 等于把放大器切断一半，stderr 上的同步写照样能钉住事件循环。

所以实现里用 `install(name, fd)` 对 `stdout`/`stderr` 各跑一遍。**顺序是先
stderr 后 stdout**：若 stdout 的 sink 创建失败，stderr 已就位，告警不会丢。

单测固化（`apps/admin-api/src/__tests__/`，新建）：

```ts
describe("installAsyncStdout (INCIDENT-2026-10-28)", () => {
  let saved: Array<[NodeJS.WriteStream, PropertyDescriptor]>;

  beforeEach(() => {
    saved = [process.stdout, process.stderr].map((s) => [
      s,
      Object.getOwnPropertyDescriptor(s, "write")!,
    ]);
  });
  afterEach(() => {
    // 必须恢复：本改动直接改全局 stream，jest 同进程跑会污染其它 spec
    for (const [s, d] of saved) Object.defineProperty(s, "write", d);
  });

  it("在普通文件 fd1/fd2 上确实替换了 write", () => {
    // 该断言固化「赋值有效」这一前提：若将来 Node 把 SyncWriteStream 的
    // write 改成不可写属性，本改动会静默失效——必须让 CI 拦住。
    const before = saved.map(([, d]) => d.value);
    installAsyncStdout();
    const after = [process.stdout, process.stderr].map(
      (s) => Object.getOwnPropertyDescriptor(s, "write")?.value,
    );
    expect(after[0]).not.toBe(before[0]);
    expect(after[1]).not.toBe(before[1]); // stderr 也必须被替换
  });

  it("LOG_ASYNC_STDOUT=false 时不介入", () => {
    process.env.LOG_ASYNC_STDOUT = "false";
    const before = saved.map(([, d]) => d.value);
    installAsyncStdout();
    expect(
      [process.stdout, process.stderr].map(
        (s) => Object.getOwnPropertyDescriptor(s, "write")?.value,
      ),
    ).toEqual(before);
    delete process.env.LOG_ASYNC_STDOUT;
  });

  it("目标是管道时不介入（保留 backpressure）", () => {
    // jest 环境下 stdout 常为管道，installAsyncStdout 应直接短路
    // 断言 write 未被替换
  });
});
```

> ⚠️ 该 spec 会修改全局 `process.stdout` / `process.stderr`，必须**在
> `afterEach` 恢复**，否则会污染同进程的其它用例（本仓 jest 默认同进程跑
> spec 文件）。


### 4.3 必须同时做的部署侧改动

**这是最关键的一点：代码修了，如果生产仍用 `nohup &>>`，`installAsyncStdout()`
会生效（因为 fd1 是文件，会命中 SyncWriteStream 分支），但更彻底的做法是消除部署漂移。**

现状（生产端已确认）：

| 部署路径 | stdout 目标 | 写模式 | 能否在 journal 里查到 |
|---|---|---|---|
| `deploy.sh:1079` systemd | `StandardOutput=journal` | 异步（socket） | ✅ |
| 生产（宝塔 `AutoCodeFlow.sh`） | `nohup ... &>> AutoCodeFlow.log` | **同步** | ❌ |

**建议**：生产改用 `deploy.sh` 的 systemd 路径，或把宝塔脚本改成等价的
`StandardOutput` 形态。理由不只是性能——10-24 事故复盘时
`journalctl` 里**一行 admin-api 的记录都没有**，因为 `nohup` 根本不进 journald。
**这是可观测性的硬缺口，不是优化项。**

若不改部署，`installAsyncStdout()` 仍能切断阻塞链，但保留两个问题：
① 日志无轮转（`AutoCodeFlow.log` 已 345MB）；
② 进程崩溃/重启的现场在 journal 里查不到。

#### ⚠️ 变更窗口：必须避开整点前 5 分钟

**这是本次事故教训的直接推论，不是一般性的"避开高峰"。**

单实例部署下，重启期间调度器**完全停摆**——没有第二个实例接管。若重启恰好
跨越某个 cron 落点，那一拍就是一次**新的丢点**，与本次事故同源。

生产环境实际落点分布（来自事故报告 §8）：

| 表达式 | 任务数 | 落点 |
|---|---|---|
| `0 8,12,17 * * *` | 5 | 08:00 / 12:00 / 17:00 |
| `0 12,18 * * *` | 2 | 12:00 / 18:00 |
| `0 10,12,14,16,18 * * *` | 8 | 每 2 小时的偶数点 |
| `0 6-23 * * *` | 1 | 每小时整点 |
| 其余 | 40 | 分散，含整点与半点 |

**约束**：变更窗口应落在 `HH:05 ~ HH:55` 之间的、且**前后各留 5 分钟**无落点的
区段。以当前任务集为例，安全窗口是 **每小时的 :05 ~ :55**（`0 6-23 * * *` 的
考勤任务在整点，其余长周期任务都在偶数小时整点）。

**建议操作顺序**：
1. 先上线**代码改动**（P0-1/P0-3/P2-2，走常规重启，同样遵守上述窗口）
2. 观察 `cronSlotsMissed == 0` 且 `activeCronTasks` 稳定 1~2 个落点周期
3. **再**做部署方式变更（宝塔 → systemd），因为它需要再次重启

> 若确实必须在整点前重启，可临时 `pause` 受影响任务并在重启后 `resume`——
> 但注意 `pause/resume` 本身会触发 `scheduleOne` 重排，等价于一次注册，
> 反而可能引入新的落点漂移。**不如直接选好窗口。**

### 4.4 风险

| 风险 | 缓解 |
|---|---|
| 盘持续卡住时丢日志，可能丢掉关键诊断信息 | 丢弃计数 + 首末告警走 stderr；`LOG_ASYNC_STDOUT=false` 可回退 |
| `sink.end()` 在 exit 钩子里可能不完整 | 尽力而为；journald 路径本身有 `TimeoutStopSec=60` |
| 替换 `process.stdout.write` / `process.stderr.write` 影响 Nest `ConsoleLogger` | 已核实 `ConsoleLogger` 用 `process[type].write()` 运行时查属性（§4.2），签名按 Node 的 3 参重载实现 |
| 单元测试里 stdout 是 TTY/管道 | 已用 `constructor.name !== 'SyncWriteStream'` 短路，测试环境不介入 |
| **stderr 也已纳入**（原为"已知缺口"，评审后改为一起修） | `logFatal` 全部走 `Logger.error` → stderr（`console-logger.service.js:103,141`），不改等于 P0-2 只切一半。现 `install('stderr', 2)` 与 stdout 同一套逻辑 |
| **sink 自身告警的递归风险** | 丢弃告警与 sink error 用 `fs.writeSync(2, ...)` 直接写原始 fd，绕过被替换的 write |
| **已知缺口：`loadEnvFile` 之上的 import 期日志拦不到** | 见 §4.2 说明；本仓静态 import 的模块经核实模块体不打日志 |

---

## 5. P1：可观测性

### 5.1 P1-1 落点对账告警（当前完全缺失）

**现状**：`checkMisfiresBody()`（`scheduler.service.ts:664`）对 `IGNORE` 策略
只 `logger.warn`（748 行），**不计数、不告警、不建行**。而生产端已确认
**84/84 任务全是 `ignore`，`fire_once` 零使用**——所以 `fire_once` 补偿分支
（690–745 行）在整套系统里是**死代码**。

**含义**：当前系统**没有任何漏跑检测能力**。12:00 丢点时，唯一的记录是
"执行表里没有行"，需要人工去查。

**方案**：新增一个独立的落点对账 tick，不依赖 misfire 阈值那套启发式：

```diff
+  /**
+   * INCIDENT-2026-10-28：漏跑落点对账。
+   *
+   * 与 checkMisfires 的区别：本方法**不做补偿**（业务侧 2026-10-28 已明确：
+   * 默认只告警不补跑——汇总任务是日报，补跑会造成数据时序错乱，且单次运行
+   * 1.8~44 分钟可能与下一批撞车；详见本文档 §10），只负责
+   * 把"计划落点存在但没执行"这件事变成指标 + 告警。
+   *
+   * 判据直接来自 lastWindowCronFireBefore（与 cronHasMissedFirePoint 同源），
+   * 不用 2×周期 那套启发式——那套对多点 cron 的语义是错的（0 8,12,17 会被
+   * 算成 10h 甚至 30h 阈值，12:00 丢点静默，而每晚 03:00~08:00 误报 59 条）。
+   *
+   * 排除项：维护窗口内的落点不算漏跑（否则每个窗口都要告警）。
+   */
+  @Cron("0 */5 * * * *")
+  async auditCronSlots() {
+    if (!this.isLeader) return;
+    await this.guardTick("auditCronSlots", () => this.auditCronSlotsBody());
+  }
+
+  private async auditCronSlotsBody(): Promise<void> {
+    const now = new Date();
+    const GRACE_MS = 90_000;  // 给事件循环抖动留余量
+    // ... keyset 分页扫 ACTIVE + triggerType=CRON + lastTriggerTime 非空
+    // 对每个任务：
+    //   const lastFire = lastWindowCronFireBefore(expr, now, LOOKBACK, tz);
+    //   if (!lastFire) continue;                       // 解析失败/回看不足
+    //   if (now.getTime() - lastFire.getTime() < GRACE_MS) continue;  // 还没到点
+    //   if (lastFire.getTime() <= lastTriggerTime.getTime()) continue; // 跑过了
+    //   if (findActiveMaintenanceWindow(task.maintenanceWindows, lastFire, tz)) continue;
+    //   → logger.warn + recordCronSlotMissed() + 可选飞书告警
+  }
```

**注意**：`lastWindowCronFireBefore` 的默认 lookback 是
`MAINTENANCE_WINDOW_LOOKBACK_MINUTES`（7 天），逐分钟回扫。每 5 分钟对全部
active cron 任务跑一遍是有成本的，但有 `FIRE_SCAN_CACHE`（按分钟戳缓存，
`maintenance-window.util.ts:295`）兜底，同分钟内重复调用不重扫。

### 5.2 P1-2 event-loop lag

**现状**：全仓 `grep monitorEventLoopDelay|perf_hooks|eventLoopLag` → **0 命中**（已核实，
只有 `@types/node` 的类型声明）。本次事故应用侧**零数据留存**，时间线全靠 nginx /
PG / redis 三条外部证据交叉对齐。

```diff
+// 新文件 apps/admin-api/src/common/metrics/event-loop-lag.service.ts
+import { monitorEventLoopDelay, PerformanceObserver } from "node:perf_hooks";
+
+@Injectable()
+export class EventLoopLagService implements OnModuleInit, OnModuleDestroy {
+  private histogram = monitorEventLoopDelay({ resolution: 20 });
+  private timer: NodeJS.Timeout | null = null;
+  private lastMaxMs = 0;
+
+  onModuleInit() {
+    this.histogram.enable();
+    this.timer = setInterval(() => {
+      const maxMs = this.histogram.max / 1e6;
+      const p99Ms = this.histogram.percentile(99) / 1e6;
+      this.lastMaxMs = Math.max(this.lastMaxMs, maxMs);
+      if (maxMs > 1_000) {
+        this.logger.warn(
+          `Event loop blocked for ${maxMs.toFixed(0)}ms (p99=${p99Ms.toFixed(0)}ms) — ` +
+            `watchdog/scheduler timers may have been starved`,
+        );
+      }
+      this.histogram.reset();
+    }, 30_000);
+    this.timer.unref();
+  }
+  // 暴露到 /api/metrics/scheduler 的 eventLoopMaxMs / eventLoopP99Ms
+}
```

**`> 1000ms` 阈值**：引擎的 `missedExecutionTolerance` 最小 1s，超过即意味着
可能有落点被丢。这个阈值直接对齐故障语义，比拍脑袋的百分比更可操作。

### 5.3 P1-3 Leader TTL 解耦

**现状**（`scheduler.service.ts:73-75`）：

```ts
export const SCHEDULER_LEADER_TTL_MS = 30_000;      // 硬编码，不可配
export const SCHEDULER_LEADER_RETRY_MS = 15_000;    // 硬编码
```

校验周期是 `TTL / 2`（`scheduler.service.ts:503`），所以 **TTL 一改，校验周期
跟着变**——生产端原报告建议 TTL→90s 但漏了这点：90s 会让校验变 **45s**，
真故障时切换反而更慢。

```diff
+/** INCIDENT-2026-10-28：租约 TTL 与校验周期解耦（此前校验 = TTL/2）。 */
+export const SCHEDULER_LEADER_TTL_MS = 90_000;
+export const SCHEDULER_LEADER_RETRY_MS = 3_000;
+/** 校验周期固定 15s——不随 TTL 变化，否则 TTL 越长切换越慢。 */
+export const SCHEDULER_LEADER_VERIFY_MS = 15_000;
+/** 连续 N 次 extendLock 失败才 demote（容忍单次网络抖动）。 */
+export const SCHEDULER_LEADER_VERIFY_MAX_FAILURES = 2;
@@ startLeaderVerification()
-    }, SCHEDULER_LEADER_TTL_MS / 2);
+    }, SCHEDULER_LEADER_VERIFY_MS);
```

**P0-1 之后误 demote 已不致命**（定时器保命），所以这里可以放宽。

⚠️ **同步改 `.env.example:130` 附近的配置段**——目前 `SCHEDULER_*` 只有
`RECONCILE_EVERY` 一项。若要让 TTL 可配，需在 `configuration.ts:491` 的
`scheduler` 节新增键，并注意 `env.ts` 的 `no-restricted-properties` 约定：
**运行时代码禁止直接读 `process.env`**，必须走 `ConfigService`。

---

## 6. P2：降噪

### 6.1 P2-1 misfire 落点判定为主判据

**现状**（`scheduler.service.ts:320-337`）：`computeMisfireThresholdMs` =
`2 × estimateCronPeriodMs`，而 `estimateCronPeriodMs`（256-306 行）取的是
**"最近两个落点"的间隔**——对多点 cron 会随当前时刻漂移：

| 表达式 | 09:00 时算得 | 12:30 时算得 | 阈值 |
|---|---|---|---|
| `0 8,12,17 * * *` | latest=08:00, prev=前一天17:00 → 15h | latest=12:00, prev=08:00 → 4h | **30h / 8h** |

同一表达式不同时刻阈值不同，还有 10 分钟 TTL 缓存
（`CRON_PERIOD_ESTIMATE_TTL_MS`）让漂移更不可预测。

**正确的判定函数 `cronHasMissedFirePoint()` 已经存在**（`scheduler.service.ts:620-634`），
但**只在 `FIRE_ONCE` 分支被调用**（715 行），`ignore` 分支只打日志（748 行）。

改法：把落点校验提为主判据，`2×周期` 降级为粗筛。因为 `fire_once` 是死代码
（§5.1），**实际收益是"让告警落在正确的时刻"**——与 P1-1 有重叠，可择一实施。

### 6.2 P2-2 manual/webhook 前置过滤（一行）

```diff
@@ private async checkMisfiresBody()
       for (const task of tasks) {
         if (!task.lastTriggerTime) continue;
+        // INCIDENT-2026-10-28：manual/api/webhook 任务没有"计划落点"，
+        // computeMisfireThresholdMs 对它们恒返回 2min → 只要 2 分钟没跑就被
+        // 判 misfire。实测 2.4 天产生 12,342 条告警（单任务最高 570 条），
+        // 真丢点被完全淹没。只对真正有周期语义的触发类型做判定。
+        if (
+          task.triggerType !== TaskTriggerType.CRON &&
+          task.triggerType !== TaskTriggerType.FIXED_RATE
+        ) {
+          continue;
+        }
         const gap = now - task.lastTriggerTime.getTime();
```

**成本最低、收益最直接**，建议无论如何都做。

---

## 7. 部署侧（与 P0-2 同期，否则代码修了也白修）

### 7.1 消除部署漂移

生产改用 systemd 路径，或把宝塔 `AutoCodeFlow.sh` 改成 `StandardOutput` 形态。
`deploy.sh:1185-1206` 的 unit 模板已经是正确的（`StandardOutput=journal`），
**问题是生产没走它**。

### 7.2 日志轮转

`AutoCodeFlow.log` 已 345MB，无轮转。改 journald 后由 journald 统一管理
（`SystemMaxUse=`）；不改的话至少加 logrotate。

### 7.3 运维项（降频，非根治）

生产端原报告 §7⑧⑨⑩⑪⑫ 的运维项**方向都对**，但需要明确它们全是"降低触发
频率"，不改变故障机制：

- ⑧ CLIProxyAPI 限内存：先确认 5.5~5.8GB 是不是正常工作集，否则限 2g 只是
  把它变成"每 10 分钟 OOM 一次"
- ⑨ 拆分 IO：Redis `save 300 10` → `save 900 1`、`no-appendfsync-on-rewrite yes`、
  nginx `access_log ... buffer=64k flush=5s`
- ⑪ `track_io_timing = on`（现在 off，无法定位 IO 延迟）
- ⑫ 向主机商要说法：5 次非正常关机 / 14 天、60 次稳态 soft lockup

---

## 8. 验证矩阵

| 场景 | 期望 | 验证方式 |
|---|---|---|
| 事件循环冻结 28s，整分前结束 | 12:00 正常触发 | 注入 `Atomics.wait` 阻塞 28s，跨 12:00:00 前恢复 |
| 事件循环冻结 40s，**跨过整分** | P0-3 补跑 12:00 落点 | 同上，冻结区间覆盖整分 |
| demote → 30s 后 promote | 定时器全程存活，落点不丢 | 单测（§2.4） |
| 盘 stall（`SyncWriteStream` 阻塞） | 事件循环存活，租约不丢 | 用 FIFO 慢读者模拟（本机已验证手法） |
| 日志 sink 积压 > 8MB | 丢日志但进程存活 | 灌 100MB 日志 + 慢 sink |
| 重启后首次竞选成功 | 立即重建调度表 | 单测：`tryAcquireLeadership` 断言 `reloadActiveTasks` 被调用 |
| 定时器迟醒 20s（跨整分） | 落点照常执行，`cronSlotsMissed` 不增 | 单测：mock `Date` 前推 20s 后触发 heartbeat |
| 定时器迟醒 40s（超 tolerance） | `cronSlotsMissed` +1，日志含丢失落点时间 | 同上，前推 40s |
| **`schedule()` 同步 start 的首拍** | 首拍 missed 也能被收到 | 单测：断言用 `createTask` 而非 `schedule`（§3.3） |
| **demote 时某任务正卡在回调中** | `runningTasks` 被清空，该任务下次落点照常触发 | 单测：置 `runningTasks.set(id,true)` → `demote()` → 断言 `size===0` 且下次 fire 不被 skip |
| **`installAsyncStdout` 确实替换了 write** | 赋值生效（P0-2 的前提） | 单测：断言 `getOwnPropertyDescriptor(process.stdout,'write')` 变化（§4.2） |

> ⚠️ 第 4 行（盘 stall）本机已验证手法：用 FIFO + 慢读者替代真实磁盘。
> 但注意**普通本地文件系统难以复现**——实测写普通文件 400×64KB 主线程只花
> 19ms，因为本地盘有 page cache。真实 stall 需要 `cgroup` IO 限速或
> `dm-delay`。**这条验证更适合在 staging 做，不宜作为 CI 门禁。**

---

## 9. 实施顺序建议

1. **P2-2**（一行，零风险）→ 立刻消掉 12,342 条噪音，让后续验证看得见信号
2. **P0-1 + `runningTasks.clear()` + 代际标记 + spec**（核心兜底，风险已评估）
3. **P0-3 + metrics**（一行配置 + 一个回调 + 一个计数器）→ 落地后**下次丢点一定能看到**
4. **P1-2 event-loop lag**（下次事故不再靠外部证据反推）
5. **P0-2 代码改动**（stdout **+ stderr** 双流，模块级安装，走常规重启——
   **仍须避开整点前 5 分钟**）
6. **P0-2 部署改造**（宝塔 → systemd，需再次重启，同样选窗口）
7. **P1-1 / P1-3 / P2-1**（视评审结论）

**为什么 P0-3 要排在 P0-2 之前**：P0-2 要动生产启动方式（宝塔 → systemd），
需要变更窗口和回滚预案；而 P0-3 是纯代码改动，且落地后能立刻验证
"`cronSlotsMissed` 是否为 0"。先有观测手段，再动部署，出问题时才能判断
是"没修好"还是"改坏了"。

**第 5 与第 6 拆开的原因**：两者都要重启，但风险等级不同。代码改动可随
常规发布走；部署方式变更涉及进程托管切换，失败时回滚成本更高。**分开做，
中间留一个观察期**，避免两次变更的故障信号混在一起。

> ⚠️ **部署改造必须等 stderr 处理完再排期**（评审意见，已采纳）：若只改了
> stdout 就切 systemd，虽然 journald 本身是异步的、冻结面已大幅缩小，但
> `logFatal` 那条 stderr 同步写路径在"宝塔 nohup + 文件"形态下仍是活的。
> 两件事一起做才能宣称"放大器已切断"。

---

## 10. 已决：补偿策略（业务侧已表态，2026-10-28）

**结论：默认只告警，不自动补跑。**

业务侧给出的理由（两条，都成立）：

1. **汇总任务是日报，补跑会造成数据时序错乱。** 例如 `0 8,12,17` 的五个
   "退货退款差评汇总"任务——12:00 那拍在 13:00 补跑，产出的是一份标着
   12:00 但数据截止 13:00 的日报，与 17:00 那拍的统计口径重叠。
2. **单次运行 1.8~44 分钟，补跑可能与下一批撞车。** 补跑占用执行器槽位，
   若正好压在下一次落点上，会挤掉正常的下一拍——把"丢一拍"放大成"丢两拍"。

**因此**：

- `misfireStrategy` **保持全局默认 `ignore`**（现状 84/84），不改实体默认值。
- `checkMisfires` 的 `FIRE_ONCE` 补偿分支继续作为**显式 opt-in**保留，
  但不得有任务默认走进去。
- **唯一例外**：**考勤数据统计**（`0 6-23 * * *`）可作 opt-in 试点。理由：
  它是幂等的周期性快照（每小时重算当天考勤），补跑不产生口径重叠，且单次
  运行时长短。试点期间观察补跑是否挤压相邻落点。
- 检测能力（P1-1 落点对账 + §3.5 的 `cronSlotsMissed`）**与补偿解耦**，
  无论补偿开不开都必须上线——否则丢点依然无声。

> 这条决策同时简化了 P2-1：既然不做自动补偿，`cronHasMissedFirePoint`
> 的价值就从"决定是否补偿"变成"决定是否告警"，实现更简单，风险更低。

---

## 11. 仍待确认

1. **`error` 级别日志是否也需要异步化** —— **已决**：评审后改为一起修
   （§4.2 的 `install('stderr', 2)`）。此项关闭。
2. **10-24 的 Redis 阻塞根因**：`heartbeat`/`pull` 的 499 集中在 BullMQ
   依赖路径，而 BullMQ 连接配置是 `maxRetriesPerRequest: null` +
   `enableOfflineQueue: true`（`app.module.ts:628,635`）——**离线队列期间
   `queue.add` 会一直挂起，不设上限**。这与 `redis-lock.service.ts` 的
   `commandTimeout: 3000` 是两套不同配置。若 10-24 的阻塞源是 Redis 本身，
   这条链值得单独排查（不在本次 P0 范围）。
3. **【新】`queue.add()` 挂起后恢复的残余重复执行**（§2.5.5 记录的残余风险）。
   代际标记覆盖不到，`jobId` 又不能加（§2.5.4）。

   **方案已收敛：worker 侧拒 claim**（评审后确定，优于 Redis 侧撤 job）。

   理由：`queue.getJob(exec.id)` 依赖 `jobId`，而 §2.5.4 已证明不能加。
   worker 侧判定不需要任何 Redis 依赖，且判定所需的信息都在行上。

   #### 判据（修正生产端提案）

   生产端建议 `status=FAILED AND failureReason=NEVER_DISPATCHED AND
   retryCount >= maxRetry`。**前两个条件对，第三个条件失效**，原因：

   - `retryCount` 只在**创建新执行行**时递增（`executor.service.ts:1560,1585`
     的 `retryCount: nextRetryCount`），每次重试都是**新 uuid 的新行**；
   - 僵尸行本身从未被重试过 → 它的 `retryCount` 恒为 **0**（实体默认值，
     `task-execution.entity.ts:246`）；
   - `maxRetry` 通常 ≥ 1（`attempts: Math.max(1, task.maxRetry ?? 1)`）；
   - 所以 `0 >= 1` 恒为 false → **判据永不命中，僵尸行照跑**。

   `retryCount` 的语义是"这一行被重试过几次"，不是"这个任务还能重试几次"，
   在僵尸行场景下不携带任何信息。

   #### 正确判据：只靠 `NEVER_DISPATCHED`

   ```ts
   // task.processor.ts handle() 内，claim 之前
   // INCIDENT-2026-10-28 §11.3：拒绝"僵尸复活"。
   // NEVER_DISPATCHED 只有两个写入点，都在 admin 内部终态化：
   //   · scheduler.service.ts:1127 — stale PENDING sweep（>10min 未派发）
   //   · scheduler.service.ts:1904 — queue.add() 抛错补偿
   // 后者不会产生僵尸 job（add 已抛错），所以命中的一定是前者。
   if (
     exec.status === ExecutionStatus.FAILED &&
     exec.failureReason === ExecutionFailureReason.NEVER_DISPATCHED
   ) {
     this.logger.warn(
       `Execution ${executionId} was marked NEVER_DISPATCHED by the stale sweep ` +
         `but a job arrived later — refusing to claim (INCIDENT-2026-10-28)`,
     );
     return;
   }
   ```

   **为什么不挡合法重试**（逐一核对过）：

   | 路径 | 行状态 | 会不会被误挡 |
   |---|---|---|
   | BullMQ `attempts` 重试 | `FAILED`，`failureReason` 由失败分类链写（`script_error`/`timeout`/…） | ❌ 不挡（不是 NEVER_DISPATCHED） |
   | `scheduleRetryAfterRecovery` | 新建 `PENDING` 行（新 uuid） | ❌ 不挡（新行 status=PENDING） |
   | mutex 唤醒 | `PENDING`（条件 UPDATE 翻转） | ❌ 不挡 |
   | **僵尸 job 复活** | `FAILED` + `NEVER_DISPATCHED` | ✅ 挡（这正是目标） |

   `NEVER_DISPATCHED` 在 `ADMIN_INTERNAL_FAILURE_REASONS` 里
   （`task-execution.entity.ts:133`），执行器**不可能**上报这个值——所以它
   作为"admin 自己判死"的标记是可靠的，不会被外部路径伪造。

   **风险**：若将来有人让 `NEVER_DISPATCHED` 也用于"可重试的入队失败"，
   本判据会误挡。需在该处加注释约束。

   **建议**：作为独立条目评估，**不阻塞 P0-1 落地**。
