# ADR-037: 心跳计数下限并入同一条 UPDATE —— 并否掉「claim 与建行同事务」

状态：Accepted（设计裁决；实现未落地）
- 日期：2026-11-06
- 触发：R18-B 复现（`heartbeat-dispatch-race-selftest.mjs` 20/20 轮违反）
- 相关 ADR：[ADR-016](adr-016-executor-control-plane-pull.md)（执行器控制面拉取）· [ADR-030](adr-030-executor-token-cross-instance-idempotency.md)（跨实例幂等）
- 前序裁定：R106 原计划走「方案 C（claim 与建行同事务）」，**本 ADR 用读码证据否掉该前提**

## 1. 动机

### 1.1 缺陷本身（已复现，不是推演）

心跳是**客户端快照覆盖写**，派发是**原子 `+1` 带容量谓词**，两条写路径打同一列
`executors.runningTaskCount`：

- 心跳：`apps/admin-api/src/modules/executor/executor.service.ts:3807` 读服务端在途行数，
  再在 `:3840` 用覆盖写落库；
- 派发：`apps/admin-api/src/modules/executor/executor-dispatch-slot.collaborator.ts:146`
  在事务内 `runningTaskCount = runningTaskCount + 1`（带 `runningTaskCount < max` 谓词）。

窗口内落地的派发占坑会被覆盖写抹掉 ⇒ 计数被改小 ⇒ 容量闸 `runningTaskCount < max` 放行超额 ⇒ **超卖**。

**复现**（`npm run test:heartbeat-dispatch-race`，真 docker PG 两连接）：

```text
汇总：20 轮 · I1(超卖) 20 轮违反 · I2(饥饿) 0 轮 · I3(容量) 6~16 轮（随调度抖动）
样例：I1 违反：最终计数 1 < 在途占坑 3（心跳把已占坑数改小 ⇒ 超卖风险）
```

### 1.2 真实窗口：**不是**「占坑已成而执行行未建」

R105 曾判定剩余阻塞是「占坑已成 / 行未建 ⇒ 行数下限漏算那个坑」，并据此建议 C。
**本轮读码证伪**：执行行**总是在占坑之前**就已存在。

| 事实 | 位置 |
|---|---|
| 调度侧先建行（`status: PENDING`）再入队 | `scheduler.service.ts:2855` 的 `execRepo.save(...)` → `:2895` 的 `queue.add("execute", { executionId: exec.id })` |
| 处理器取出**已存在的行**再派发 | `task.processor.ts:326` 的 `this.executorService.dispatch(dispatchTask, exec)` |
| `dispatch` 的签名就接收现成的执行行 | `executor.service.ts:4890` 的 `async dispatch(task: Task, execution: TaskExecution)` |
| 重试路径同样先建行再入队 | `executor.service.ts:1922` 的 `execRepo.save(retryExecution)` |
| 占坑只改计数、不建行 | `executor-dispatch-slot.collaborator.ts:146` |

⇒ 任何一次占坑发生时，其对应的执行行**已经是 OPEN 状态且已提交**，
所以「按行数取下限」在**占坑维度**上是天然不掉坑的。**「占坑已成 / 行未建」这个中间态在生产里不可达。**

### 1.3 那还剩什么洞：`count` 与 `update` **不是一步**

真正的残留窗口是心跳自己的 **count → write 的 TOCTOU**：

```text
t0  心跳 count 行数 = 1
t1  新执行行入库（rows 变 2）
t2  派发占坑 runningTaskCount += 1
t3  心跳写回 max(reported, 1) = 1        ← 应为 2 ⇒ 少 1 ⇒ 超卖
```

`count` 在 `executor.service.ts:3807`，`repo.update` 在 `:3840`，中间隔着判定、告警与若干 `await`。
**修法只需把「下限」搬进同一条 UPDATE**（见 §2），不需要任何事务重组。

### 1.4 为什么现有 harness 不能当**验收**

`scripts/heartbeat-dispatch-race-selftest.mjs` 是**纯 SQL 模拟**（不 import 任何产品代码：

