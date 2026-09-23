# ADR-018: 执行器心跳区分「已占槽位」与「在跑执行」——新增 `reservedSlots`（协议 3→4，E-01-RPT）

状态：Accepted

## 背景

### 生产实证

RPA5 执行器在中台详情页长期恒显：

- 卡片：**当前运行任务 1 / 10**
- 告警：**活性上报 0 条，与运行计数 1 不一致**（`executorDetail.inconsistent`）

而该执行器所在设备上**并没有任何任务在执行**，`task_executions WHERE status='running'` 也是 0 行。运维据此反复排查「卡住的任务」，实际什么都没卡住。

### 根因：两个数字都对，却度量了不同的东西

这不是计数泄漏，也不是漏减，而是 **E-01 防超卖机制的固有上报口径缺口**：

1. **E-01**（`docs/DEEP_REVIEW_0ef3bbe.md` §E-01，修于 `44d6a2b`）要求 pull 循环在发起 25s 长轮询**之前**先原子预留一个容量槽位，并让预留计入**同一个并发账本**：
   - executor-node `pull.ts`：`Atomics.add(getRunningCountArray(), 0, 1)`，`finally` 是唯一释放点；
   - executor-python `scheduler.py`：`try_reserve_running_slot()`（同一把 `_running_count_lock`），`finally` 释放。

   目的是关闭「admin 把最后一个空槽 push 派发进来 → 执行器 accept 返回 429 → 任务被误判永久失败」的竞态窗口。预留即占位，**长轮询窗口内 admin 看到的就是满载**——这正是机制本身。

2. 但两个心跳字段来自**两个不同的账本**：
   - `runningTaskCount` ← 容量计数（node `Int32Array` + `Atomics` / python 锁内 `running_count`）；
   - `runningExecutionIds` ← 在跑执行登记表（node `liveExecutions` Map / python `_live_executions` 字典），只有**真正领取到**的执行才有 id。

3. 空闲 pull 执行器几乎**始终**处在长轮询窗口内（25s 窗口 + 1s 轮询间隔），于是稳态上报恒为：

   ```
   runningTaskCount:    1     ← 已占槽位（含 1 个取件预留）
   runningExecutionIds: []    ← 在跑执行（空，确实没有任务）
   ```

4. 中台详情页把两者直接交叉核对（`ExecutorDetailPage.tsx`），遂恒亮不一致告警；`runningTaskCount` 又被直接当成「当前运行任务」显示，于是有了「1 / 10」这个不真实的数字。

**两个数字都是诚实的**——问题出在「已占槽位」被当成「在跑执行」展示与核对。

### 为什么必须作为契约决策处理

修法天然有两条路，而**错的那条会把已关闭的 P1 竞态重新打开**，且不会在单测里显形（E-01 当年的表现正是「高峰期高概率」，见 `docs/reviews/audit-r3-verify-exec-pkg.md` §E-01）。因此这属于线缆协议语义决策，必须钉进 `protocol.json` 与兼容性红线，而不是留在一句代码注释里。

## 决策

1. **新增心跳可选字段 `reservedSlots`**（协议 **3 → 4**，`$schemaVersion` 不变——纯增量、旧端可忽略）：pull 长轮询「已预留但尚未认领」的槽位数，非负整数。两端**必须恒发送（含 `0`）**——`0` = 已上报且无预留；**字段缺席** = 旧版执行器未上报。

2. **`runningTaskCount` 语义钉死为「已占槽位」**（含 E-01 取件预留），**`runningExecutionIds` 语义钉死为「在跑执行」**。两者不是同一个量的两种表达，任何一方都不得被用来推导另一方。

3. **派发闸门只读 `runningTaskCount`**（`selectLeastLoaded` / 容量守卫 / 原子 `+1` 占坑）。`reservedSlots` **绝不参与任何派发或容量判定**——它只服务展示与告警。

4. **中台展示口径**：详情页显示 `实际运行 = runningTaskCount − reservedSlots`，并用该值（而非 `runningTaskCount`）与 `runningExecutionIds.length` 交叉核对；**容量进度条与满载判定仍用 `runningTaskCount`**（与派发闸门口径一致）。

