# ADR-038: 广播占坑 vs 心跳下限 —— 同一计数列上的两种相反语义

状态：Accepted（**已实现**：步骤 1–4 完成；步骤 5 仅剩文档/展示同步）
- 收口结论见 §9「上线观察项」——**既有生产数据 `broadcastReservedCount` 全为 0，无需一次性对账脚本**。
- 实现：步骤 1 判据 `5ac4b812` · 步骤 2 加列 `5351e3e5`（`1790000000098`）· 步骤 3 写路径+容量谓词+J2 转绿 `784b0373` · 步骤 4 端到端对账（本轮）
- 日期：2026-11-06
- 触发：R119 取证实测（`artifacts/autonomy/R119-api/count-le-rows.sh`）
- 相关 ADR：[ADR-037](adr-037-heartbeat-lower-bound-atomic.md)（心跳计数下限原子化 + §5b 的「行先于占坑」前提）· [ADR-016](adr-016-executor-control-plane-pull.md)（执行器控制面）
- 受影响面：派发容量闸、心跳采纳、admin 展示口径、契约 `networkPolicy`（若走方案 B 需补字段说明）

## 1. 动机

### 1.1 事实链条（四处，全部有行号）

| # | 事实 | 位置 |
|---|---|---|
| 1 | 广播扇出对**每个**接单执行器把计数 `+1` | `apps/admin-api/src/modules/executor/executor.service.ts:6034`（`set({ runningTaskCount: () => '"runningTaskCount" + 1' })`，在 `:6031` 的 `acceptedExecutors.map` 内） |
| 2 | 但广播只有**一行**执行记录：既有注释明写「单执行行的占用标记 `executorAddress` 只能落一个地址」 | 同文件 `:5852-5855` |
| 3 | 于是**未持有执行行**的广播目标出现 **`计数 1 / 行数 0`** | 真 PG 实证：`count-le-rows.sh` C 段 `e2(仅计数): counter=1 rows=0` |
| 4 | R108/ADR-037 把心跳下限改成**按行数**取大（`GREATEST(上报值, count(非终态行))`），并且**有意**不允许把计数改小 | `executor.service.ts:3805-3860`（写入段）、`heartbeat-count.util.ts`（`buildRunningTaskCountFloorExpr`） |
| 5 | 而广播的既有注释**依赖**「计数少计由执行器心跳 30s 覆写兜底」 | 同文件 `:6020-6026`（「跳过占坑的副作用（计数少计）由 `releaseExecutorSlot` 的 `GREATEST(...,0)` 下限保护 + **执行器心跳 30s 覆写**兜底」） |

### 1.2 冲突本体（为什么这是设计冲突而不是 bug）

**同一列 `executors.runningTaskCount` 上现在挂着两个方向相反的语义**：

- **ADR-037（单播）**：心跳**不得**把计数改小 —— 因为每个 `+1` 之前执行行已提交（ADR-037 §1.2），
  行数就是占坑数的**下界**，改小即超卖。
- **广播（事实 5）**：心跳**必须**把计数改小 —— 因为广播目标的占坑没有执行行，
  行数看不见它，只能靠执行器自述覆盖来纠正「少计」。

⇒ 在广播目标上这两条**互相抵消**：

1. 广播给某机 `+1`（计数 1），该机无执行行（行数 0）；
2. 该机心跳上报 `runningTaskCount=0`（它认为自己没在跑；广播任务可能尚未开始执行）；
3. ADR-037 的下限算 `GREATEST(0, 0) = 0` ⇒ **把广播那 1 抹掉**；
4. 该机容量闸看到 `0 < max` ⇒ **可以被继续派单播任务** ⇒ 容量少计 ⇒ **超卖面**。

反向也成立：若心跳按「广播要靠覆写纠正」的旧口径写回 1，就把本该纠正的少计**钉死**。
（两种语义共用一列 ⇒ 无论选哪边，总有一边是错的。）