`grep -c "apps/admin-api"` ⇒ 0），它用两组自写 SQL 对照「现状 vs 修后」口径：

- 现状口径 `:107`：`update executors set runningTaskCount = :snap`
- 修后口径 `:100`：`update ... set runningTaskCount = GREATEST(:snap, (select count(*) from task_executions ...))` —— **已被写在同一条 UPDATE 内**

且它的派发侧把「计数 +1」与「插执行行」写成**一条 CTE 原子语句**（`:126-129`），
所以它**永远不建模**「占坑与建行的先后关系」。

⇒ ① 它无法证明产品改动是否生效（改 `apps/**` 不会让它变绿）；
② 它的「修后口径」恰好就是本 ADR 推荐的单语句形态 ⇒ **反向提示了正确修法**。
验收必须依赖 W1 的 harness 改造（见 §5 步骤 1）。

## 2. 方案

**把「服务端下限」从 Java 侧的两步 IO，搬进同一条 UPDATE 语句**：

```sql
UPDATE executors e
   SET "runningTaskCount" = GREATEST(
         $1,  -- 客户端上报值（已完成范围校验）
         (SELECT count(*) FROM task_executions t
           WHERE t."executorId" = e.id
             AND t.status IN ('pending','running','waiting'))
       ),
       -- 其余心跳自有列照旧
 WHERE e.id = $2
```

要点：

1. **原子性**：子查询与写入在同一条语句内求值（行锁串行化），心跳不再有「读旧值 → 写」的窗口。
2. **语义不变**：`GREATEST(上报, 行数)` 与现有 `resolveHeartbeatRunningTaskCount` 完全一致
   （`apps/admin-api/src/modules/executor/heartbeat-count.util.ts:21` 保持为**纯判定的单一事实源**，
   单语句只是把同一规则下推到 SQL；两者由同一批用例对齐）。
3. **不饥饿（I2）**：下限仍取「非终态行数」，执行终态化后行数下降 ⇒ 心跳可把计数拉回真实值。
4. **实现落点**：`executor.service.ts:3807-3840` 的 count + `repo.update` 合并为一次
   `createQueryBuilder().update(Executor)` + 相关子查询；`resolveHeartbeatRunningTaskCount` 继续
   服务「无行数可算」的分支与单测。

## 3. 影响面与失效半径

| 面 | 影响 |
|---|---|
| 派发链（pull / cron / api 派发 / 重试 / 广播） | **零改动**（本方案不动 `dispatch`、不动占坑、不动事务边界） |
| 既有用例 | `executor-stale-snapshot-write.spec.ts` / `heartbeat-count.util.spec.ts` 需扩一条「SQL 形态」断言；其余不变 |
| 性能 | **更好**：省掉一次 `count` 往返；单语句内的相关子查询走既有 `executorId + status` 索引 |
| 失效半径 | 仅心跳一路写 `runningTaskCount`；若子查询写错（如漏 `status` 集合），后果是计数偏高（饥饿）或偏低（超卖），两者都会被 harness I1/I2 抓到 |
| 事务内做 IO 的风险 | **不引入**（本方案不开事务，仍是单语句；这正是它优于 C 的关键） |

## 4. 替代方案（否掉）

### 4.1 方案 B：把下限改成「占坑数」（R106 原提案）

用 `GREATEST(reported, runningTaskCount 现值)`。**否**：心跳从此**永远无法降计数**，
执行器重启后若计数陈旧偏高（如 5 而实际 0 在跑）就**永久饥饿**（违反 I2）；
而现状的行数下限抹掉未建行的 `+1`，抹掉的其实**是泄漏**。⇒ 等于用「短暂超卖」换「永久泄漏」。

### 4.2 方案 C：claim 与建行同事务（R106 拟采纳，本 ADR 否掉）

**否，前提不成立**：§1.2 已证「行总在占坑之前已存在」⇒ 该窗口不可达；为一个不存在的窗口
去改 9 处 spec 直调点（`apps/admin-api/src/modules/executor/__tests__/executor.mutex-claim.spec.ts:214/226/253/296/307/326/337/347/357`）、
动 `dispatch` 的事务边界，是**用结构性风险换取零收益**。且它把事务拉长到含 insert，
与 ADR-016 的「控制面拉取 + 占坑单语句」形态直接冲突。