5. **admin 采纳规则**（与 `runningExecutionIds` 同款三态纪律）：
   - `undefined`（旧执行器）→ **保留 DB 旧值**，UI 回落旧口径（`reserved = 0`，行为与引入前逐字节一致）；
   - 非法（非整数 / 负数 / 超 `MAX_RUNNING_EXECUTION_IDS`）→ warn + 保留 DB 旧值（不半采纳）；
   - **自洽性硬约束** `reservedSlots ≤ runningTaskCount`：预留是已占槽位的**子集**（E-01 让两者共用同一账本），违反即整体拒绝采纳。配对校验必须用**采纳后的** `e.runningTaskCount`（`metricValues.runningTaskCount` 可能刚被越界校验删除）。
   - 重启分支（`didRestart` / missing-baseline）**连预留一起清零**——重启后进程内 pull 循环已消失，重启前的预留必然不存在，留着会让 UI 从新计数里减掉一个陈旧值。

6. **兼容性红线**：旧执行器（协议 < 4）不上报该字段 → 照常注册、照常收任务，UI 走旧口径；**不得**因缺字段拒绝注册或剔除执行器。

7. **明令禁止的修法**（写进 `protocol.json` 矩阵条目与 `executor-contract.md` 兼容性红线）：**绝不可**用 `runningExecutionIds.length` 覆盖 `runningTaskCount`。理由见「替代方案」。

## 后果

### 正向收益

- RPA5 这类现场不再误报：卡片显示「0 / 10」，不一致告警消失，运维不再为不存在的「卡住任务」付出排查成本。
- **E-01 的防超卖语义逐字节不变**：派发路径一行未改，`freeSlots` / `runningTaskCount` 的算法与消费点保持原样。
- 协议演进可观测：中台能区分「v4 执行器上报了预留数（可换算）」与「旧执行器未上报（按已占槽位显示）」，而不是靠猜——**猜错的方向恰好会重开超卖竞态**。
- 顺带补齐了一处可观测性：详情页显式说明「已占 N 个槽位（含 M 个取件预留）」，把「0/10 但服务端占用 1」这个新出现的认知落差也讲清楚。

### 接受的代价与边界

- **多一个字段、多一列、多一次迁移**（`1790000000039-AddExecutorReservedSlots`）：`reservedSlots integer NULL`。可空是刻意的——`NULL`（未上报）与 `0`（已上报且无预留）必须可区分，否则中台无法决定用新口径还是旧口径。
- **两端必须同批发布**才能让 UI 生效；只发中台会让旧执行器继续显示旧口径（可接受，非故障）。
- 心跳两次采样之间的固有偏差仍会偶发触发告警（30s 心跳 vs 1s pull 循环）——这是真实的不一致，**告警保留**，不做抑制。
- 预留计数是单飞的，真值恒为 0/1；实现侧仍按非负整数上报（不按 `maxConcurrentTasks` 钳制——该值随 `/config/reload` 热更，用它做上界会让两个字段的采纳顺序互相影响）。

### 验收项

- `apps/executor-node/src/pull.spec.ts`：长轮询**进行中**断言 `reservedSlots === 1`（与账本 `+1` 同点）；空轮次 / accept 400 / accept 200 三条路径断言回落 `0`（accept 200 是「所有权移交」——不撤销会让中台重复扣减，显示比真值少 1）。
- `apps/executor-node/src/scheduler.spec.ts`：心跳体断言 `reservedSlots` 恒在（含 `0`）；反证用例——provider 抛错 / 返回 `NaN` 时收敛为 `0` 且**心跳仍发出**（心跳失败会让 admin 判 OFFLINE，代价远大于少报一次预留数）。
- `apps/executor-python/tests/test_scheduler.py`：同一份心跳里 `reservedSlots=1` + `runningTaskCount=1` + `runningExecutionIds=[]` 三者并存（还原生产现场）；反证——重复撤销钳制在 0，不得为负。
- `apps/admin-api/src/modules/executor/__tests__/executor.service.spec.ts`：采纳 / 边界 / 缺省保留 / 非法拒绝 / **越界（> 计数）拒绝** / 计数越界被丢弃时的自洽性。
- `apps/admin-api/src/modules/executor/__tests__/executor.controller.security.spec.ts`：F-2 白名单必须转发该字段（漏转发 = UI 永远显示「1/10 + 不一致」）。
- `apps/admin-web/src/__tests__/executor-detail-reserved-slots.test.tsx`：显示 `0` 且无告警；反证三条——旧版（`null`）仍走旧口径并照旧告警（真实异常不被掩盖）、越界上报钳制不显示负数、`reservedSlots=0` 时不得误减。
- `apps/admin-api/src/modules/executor/__tests__/protocol-version-consistency.spec.ts`：三端 `PROTOCOL_VERSION === protocol.json currentProtocolVersion`。
- ADR-005：`apps/executor-node/src` 有改动 → 同 commit 重打 desktop bundle 并回填 `executor-node-bundle.sha256`。