### 1.3 不变量只在单播成立（R119 实证）

`artifacts/autonomy/R119-api/count-le-rows.sh`（真 PG，`acf-postgres-1` + 独立 schema `r119`，exit 0）：

| 段 | 场景 | 结果 |
|---|---|---|
| A | 生产顺序（建行提交 → 谓词占坑 → 并发心跳）10 轮 | `counter=4 / rows=4` 全部成立 ⇒ **单播恒成立** |
| B | 占坑后**删行** | `1/1` → **`1/0` 破裂** ⇒ 只有删行才破（生产不删行） |
| C | 广播扇出（每台 `+1`、只有一行） | `e2: counter=1 / rows=0` ⇒ **设计固有破裂** |

## 2. 方案对比

### 2.1 方案 A：广播目标也落**占用行**（每台一行）

广播时给每个接单执行器各插一条占用行（`status='pending'`，`executorAddress` 分别为各机）。

- **优点**：口径**唯一**（行数 = 占坑），心跳下限、容量闸、ADR-037 全部不用改；`计数 ≤ 行数` 恢复普适。
- **代价/失效半径**：**行数语义变化** —— `task_executions` 的行不再等于「一次任务执行」，
  而是「一次执行 × 一个目标机」。冲击面：任务列表/统计的「执行数」变多、`execution_finalizations`/
  回调/日志背填按执行行索引的链路（`task.service.ts` / `executor.service.ts:1922` 一带）需逐个核对、
  用户可见口径变化。**这是最大的一种改法**。
- **迁移**：无需 schema 迁移（用既有表），但**存量广播执行**没有多行，口径不齐 ⇒ 需一次回填或按时间点划断。

### 2.2 方案 B：广播占坑拆到**独立列**（推荐）

`executors` 新增 `broadcastReservedCount`（int，默认 0）：

- 广播：`broadcastReservedCount = broadcastReservedCount + 1`（容量预检用**两列之和**）；
- 单播：仍是 `runningTaskCount + 1`（谓词同今天）；
- 心跳：ADR-037 的下限**只作用于 `runningTaskCount`**（行数口径不变）；
  `broadcastReservedCount` 由**广播释放**（回调/release）与**心跳自述**共同收敛；
- 容量判定：`runningTaskCount + broadcastReservedCount < maxConcurrentTasks`。

- **优点**：两种语义**物理分开**，心跳与广播不再互相覆盖；不动 `task_executions` 的行语义（零用户可见变化）；
  改动集中在三处（广播 +1/释放、容量谓词、DTO）；可在同一轮里让"少计"与"被抹掉"同时消失。
- **代价/失效半径**：新增一列 ⇒ 需迁移；两列可能**漂移**（广播占坑靠释放/心跳收敛，若释放路径漏一处会长期少计），
  需一条对账判据（见 §5 步骤 4）；admin 展示口径要明示（见 §3）。
- **迁移**：**有**（加列，默认 0，可空性 + 默认值 ⇒ 在线加列安全；`down()` 为删列）。
  须过 `check:migrations` / `check:migration-symmetry`。

### 2.3 方案 C：保留现状 + 把「广播目标不保证容量下限」写成已知限制

- **做法**：不动代码，在契约 `networkPolicy`/运维文档里声明广播目标不保证容量下限，并在告警里提示。
- **代价**：**最省事但最危险** —— 等于把「超卖」写成已声明行为（ADR-029 已裁决过这条路线不可取：
  不能把 SSRF/超卖口子写成「已声明行为」）。失效半径：任何 `executeMode=broadcast` 的部署，
  其机队可被多派单播任务直到执行器自己拒绝；且故障表现是「偶发过载」，难以归因。
- **迁移**：无。

### 2.4 方案 D：独立轻量占用表（`executor_broadcast_occupancy`）

广播时插一行 `(executorId, executionId, createdAt)`，释放时删；容量 = `runningTaskCount + count(该表)`。