### 4.3 方案 D：TTL 占坑表（`executor_slot_reservations`）

新增表 + claim 插、建行删、心跳 `count` 求和、stale sweep 清理。**否**：
既然行先于占坑存在（§1.2），占坑就不需要独立账本；引入 TTL 表只会新增一类
「过期判定失败即泄漏」的故障面，且需 schema 迁移。**这是为不存在的窗口付迁移代价。**

### 4.4 方案 E：只补偿不改结构（调大重试 / 加告警 / 让容量闸读行数）

让容量闸改读行数（`count < max`）能绕开心跳覆盖写，但把每派发一次的 `count` 压进热路径
（fleet 级 QPS），且**放弃** `runningTaskCount` 这一列的存在意义；**否**：以性能与列语义换同一个小洞。

## 5. 分步计划

### 步骤 1 · **先让验收可测**（依赖 W1，本步不改产品代码）

- **做**：W1 把 `scripts/heartbeat-dispatch-race-selftest.mjs` 改成
  **要么 import 真实 `resolveHeartbeatRunningTaskCount` / 真实 SQL 形态，要么加 `--window` 模式**
  （claim 只加计数、延迟建行），并把它**真正接进链**（`test:guards:selftests` 或新段）。
- **红→绿判据**：改造后跑默认模式 ⇒ **必须先红**（现状实现）且失败信息点名 I1；
  `--fixed`/真实实现模式 ⇒ 红（因为产品还没改）。**这一步的意义是把「验收」本身建起来。**
- **失败如何退**：若 harness 仍无法调用产品代码，则本 ADR 的步骤 2–4 一律暂停（无验收不落地）。

### 步骤 2 · 单语句下限（实现）

- **做**：`executor.service.ts:3807-3840` 的 `count` + `repo.update` 合并为一条 UPDATE（§2 的 SQL）。
- **红→绿判据**：步骤 1 的 harness 默认模式 **exit 0**（I1/I2/I3 全 0）；
  且新增一条**集成断言**：「claim 后行未建（人为构造延迟建行）时，下限仍计入该坑」⇒ 修前红、修后绿。
- **失败如何退**：`git checkout -- apps/admin-api/src/modules/executor/executor.service.ts`。

### 步骤 3 · 纯函数与 SQL 对齐

- **做**：保证 `resolveHeartbeatRunningTaskCount`（纯）与 SQL 形态对同一批输入给出同值（表驱动用例）。
- **判据**：新增表驱动用例 ≥8 组（上报 0/3、行数 0/3 的组合）全绿；两者任一处漂移即红。

### 步骤 4 · 接链与守卫

- **做**：把心跳段接进链（若步骤 1 已接则只补「删接线能红」验证）。
- **判据**：删掉链内该段 ⇒ 链红并点名；恢复 ⇒ 绿。

## 5b. 残余窗口与**前提条件**（R111 定性）

原子化的下限**能闭合「已提交之后」的窗口，闭不了「未提交」的窗口** —— 这是 MVCC 的固有性质：
并发事务里**尚未提交**的执行行对心跳的子查询不可见。R111 用两条会话在真 PG 上把这个机制钉死了
（`artifacts/autonomy/R111-api/uncommitted-window.sh`，3/3 确定性复现）：

| 模型 | 时序 | 结果 |
|---|---|---|
| **A. 占坑与建行在**同一未提交事务** | 占坑事务 `BEGIN; UPDATE 计数+1; INSERT 执行行; sleep; COMMIT`，心跳在其 sleep 窗口内 UPDATE | 心跳**看不见**那行（且阻塞后经 EPQ 重估仍用语句快照）⇒ 写回 0，把已提交的 +1 抹掉 ⇒ **`final=0` 而 `rows=1` ⇒ 超卖** |
| **B. 生产模型：行先提交，再占坑** | 执行行先 `INSERT` 并提交，之后才 `UPDATE 计数+1` | 心跳看得见该行 ⇒ `final=1 = rows=1` ⇒ **安全** |

