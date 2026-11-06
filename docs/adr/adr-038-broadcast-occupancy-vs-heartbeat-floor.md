# ADR-038: 广播占坑 vs 心跳下限 —— 同一计数列上的两种相反语义

状态：Accepted（设计裁决；**实现未落地**，本轮只出 ADR）
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

### 步骤 1 · 先加一条**能红的判据**（不改行为）

- **做**：新增一条集成判据——「广播扇出到 N 台后，每台的**容量占用口径**都 ≥ 1」
  （今天实现里未持行的目标为 0 ⇒ 该判据**必红**）。
- **红→绿判据**：以今日 HEAD 运行 ⇒ **exit 1**，失败信息点名具体执行器与 `counter/rows`；
  步骤 2 落地后转绿。
- **失败如何退**：若判据在当前 HEAD 是绿的 ⇒ 说明 R119 的 C 段结论在集成层不成立，**停手重查**。

### 步骤 2 · 加列 + 迁移（不改行为，列先空转）

- **做**：新增 `broadcastReservedCount`（默认 0），迁移双向（`up` 加列、`down` 删列）。
- **红→绿判据**：`check:migrations` 与 `check:migration-symmetry` ⇒ exit 0；
  `npm test -- --testPathPatterns "executor|migration"` ⇒ exit 0（此时无行为变化）。
- **失败如何退**：`git revert` 该 commit（无数据写入，回滚零风险）。

### 步骤 3 · 广播 +1 / 释放改打新列，容量谓词改两列之和

- **做**：`executor.service.ts:6034` 与广播释放路径改新列；两处容量谓词改为
  `runningTaskCount + broadcastReservedCount < max`。
- **红→绿判据**：步骤 1 的判据转绿；`executor-dispatch-slot` 的既有容量断言按新谓词更新后 exit 0；
  R119 的脚本扩一段「广播后容量口径 = 2 列和」验证 ⇒ exit 0。
- **失败如何退**：按 commit 回退（步骤 3 独立一个 commit）。

### 步骤 4 · 对账判据（防新列漂移）

- **做**：加一条「广播列 ≤ 该机在途广播执行数」的对账断言（或用 TTL 清理时校验），
  并在心跳里**拒绝**采纳 `broadcastReservedCount`（它是服务端事实，不是执行器自述）。
- **红→绿判据**：故意让释放路径漏一次 ⇒ 对账判据红；修复 ⇒ 绿。
- **失败如何退**：判据可单独关闭（但需在 §6 里登记为已知缺口）。

### 步骤 5 · 文档与展示

- **做**：admin DTO/web 展示新增列；ADR-037 §5b 补一句「行数下限只覆盖单播列」；运维文档写明两列口径。
- **红→绿判据**：`npm run test:docs` ⇒ exit 0；web 侧类型 drift 守卫（`check:web-type-drift`）⇒ exit 0。

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