- **优点**：不新增 `executors` 列、不改变 `task_executions` 语义、天然带时间戳可做 TTL 对账。
- **代价**：**热路径多一次 join/子查询**（每个候选执行器都要算），且需 TTL/清理任务（泄漏即永久少计）；
  相比 B 多一张表 + 一个 sweeper。**判为 B 的超集代价，收益不抵**。

## 3. 推荐方案与判定依据

**推荐 B（独立列 `broadcastReservedCount`）**，依据三条：

1. **语义分离是唯一能让两条规则同时成立的做法** —— A 靠消灭广播占坑的"特殊性"来统一（代价是行语义崩塌），
   C 靠放弃保证（把缺陷写成契约），D 用表换来同样的分离却多付热路径 join 与清理任务。
2. **零用户可见变化**：`task_executions` 行数、任务列表口径全部不动（`apps/admin-web/src/utils/executor-metrics.ts:6`
   的「实际在跑 = `runningTaskCount` − `reservedSlots`」口径可原样保留，只新增广播列单独展示）。
3. **与 ADR-037 正交**：ADR-037 的行数下限继续只管单播列，**不需要**在「不得改小」与「靠覆写纠正」之间二选一。

## 4. 影响面与失效半径

| 面 | 影响 |
|---|---|
| 广播派发 | `executor.service.ts:6034` 的 `+1` 改打到新列；容量预检用两列之和（`:6036-6041` 的 `andWhere`） |
| 单播派发 | 不变（`executor-dispatch-slot.collaborator.ts:101-119` / `:157-215` 仅把谓词改成两列之和） |
| 心跳 | ADR-037 的 `GREATEST(上报, 行数)` 继续只写 `runningTaskCount`；广播列的收敛另立规则（释放 + 心跳自述二选一，需在实现轮定稿） |
| admin 展示 | 新增列进 DTO（`executor.controller.ts:427` 一带的字段白名单）与 web 展示；既有「实际在跑」口径不变 |
| 契约 | `networkPolicy` 无需新类别；但需在 `switch`/注释里说明「容量 = 单播占坑 + 广播占坑」（`packages/executor-protocol/**` 属 W1/写域外的跨端决策，实现轮需协同） |
| 既有测试 | `executor.service.spec` 广播段、`executor-dispatch-slot` 的容量谓词断言、`executor-heartbeat-*` 的字段白名单（新增列不得被心跳误采纳）都需补 |
| 失效半径 | 若新列释放路径漏一处 ⇒ 该机**永久少计**（少派单，不超卖）；若心跳误采纳新列 ⇒ 回到今天的问题。**漏释放是"安全方向"，漏写谓词是"超卖方向"** |

## 5. 分步计划

### 步骤 1 · 先加一条**能红的判据**（不改行为）—— ✅ 判据已定稿（R121/R122）

**两条判据，只有 J2 是真判据**（R121 实测）：

- **J1（字面判据，**不够**）**：「广播到 N 台后每台 `runningTaskCount ≥ 1`」。
  实测 **绿** —— 因为广播本就对每个接单执行器 `+1`（`executor.service.ts:6034`，既有用例 `R-06` 已钉住）。
  **J1 量的是「计数」**，而本 ADR §1.1 的事实 3 说的是 **`计数 1 / 行数 0`（行数口径）** ⇒
  **J1 测不到缺陷**（它绿不代表问题不存在）。J1 保留为**回归哨兵**。
- **J2（真判据）**：「广播 `+1` 后，让该机跑一次心跳（`reported=0`）且它名下**零条**非终态执行行
  ⇒ 占用仍须 ≥ 1」。今天必红：下限表达式 `GREATEST(0, 0) = 0` ⇒ **抹掉广播那 1**。
  红证据：`artifacts/autonomy/R121-api/step1-red-evidence.md`
  （`Expected pattern: not /SELECT count\(\*\) FROM task_executions/`，实得
  `GREATEST(0, (SELECT count(*) FROM task_executions …))`，exit 1）。