**生产属于 B**：调度侧先 `execRepo.save(...)` 建行（`scheduler.service.ts:2855`）并提交，再入队
（`:2895`），`dispatch` 才占坑（`executor.service.ts:4890` → `executor-dispatch-slot.collaborator.ts:146`）。
⇒ 心跳语句开始时，占坑对应的行**必然已提交** ⇒ 子查询必然计入。

### 因此本 ADR 的**前提条件**（须写进契约/评审清单）

> **执行行必须在占坑之前已提交**（且占坑事务**不得**顺带插入该执行行）。

若将来有人把「占坑 + 建行」合并进同一事务（R106 曾拟议的方案 C！），本 ADR 的原子下限会**退化为不安全**：
必须同时改为「心跳先对 executor 行加锁、再算下限」（`SELECT … FOR NO KEY UPDATE` 或等价），
或者把下限改成在**同一事务内**读取未提交占坑（做不到）——前者是唯一可行解。
**这正是方案 C 被 §4.2 否掉的第二个理由**：它不仅修的是不存在的窗口，若真按它实现，还会**打开**这个窗口。

### 关于 `heartbeat-dispatch-race-selftest.mjs` 的口径偏差

该 harness 的占坑是**一条 CTE 原子语句同时做「计数 +1」与「插入执行行」**（模型 A），
因此它测的正是「未提交不可见」那条生产不可达的路径；隔离运行时它靠时序碰运气
（实测：并发有其它实例时 1/20 假红；**隔离 20 轮 0 违反、50 轮 0 违反**）。
要让它的结论对生产有意义，W1 需把占坑模型改成 B：**先插行提交，再单独 +1**。

## 6. 明确不做

1. **不改 `dispatch` / 占坑 / 事务边界**（方案 C 已被 §4.2 否掉）。
2. **不新增表或列**（方案 D 否掉）⇒ **无数据迁移**。
3. **不加特性开关**：本仓已两次裁决「双轨开关 = 制度化的两种承诺」（ADR-032 §4.3 / ADR-033 §4.3 /
   ADR-035 §4.2），本次同样不设逃逸阀。
4. **不改 harness**（`scripts/**` 属 W1 写域）；本 ADR 只声明验收依赖。
5. **不调容量闸语义**（方案 E 否掉）。

## 7. 回滚

1. **粒度**：步骤 2 是**一个** commit（单文件 `executor.service.ts` 的一段）；`git revert <sha>` 即可整体回退。
   步骤 3 的用例与步骤 4 的接线各自独立 commit，可单独回退。
2. **无迁移** ⇒ 无 schema 回滚、无数据修补；回退后 `runningTaskCount` 仍是同一列的同一语义。
3. **不需要灰度开关**（理由见 §6.3）：本改动方向是**收紧一致性**，回滚一个「是否要拦住超卖」的开关
   等于默认留着超卖。
4. **回滚代价**：恢复「count → write 二步」的 TOCTOU 窗口（即 R18-B 的 20/20 复现形态）。

## 8. 关联

- 相关 ADR：[ADR-016](adr-016-executor-control-plane-pull.md)（占坑闸的单语句形态与锁序）、[ADR-030](adr-030-executor-token-cross-instance-idempotency.md)
- 证据：`artifacts/autonomy/R18/protocol-layer-proof.log`（原始卡点）、`artifacts/autonomy/R16/receipt.md`（20 轮真机）、`artifacts/autonomy/R105-api/receipt.md`（R18-B 复核）、`artifacts/autonomy/R106-api/receipt.md`（否掉 B、判定 harness 纯模拟）
- 实现位置：`apps/admin-api/src/modules/executor/executor.service.ts`（`:3807` / `:3840`）、`apps/admin-api/src/modules/executor/heartbeat-count.util.ts`（`:21`）
- 验收脚本（W1 改造）：`scripts/heartbeat-dispatch-race-selftest.mjs`