## 替代方案（被否）

- **方案 B：用 `runningExecutionIds.length` 覆盖 `runningTaskCount`**（用户初步提议的方向）。
  **否决，且是危险方向。** 后果链：中台在预留窗口内误判有空槽 → push 派发进已被预留的槽位 → 执行器 `acceptExecution` 容量复检失败返回 **429** → 任务被回调为**永久失败**。这恰是 E-01 当年要关闭的竞态（`docs/DEEP_REVIEW_0ef3bbe.md` §E-01：「pull 模式容量竞态把『暂时没槽位』变成『任务永久失败』」）。
  附加缺陷：`runningExecutionIds` 只是「真正领取到的执行」的**子集**，且两端都按 `MAX_RUNNING_EXECUTION_IDS=10000` 截顶（`executor-node` `scheduler.ts` / `executor-python` `config.py`），并发逼近封顶时数组必然少于真实在跑数，用它覆盖计数会**系统性低报**容量、把派发闸门放开到超卖。
  （注：本条原先还引用了「python 侧截断到 200」作为附加理由。该 200 是 python 侧一个**独立缺陷**——它抄了一个不存在的 "node parity"，node 从来是 10000——已在 NETOPT-C P2-1 修正为三端同值 10000。修正后本方案的否决理由**不依赖**该缺陷：即便两端封顶完全一致，用派生量覆盖源量仍然是错的，见下一段。）
  另一层理由：两个字段本就是两个账本，`runningExecutionIds.length === runningTaskCount` 从来不是不变量（`pull.ts` 只增计数、不登记 id），把「长度」当权威等于用一个派生量去覆盖源量。

- **方案 C：中台/前端启发式识别预留**（如 pull 模式下 `计数 == 长度 + 1` 即视为预留、抑制告警）。
  零协议改动、零迁移，但会**掩盖真实的「恰好 1 个卡住任务」**——而「计数 1 + 活性 0」正是卡住任务的典型形态。用一个启发式去消一个告警，等于把真信号一起消掉；且该判据无法区分「预留」与「回调迟到」等既有语义。

- **方案 D：只改 UI 文案与告警阈值**。
  改动最小，但「当前运行任务 1 / 10」这个**不真实的数字**依旧在页面上，等于把告警藏起来而不修语义。用户要的是数字对，不是不报警。

- **方案 E：让执行器把预留中的 executionId 也塞进 `runningExecutionIds`**（凑长度）。
  否决：预留时**根本还没有 executionId**（正是长轮询尚未带回任务才叫预留）；且 `runningExecutionIds` 是 stale 扫描的存活宽限判据，塞入不存在的 id 会污染该判据。

## 关联

- 计划项：E-01-RPT（生产报障，承接 E-01 / `44d6a2b`）
- 相关 ADR：[ADR-005](./adr-005-bundle-same-commit.md)（同 commit 重打 bundle）、[ADR-015](./adr-015-executor-pull-dispatch.md)（pull 派发模式，E-01 预留槽位所在）、[ADR-016](./adr-016-executor-control-plane-pull.md)（控制面 pull 通道，`freeSlots` 与预留同源）
- 相关文档：[执行器协议契约](../atlas/01-apps/executor-contract.md) · [executor 实体](../atlas/03-data/entities/executor.md) · [API 参考](../api-reference.md) · `packages/executor-protocol/protocol.json`（`versioning.compatibilityMatrix` v4 条目）