**否决条件的正确用法**（R122 修正）：

| 情形 | 该怎么做 |
|---|---|
| J1 绿 | **不触发否决** —— 它不是真判据（量错了对象：计数 vs 行数） |
| **J2 绿** | **才停手重查** —— 说明缺陷已消失（别人修了）或实现变了（判据失效），必须先弄清是哪种 |

⚠ 教训：**「判据没红」与「问题不存在」是两件事**。判据必须量在缺陷所在的那个量上
（本例是**行数口径可见性**，不是计数本身）。

**J2 的入库时机**：随本 ADR **步骤 3 的实现一起提交**（实现落地、J2 转绿时）；
本仓不留红用例，步骤 2 提交时只在 commit message / 回执里引用其红证据路径。

### 步骤 2 · 加列 + 迁移（不改行为，列先空转）

- **做**：新增 `broadcastReservedCount`（默认 0），迁移双向（`up` 加列、`down` 删列）。
- **红→绿判据**：`check:migrations` 与 `check:migration-symmetry` ⇒ exit 0；
  `npm test -- --testPathPatterns "executor|migration"` ⇒ exit 0（此时无行为变化）。
- **失败如何退**：`git revert` 该 commit（无数据写入，回滚零风险）。

### 步骤 3 · 广播 +1 / 释放改打新列，容量谓词改两列之和—— ✅ 已完成（本轮提交）

落地清单（每处都给行号/口径）：
- **广播写路径**：`executor.service.ts` 的 `dispatchBroadcast` 扇出 `+1` 改打
  `broadcastReservedCount = COALESCE("broadcastReservedCount", 0) + 1`（不再动 `runningTaskCount`）；
  同一处的容量预检 `andWhere` 改 `(runningTaskCount + COALESCE("broadcastReservedCount",0)) < :max`。
- **释放路径（逐个找全）**：广播占坑的释放**只有两处**，都在
  `execution-callback.collaborator.ts`（R-06 的「重复回调」分支与「winner」分支），
  均按 `cb.executorAddress` 逐台释放（N 个被接受执行器各回调一次 ⇒ −N）；
  两处改调新依赖 `releaseBroadcastSlot`，实现是
  `block-strategy-gate.ts` 的 `releaseBroadcastSlotByAddress`
  （`GREATEST(COALESCE("broadcastReservedCount",0) - 1, 0)`，与 `+1` 成对且不下溢）。
  单播释放（`releaseExecutorSlotByAddress/ById`）**不动**，仍减 `runningTaskCount`。
- **容量谓词两处**：默认路径 `executor-dispatch-slot.collaborator.ts` 的单条 UPDATE
  （`(runningTaskCount + COALESCE("broadcastReservedCount",0)) < :max`）与
  挂组路径的 `FOR UPDATE` 锁内比较（`occupied = runningTaskCount + (broadcastReservedCount ?? 0)`），
  锁内 `SELECT` 同步取出新列。
- **心跳白名单**：`broadcastReservedCount` **不进**心跳采纳（断言钉住：心跳 patch 无该键）。
- **J2 转绿并入库**；**退回旧列 ⇒ J2 红**（`Expected length: 2 / Received length: 0`，exit 1）。
- **对账（步骤 4 的一半）**：`releaseBroadcastSlotByAddress` 的 4 条单测钉住「减的是新列」
  「SQL 与 `+1` 口径互逆（N=1 平衡）」「按地址逐台释放」。
- **失效半径方向性**：漏释放 ⇒ 该机容量占用偏高 ⇒ **少派单**（安全方向）；
  谓词读两列之和 ⇒ 占用偏高只会拒派、不会放行超额。

- **做**：`executor.service.ts:6034` 与广播释放路径改新列；两处容量谓词改为
  `runningTaskCount + broadcastReservedCount < max`。
- **红→绿判据**：步骤 1 的判据转绿；`executor-dispatch-slot` 的既有容量断言按新谓词更新后 exit 0；
  R119 的脚本扩一段「广播后容量口径 = 2 列和」验证 ⇒ exit 0。
- **失败如何退**：按 commit 回退（步骤 3 独立一个 commit）。

### 步骤 4 · 对账判据（防新列漂移）—— ✅ 已完成（R125）

- **端到端对账（N=3）**：用例 `R125: N=3 广播 ⇒ 每台各 +1；N 次回调（含重复回调）后每台回到 0 且两列之和平衡`
  （`task/__tests__/task.service.spec.ts`）——覆盖 **winner 回调 + 重复回调分支**两条释放路径，
  断言：①每台恰好释放一次（一次性闸不被绕过）②每台最终回到 0 ③**单播列全程未被广播碰过** ④
  平衡式 `∑(before) + N − N == ∑(after)`。
  **反向验证**：把释放路径改回减 `runningTaskCount` ⇒ 该用例**红**（`Expected −5 / Received +1`，exit 1）。
- 单元层另有 4 条（`releaseBroadcastSlotByAddress`）：减的是新列 / SQL 与 `+1` 口径互逆 /
  按地址逐台释放 / 空地址零查询。
- **修复过程中自查出一个真 bug**（见 §9）：`releaseBroadcastSlot` 初版是**可选调用且未接线**
  ⇒ 广播释放静默 no-op（永久泄漏）。已改为**必填依赖**（漏接线变成编译错误）并补三个装配点。

- **做**：加一条「广播列 ≤ 该机在途广播执行数」的对账断言（或用 TTL 清理时校验），
  并在心跳里**拒绝**采纳 `broadcastReservedCount`（它是服务端事实，不是执行器自述）。
- **红→绿判据**：故意让释放路径漏一次 ⇒ 对账判据红；修复 ⇒ 绿。
- **失败如何退**：判据可单独关闭（但需在 §6 里登记为已知缺口）。

### 步骤 5 · 文档与展示

- **做**：admin DTO/web 展示新增列；ADR-037 §5b 补一句「行数下限只覆盖单播列」；运维文档写明两列口径。
- **红→绿判据**：`npm run test:docs` ⇒ exit 0；web 侧类型 drift 守卫（`check:web-type-drift`）⇒ exit 0。

## 9. 上线观察项与残余风险（R125 收口结论）

### 9.1 既有生产数据：**不需要一次性对账脚本**

上线时 `broadcastReservedCount` 全为 `0`（迁移零回填），而"真实在途广播数"可能 > 0。
**为什么不需要回填**：

- 该列的语义是**追加式预留**（每次广播 `+1`、每次回调 `−1`），**不是**存量快照；
- 未回填的唯一后果是：上线瞬间在途的那些广播执行**不占**容量 ⇒ 它们各自还能被多派 ≈1 个单播任务；
- 这些执行的回调到达时会执行 `−1`，`GREATEST(...,0)` 兜底 ⇒ 计数**不会变负**，随后自动归 0；
- 影响窗口 = 上线时刻在途广播执行的剩余时长（分钟级），且方向是**多派一点点**，不是永久漂移。

⇒ **结论：只做观察，不做脚本**。观察项（建议 W1 写进 `docs/operations.md`）：

1. 上线后 24h 内看「广播任务的派发失败率是否上升」（若释放漏了，会表现为**持续少派单**）；
2. 抽样查 `executors` 表：`broadcastReservedCount > 0` 但该机**长时间无**广播执行 ⇒ 疑似漏释放；
3. 若（2）命中且不自行归零 ⇒ 再考虑一次性脚本（`UPDATE ... SET broadcastReservedCount = 0`，安全方向）。

### 9.2 残余风险

| 风险 | 方向 | 兜底 |
|---|---|---|
| 释放漏一处（回调丢失/异常中断） | **少派单**（安全） | `GREATEST(...,0)` 只防负、不自动回落 ⇒ 靠 9.1 观察项 2 发现 |
| 新列被心跳误接纳 | **回到本 ADR 修掉的问题** | 断言钉住「心跳 patch 不含该列」（J2 内） |
| 有人把广播 `+1` 改回 `runningTaskCount` | **容量少计 ⇒ 超卖** | J2 的「广播写路径必须打新列」断言 + R125 对账用例 |
| 广播与单播容量口径再次分叉 | 两端不一致 | 两处容量谓词同口径（默认路径/挂组路径），R124 已各改一处 |

## 10. 文档与展示（步骤 5 进度）

- **`docs/operations.md`（W1 域）**：待同步的段落见 `artifacts/autonomy/R125-api/ops-paragraph.md`（≤6 行，可直接粘贴）；
- **admin DTO/展示**：**判定不需要**新增字段 —— `broadcastReservedCount` 是**内部容量记账**，
  不对应任何用户可理解的概念（用户看到的"在跑/排队"仍由 `runningTaskCount − reservedSlots` 表达）；
  为对称而暴露它会引入一个**无法解释给用户**的数字，且会让前端出现第二个"负载"口径。


## 6. 明确不做

1. **本轮不改实现**（只出 ADR）。
2. **不采用方案 A**：改 `task_executions` 的行语义会波及统计/回填/回调多条链，收益与风险不匹配。
3. **不采用方案 C**：不把超卖写成「已声明行为」（ADR-029 已裁决该路线不可取）。
4. **不加特性开关**：本仓已三次裁决「双轨开关 = 制度化的两种承诺」（ADR-032 §4.3 / ADR-033 §4.3 / ADR-035 §4.2），
   本次同样不设逃逸阀。
5. **不动 `heartbeat-count.util.ts` 的下限语义**：ADR-037 的原子下限继续只管单播（行数口径）。
6. **不在本 ADR 里决定广播列的心跳收敛细节**（释放 vs 自述），留给实现轮的 §5 步骤 4 定稿。

## 7. 回滚

1. **粒度**：步骤 2（加列+迁移）、步骤 3（写路径+谓词）、步骤 4（对账判据）、步骤 5（文档/展示）**各自一个 commit**，
   可按步 `git revert`。若需整体回退：按 5→2 逆序 revert。
2. **数据迁移（有）**：新增列是**可空 + 默认 0** 的在线加列（Postgres 不重写表）；
   `down()` 为 `DROP COLUMN`。必须过 `check:migrations` 与 `check:migration-symmetry`。
   回滚**不需要数据修补**：该列的值可由「广播在途执行数」重建（最坏情况从 0 重新累计 ⇒ 短时少派单，不超卖）。
3. **不需要灰度开关**（理由见 §6.4）：本改动方向是**收紧容量口径**；一个「要不要算广播占坑」的开关，
   等于默认留着超卖面。
4. **回滚代价**：恢复「广播占坑对心跳不可见」的现状（即本 ADR §1.2 的超卖面）。

## 8. 关联

- 相关 ADR：[ADR-037](adr-037-heartbeat-lower-bound-atomic.md)（§5b 的「行先于占坑」前提与心跳下限）、[ADR-016](adr-016-executor-control-plane-pull.md)
- 证据：`artifacts/autonomy/R119-api/count-le-rows.sh`（A/B/C 三段）、`artifacts/autonomy/R119-api/receipt.md`
- 代码位置：`apps/admin-api/src/modules/executor/executor.service.ts`（`:6034` 广播 `+1`、`:5852-5855` 单行约束、`:6020-6026` 依赖心跳兜底、`:3805-3860` 心跳下限）、
  `apps/admin-api/src/modules/executor/executor-dispatch-slot.collaborator.ts`（`:101-119` / `:157-215` 容量谓词）、
  `apps/admin-api/src/modules/executor/heartbeat-count.util.ts`（下限表达式）
- 守卫：`check:migrations` / `check:migration-symmetry`（迁移）、`check:docs`（本文件结构）
