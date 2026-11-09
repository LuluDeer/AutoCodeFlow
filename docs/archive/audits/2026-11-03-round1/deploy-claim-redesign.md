# 灰度批次占坑重设计（A 方案）· 实施与验收报告

> ## ⚠️ 抬头必读（后来人最可能漏掉的两条）
>
> **① P0 目前处于「潜伏态」，引爆点是索引，不是 service 代码。**
> 当前工作区的 `markRolloutState`（条件写 + `{ok,reason}` + 23505 捕获）在**没有 claim 索引**时**不会复现 P0**——
> 因为它的守卫是**按行**的（`rolloutState IS NULL OR NOT IN (pending,probing)`），canary 的 5 行 `rolloutState`
> 均为 NULL ⇒ 5 次写全部通过，多行 canary 正常。
> 但只要有人按（已作废的）094 注释补上「应用级唯一索引压在 `rolloutState` 上」，**第 2 行立刻 23505**，
> 第 1 行残留 pending 且无人回滚 ⇒ `findInFlightRolloutRows` 恒命中 ⇒ **该应用后续所有灰度永久阻塞**。
> ⇒ **「只回退迁移、留着 service」是不稳定中间态**：两者必须成套判断。
>
> **② 成套性（硬约束）**：**claim 列 + claim 索引 + `claimRolloutBatch`/`releaseRolloutBatch` + 周期 scan 兜底**，
> **缺一即失效或造成永久阻塞**（逐种组合的后果见 §8.1）。提交时**要么全带、要么全不带**。
>
> **owner**：verify-reconcile（本文件与 `app-deployment.rollout-claim.spec.ts` 为我的写域；服务层由另一写入方持有）
> **状态**：**部分交付**（见 §9「未做项」——服务层接线与测试**未由我完成**，原因见 §0）
> **测量/施工窗口**：2026-11-03 03:32 → 04:0x（Asia/Shanghai）· **HEAD**：`77eacda5`（未提交）

---

## §0 交付状态（先读这一节，避免误判本报告）

| 交付物 | 状态 | 证据 |
|---|---|---|
| 迁移 `1790000000095-AddRolloutBatchClaim.ts` | ✅ **完成** | 文件在盘；`check-migrations` / `check-migration-symmetry` / `check-index-drift` 三绿（§7） |
| `AppDeployment` 实体：`rolloutBatchClaimId` 列 + 命名 `@Index` | ✅ **完成** | §2 |
| `PLAN-CLAIMS.md` 095 登记行（含 094 作废理由） | ✅ **完成** | §2.4 |
| 服务层：`claimRolloutBatch` / `releaseRolloutBatch` / 全终结路径接线 / 覆盖扫描 | ❌ **未由我完成** | 见下 |
| 测试矩阵（①–⑦） | ❌ **未由我完成** | 见下 |
| `094` 字符串清零、23505 误归因分支删除 | ❌ **未完成**（当前残留 1 处 094 引用、误归因分支仍在 `:3706`） | §9 |

**为什么服务层没做完（必须如实说明）**：
`app-deployment.service.ts` 在我施工期间被**另一写入方连续改写**，我每次读取后文件即变动：

| 时刻 | md5 | 该文件状态 |
|---|---|---|
| 03:35 | — | 仅含 `upgrade()` 的 1-A 行级占坑（+64/−4） |
| 03:36:25 | `1c9206f0…` | 突增 1-B 条件写 + `{ok,reason}`（243 insertions），注释引用**已作废**的 `迁移 1790000000094` / `uq_app_deployments_rollout_in_flight` |
| 03:50:29 | `ffd5bd28…` | 已改为引用**我新写的** `1790000000095`，并出现 `.set({ rolloutBatchClaimId: batchId })` + `.andWhere('"rolloutBatchClaimId" IS NULL')` 的 CAS 接线（5 处命中） |

即：**同一份设计正被另一写入方并行实现**，且它已开始消费我的迁移/实体。我在该文件上继续写会与之互相覆盖。**我选择不覆盖他人正在写的实现**，改为把我在该域内可独立完成、且已验证的部分落地（迁移/实体/登记），并把服务层**必须修的四条硬缺陷**（§6）与**崩溃顺序论证**（§5）完整交给 Lead——这比在并发冲突中产出一个半损坏的实现更有价值。

> ⚠️ **未提交任何 commit**（故无 sha）。服务层处于**他人在途**状态，按我上一轮提的 D-1 纪律，**不应在此时冻结 sha 验收**。

---

## §1 前方案是否有 P0 回归：**是，成立**（但引爆点与派单描述有一处偏差）

### 1.1 已逐行复核为真的部分

| 派单命题 | 复核结论 | 证据 |
|---|---|---|
| `for (const d of canaryRows)` 逐行写 PENDING | ✅ 成立 | `upgradeAllWithRollout` 的 canary 循环 |
| `canaryBatchSize = ceil(N×pct/100)`，默认 pct=50 ⇒ N=10 → 5 行 | ✅ 成立 | `dto/rollout.dto.ts:169-176`，`Math.min(Math.max(Math.ceil(total*pct/100),1),total)` |
| 应用级唯一索引 ⇒ 第 2 行即 23505 | ✅ 成立 | 5 行同 `applicationId` 且谓词命中 ⇒ 违反 `UNIQUE(applicationId) WHERE rolloutState IN (...)` |
| 23505 被捕获后返回 `{ok:false}` + 循环 `return` | ✅ 成立 | 被否实现的 `const marked = await this.markRolloutState(...)` + `if (!marked.ok) return {...blockedReason}` |
| 第 1 行已 pending 无人回滚 ⇒ `findInFlightRolloutRows` 恒命中 ⇒ **永久阻塞** | ✅ 成立 | 该分支只 `rolloutBatches.delete(appId)`，**不回滚已写行** |
| `promoteRest` 的 PROBING/PENDING 循环再犯一次 | ✅ 成立 | `promoteRest` 逐台 `markRolloutState(PENDING)` |
| 单测全绿（mock repo 无唯一约束） | ✅ 成立 | mock 层不施加 23505 |

### 1.2 我必须修正派单的一处表述

> 派单称：「23505 被 `isInFlightUniqueViolation` 捕获 → `{ok:false}` → 循环 return … **多机灰度全线失效**」

**更精确的说法**：P0 的引爆点是**索引**，不是 service 改动。
当前工作区的 service 改动（条件写 + `{ok,reason}` + 23505 捕获）**在不带 094 索引时不会复现 P0**——因为守卫是**按行**的（`rolloutState IS NULL OR NOT IN (pending,probing)`），canary 的 5 行 `rolloutState` 均为 NULL ⇒ 5 次写全部通过，多行 canary 正常。

⇒ **结论：P0 风险当前处于「潜伏态」**。它一旦被谁按注释补上 094 索引就立刻引爆。**这正说明「只回退迁移、留着 service」是不稳定中间态**——已采纳为纪律（§8 成套性）。

---

## §2 新设计（A 方案）

### 2.1 载体：**claim 标记列**（每批次恰好一行携带）

| 对象 | 定义 |
|---|---|
| 列 | `app_deployments."rolloutBatchClaimId" VARCHAR NULL`（值 = `batchId`） |
| 写入面 | **仅 owner 行**（`canaryRows[0]`）。同批次其余 canary 行、全部存量行 = NULL |
| 索引 | `CREATE UNIQUE INDEX uq_app_deployments_rollout_claim ON "app_deployments" ("applicationId") WHERE "rolloutBatchClaimId" IS NOT NULL` |

**为什么这样能满足两个看似互斥的目标**：
- 「一批多行」：非 owner 行 claim 为 NULL ⇒ **完全不参与**唯一性判定 ⇒ 5 行 canary 合法；
- 「一应用一在途批次」：携带 claim 的行在 `applicationId` 上唯一 ⇒ 每应用至多一个 claim 行。

⚠️ **关键机制（A 之所以成立的支点）**：唯一索引在 **UPDATE 时同样做冲突检查**。
两实例抢**不同** owner 行时，第二个 UPDATE 使表出现两行 `(applicationId, claim NOT NULL)` ⇒ **必然 23505**。
⇒ 这是**结构底线**；`WHERE claim IS NULL` 的 CAS 只负责「抢同一行」时的干净快速失败（`affected=0` 而非抛异常）。**两层互补，不是二选一。**

### 2.2 为什么否决了另外两种写法（存档，防再犯）

| 方案 | 否决理由 |
|---|---|
| `UNIQUE(applicationId) WHERE rolloutState IN ('pending','probing')`（094） | 一批 5 行共享谓词 ⇒ 第 2 行必 23505；第 1 行残留 ⇒ 永久阻塞 |
| `UNIQUE(applicationId, batchId)` | 一批 5 行**共享同一 batchId** ⇒ 第 2 行照样撞；且 batchId 为 `rollout-${Date.now()}-${rand}` **随机**，两实例各建批次得到不同值 ⇒ **既不生效又误伤** |

### 2.3 状态机（claim 侧）

```
            ┌──────────── claim 为空（无批次） ────────────┐
            │                                             │
   claimRolloutBatch(owner, batchId)                    releaseRolloutBatch(appId,batchId)
   CAS: WHERE id=owner AND claim IS NULL                   或 覆盖 scan
            │                                             │
            ▼                                             │
     claim = batchId（持有中）─────────────────────────────┘
            │
     23505 ⇒ 另一实例已持有（不同 owner 行）⇒ blocked
```

### 2.4 登记（append-only）

`PLAN-CLAIMS.md` 新增 `1790000000095 | AddRolloutBatchClaim` 行，**未改动 094 行**。
该行内已写明 **094 为何作废的核心一句**：*「应用级唯一索引建在行状态列上，与『一批多行』结构性冲突」*，并附 `(applicationId,batchId)` 同样无效的论证——满足「后来人需要知道为什么」的要求。

---

## §3 全部终结路径清单（写点 → 是否终结 → claim 动作）

> 由【CodeGraph 探查专项】孙 Agent 穷举（12 显式写点 + 4 整行回写点、14 条终结路径），基准 sha `132f8f81…`/4746 行。**行号仅对该快照有效。**

| 路径 | 触发 | 方法 | 是否终结 | 应做的 claim 动作 |
|---|---|---|---|---|
| B1 | 全成功 | `finishBatch` → `settleRolloutRows(PROMOTED)` | 是 | **release** |
| B2 | 某台失败 | `failBatch`（claim 行 FAILED + 回滚 ROLLED_BACK） | 是 | **release** |
| B3 | 自动回滚完成 | `failBatch` 内 ROLLED_BACK 循环 | 含于 B2 | 含于 B2 |
| B4 | **手工停止/暂停批次** | **不存在**（controller 无 rollout 动作端点；`POST /:id/stop` 只置 `status=STOPPED`，**不碰 rolloutState**） | — | **无此路径**（见 §3.1） |
| B5 | 部署行删除 | `removeDeployment` | 是 | claim 随行消失 = **等价释放**（Lead 已认可边界） |
| B6 | 应用删除 | FK **CASCADE** | 是 | 随行消失 = 释放 |
| B7 | 重启 | `onModuleInit` → `markInterruptedRolloutsFailed` | 是 | **覆盖 scan**：claim 非空且无在途行 ⇒ 清 claim |
| B8 | `detectStuckDeployments` cron | 只写 `status` | **否** | **不构成终结路径** ⇒ 不能只靠它回收 |
| B9 | 审批拒绝 | 只写 approvalStatus+status | 否（审批行不进批次） | 不适用 |
| B10 | 批次硬超时 | `rolloutTickInner`（15min，**仅内存计时器**） | 是（→ `failBatch`） | **release** |
| B11 | tick `!active`（隐式） | 只清内存 Map | 部分 | **必须补 release** |
| B12 | `failBatch` claim-lost（隐式） | 只清 Map | 部分 | **必须补 release**（若本实例曾持有） |
| B13 | `onModuleDestroy`（隐式） | 只清 Map/timer，**不 settle** | 否 | **不释放**（批次可能在别的实例继续）⇒ 依赖 B7 scan |
| B14 | `deploy()` 行复用（隐式） | 清 `rolloutState`/`meta` | 否 | ⚠️ **必须同时清 `rolloutBatchClaimId`**（见 F-6） |
| A13/A14/A16 | 整行回写（`pushDeployToExecutor` / `upgradeWithSnapshot` / `stop()`） | `saveWithOptimisticLock` 会回写 claim 列 | 否 | 读到的旧 claim 会被写回——**R50 只约束了 `markRolloutState`，没约束这三处** |

### 3.1 对派单的一处纠正

派单要求测试矩阵 ⑤ 含「**手工停止**」⇒ 释放后同应用可再开灰度。
**实测：admin-api 没有「停止/暂停灰度批次」的端点**（controller 全路由无 rollout 动作；`POST /:id/stop` 只置 `status=STOPPED` 且不碰 `rolloutState`，也不发心跳）。⇒ **该用例无对应实现，不应写成测试**（写了就是假绿）。我已把它从矩阵剔除，改为「B11/B12/B13 隐式路径释放」（§6）。

---

## §4 租约与僵尸回收

| 机制 | 现状（关键缺陷） |
|---|---|
| 租约载体 | `rolloutMeta.leasedAt/leasedBy`（**jsonb 内**，非独立列） |
| 续期 | `touchRolloutLease`，tick 每 5s 一次；**只写 `batch.upgradedIds[0]` 那一行**（首行依赖） |
| 存活判据 | `markInterruptedRolloutsFailed` 用 `leasedAt` 落在 `ROLLOUT_LEASE_GRACE_MS=60_000` 内 ⇒ 跳过 |
| **致命** | 租约每 5s 刷 ⇒ **任何 SIGKILL 都落在「新鲜」窗口内** ⇒ 该行永不被标 failed；而新实例无内存批次 ⇒ **永久 blocked**（见 F-2） |
| 周期 reaper | **不存在**。唯一 cron 只写 `status`，不写 `rolloutState` ⇒ 错过一次 sweep 不可恢复（F-3） |

**claim 残留最长存活时间**（Lead 要求明确）：
- 正常路径：**0**（终结即释放）。
- 崩溃路径：**≤ `ROLLOUT_LEASE_GRACE_MS`(60s) + 一次 scan 周期**。若 scan 挂在 `onModuleInit`（仅启动时跑一次）且**无周期 reaper**，则实际是 **∞** ⇒ **必须补一条周期覆盖 scan，否则「不允许永久残留」这条无法兑现**。⇒ 列为 §9 必做项。

---

## §5 崩溃点可恢复性论证（Lead 要求的两种崩溃点）

**选定顺序：先 settle 行终态 → 最后 release claim**（"事件驱动释放 + 覆盖 scan 兜底"）。

| 崩溃点 | 崩溃后表内状态 | 后果 | 可恢复性 |
|---|---|---|---|
| **P1：settle 之后、release 之前** | 行已 `promoted/failed/rolled_back`（终态），claim **残留** | 应用被判「有批次在途」⇒ 暂时开不了新灰度 | ✅ **可恢复**：覆盖 scan 判据「claim 非空 ∧ 该 claim 的批次已无 `pending/probing` 行」⇒ 清 claim。**不产生错误终态**（行是对的） |
| **P2：release 之后、settle 之前**（**本案不采用**） | claim 已清，行仍 `pending/probing` | 应用看似空闲 ⇒ 另一实例可建**新批次** ⇒ **两批次并行 = 正是要修的缺陷**；且旧行永停在途 | ❌ **不可接受** |

⇒ **必须选 P1 顺序**：宁可让 claim 短暂残留（由 scan 收），**绝不允许**「claim 先清、行仍在途」——后者把结构保证直接击穿。这是「允许短暂残留、不允许永久残留」的具体落地。

**另需注意的顺序约束**：`finishBatch` 当前是「`clearBatchTimers` → `rolloutBatches.delete` → `settleRolloutRows`」。若在 `delete` 之后崩溃，内存已无 batchId ⇒ **后续无从释放 claim**（除非 scan 能从行上反查 batchId）。⇒ **release 必须使用调用前捕获的 `batch.batchId` 局部变量**，不能依赖 `rolloutBatches.get()`。

---

## §6 实施中发现的四条硬缺陷（**必须在接线前修，否则新设计失效或更糟**）

| # | 缺陷 | 后果 | 修法 |
|---|---|---|---|
| **F-8**（最高） | `isInFlightUniqueViolation` **只认** `uq_app_deployments_application_in_flight`；新索引 `uq_app_deployments_rollout_claim` 的 23505 会落到 `markRolloutState` 的通用 catch ⇒ **`return {ok:true}`** | **占坑冲突被当成功** ⇒ 双批次照样放行，且无人知情 | 接线前：claim 捕获用**独立判据**（比对新索引名）并给出**可读原因**；`markRolloutState` 的 claim-specific 23505 分支**删除**（Lead 裁决 §3：它不可达且会把真实约束冲突**错误归因**成「另一实例在推进」） |
| **F-6** | `deploy()` 行复用清 `rolloutState`/`meta` 但**不清 `rolloutBatchClaimId`** | 旧行带 claim 被复用 ⇒ **claim 永久滞留** ⇒ 该应用再也开不了灰度 | 同处补 `rolloutBatchClaimId: null` |
| **F-1** | `failBatch` 的结算 ids 只有 `[failedId, ...upgradedIds]`，**不含 `promotedIds`** | 提升轮中途失败 ⇒ 已置 pending 的 promote 行**永久 pending**；hydrate 上下文调 `finishBatch` 会早退 | 结算集合并入 `promotedIds` |
| **F-2** | 重启 sweep 跳过「租约新鲜」行，而租约每 5s 刷 | **任何 SIGKILL 必落新鲜窗** ⇒ 行永不标 failed ⇒ **永久 blocked** | 覆盖 scan 改用「claim 反查 + 无在途行」判据，而非仅 `leasedAt` |

补充（中）：`stop()` 不碰 `rolloutState` 且不发心跳，唯一救兵是 120s 心跳窗；三处「只清内存不写行」须逐一补 release（B11/B12）。

---

## §7 验证原始输出（**仅覆盖我已完成的部分**）

```
$ node scripts/check-migrations.mjs
✔ 迁移注册校验通过：139 个迁移全部唯一且已注册（分配表 140 行）；下一可用时间戳 1790000000096

$ node scripts/check-migration-symmetry.mjs
✔ 迁移 up/down 对称性棘轮通过：139 个迁移，违规 0 条（基线 0），不可逆 0 个，
  纯数据豁免 7 个，分区子表豁免 1 处，未建模 DDL 6 个，无可拆对象 1 个

$ node scripts/check-index-drift.mjs
check-index-drift: 72 个命名 @Index 声明已比对迁移 DDL；24 个未命名声明不比对
✔ 无漂移
```

**未跑**（如实标注）：`tsc --noEmit`、`jest src/modules/application src/migrations`、`check-conditional-writes`、`check-guards-wired`。
原因：服务层处于**他人在途**的并发改写中（§0），此时跑出的红/绿都不可归因于我的改动；按纪律不把**不可复现的验证数字**写进报告。

---

## §8 风险 + 回滚 + **成套性约束**（Lead 要求明写）

### 8.1 成套性（硬约束）

**claim 列 + claim 索引 + `claimRolloutBatch`/`releaseRolloutBatch` 必须成套落地。**

| 落地状态 | 后果 |
|---|---|
| 只有索引、无 claim 写入逻辑 | **无害但完全无效**：索引永不触发（无行写 claim 列）⇒ 双批次照样放行，但**没有任何红信号**——比不做更糟（伪安全感） |
| 只有 claim 逻辑、无索引 | **claim 完全失效**：`WHERE claim IS NULL` 的 CAS 在「两实例抢不同 owner 行」时**双方都 `affected=1`** 都能成功 ⇒ 双批次放行，且看起来"有占坑" |
| 索引 + 逻辑、无 release | **永久阻塞**：一次成功批次即占死该应用（等同 P0 的永久 blocked 形态） |
| 索引 + 逻辑 + release、无 scan | 崩溃后 claim 残留 ⇒ **永久阻塞**（因无周期 reaper） |

⇒ **三者齐 + scan 兜底**才算完成。**提交时要么全带、要么全不带。**

### 8.2 回滚
- 代码回滚：`down()` 已对称（`DROP INDEX` + `DROP COLUMN`），可安全 revert。
- **但**：若已产生 claim 值，回滚后 claim 列消失 ⇒ 无残留语义负担（列本身就是唯一载体）。
- 部署顺序：迁移可**先于**代码上线（列可空、索引对空表无影响） ⇒ 支持灰度发布。

### 8.3 其它风险
- 行被删除 ⇒ claim 随之消失 = 释放（**Lead 已认可的语义边界**）。
- 整行回写（A14/A16）会把读到的旧 claim 写回 ⇒ **R50 的豁免范围需要扩展**到这三处，否则可能把刚释放的 claim 又写回去。

---

## §9 未做项（诚实清单）

1. **服务层接线全部未做**：`claimRolloutBatch` / `releaseRolloutBatch` / 全终结路径 release / 覆盖 scan / lease 分散续期。原因见 §0（并发写入冲突）。
2. **测试矩阵 ①–⑦ 全部未做**（含 Lead 最看重的「多行 canary 成功」与「claim 先于 mark」两条原始输出）。⚠️ 特别提醒：矩阵 ⑤ 的「手工停止」**无对应实现**（§3.1），不应照写。
3. **`094` 字符串清零未做**：当前 `app-deployment.service.ts` 仍有 **1 处**引用（`grep -c "1790000000094\|uq_app_deployments_rollout_in_flight"` = 1）。**Lead 的 grep=0 验收项当前不满足。**
4. **23505 误归因分支未删**：`"another rollout batch is already in flight for this application"` 仍在 `:3706`。按 Lead 裁决应删除。
5. **未提交**：无 sha。且服务层在他人在途状态下，**不建议此刻冻结 sha 验收**（D-1 纪律）。
6. `apps/admin-api/.probe-tmp/` 非我产物，我未创建也未清理（不在我的写域）。

---

## §10 建议的下一步（给 Lead 的决策）

1. **先确认 `app-deployment.service.ts` 的唯一写入者**。该文件在 14 分钟内被 3 个不同 md5 覆盖（`1c9206f0` → `ffd5bd28` → …），且已有他方在实现同一设计。**两个 writer 同时改同一文件，本轮必然产出半损坏实现。** 建议：指定唯一 writer，另一人只读评审。
2. **把 §6 的四条硬缺陷（F-8/F-6/F-1/F-2）作为接线的前置门**，否则新设计会失效（F-8）或制造永久阻塞（F-2）。
3. **补一条周期覆盖 scan**（唯一 cron 只写 `status`，不写 `rolloutState`），否则「不允许永久残留」无法兑现。
4. 我的三项产出（迁移 095 / 实体 / 登记行）**已独立可验**，守卫三绿，可单独 review；它们不依赖服务层状态，也不会因服务层回滚而失效（列可空、索引对谓词外行零参与）。

---

## §11 验收门槛表（Lead 裁决：四条硬缺陷 + F-9 升为**放行前置条件**，缺一不放行）

> 判据已落成可执行的测试文件：**`apps/admin-api/src/modules/application/__tests__/app-deployment.rollout-claim.spec.ts`**（全新文件，未改动任何既有 spec）。
> **该文件当前是红的——红点即「对方还需要做什么」。** 任何为使其变绿而降低判据强度的改动都应被拒绝。

| id | 缺陷 | 门槛判据（机械可判） | 当前状态 |
|---|---|---|---|
| **F-8** | `isInFlightUniqueViolation` 只认旧索引 ⇒ 新索引 `uq_app_deployments_rollout_claim` 的 23505 落进通用 catch ⇒ **`return {ok:true}`** ⇒ 占坑冲突被当成功 ⇒ **双批次放行** | claim 路径**显式**识别新索引名；claim 冲突**不得**走 fail-open `{ok:true}`；有一条测试：claim 23505 ⇒ **必须 blocked** | 🔴 **红**（service 内无新索引名出现） |
| **F-9** | `markRolloutState` 保留「claim 专属 23505」分支 —— 该方法不写 claim 列，**不可能**违反 claim 索引 ⇒ 真抛 23505 必是**别的**约束，现被谎报成「另一实例正在推进」= **错误归因发生器** | 该字符串在 service 中**必须消失** | 🔴 **红**（`:3706` 仍在） |
| **F-6** | `deploy()` 行复用清 `rolloutState`/`meta` 但**不清 claim** ⇒ claim 永久滞留 ⇒ **该应用再也开不了灰度** | 复用路径的清理**同时**覆盖 `rolloutBatchClaimId: null` | 🔴 **红** |
| **F-1** | `failBatch` 结算集**不含 `promotedIds`** ⇒ 提升轮失败后那些行**永久 pending** | `failBatch` 后**无**任何行残留 `pending/probing` | ⚪ 未覆盖（需真实 failBatch 驱动，见 §9 未做项） |
| **F-2** | 重启 sweep 跳过「租约新鲜」行，而租约每 5s 刷 ⇒ **任何 SIGKILL 必落新鲜窗** ⇒ 行永不标 failed ⇒ **永久 blocked** | 需租约语义能区分「活着在刷」与「进程已死但租约新鲜」（monotonic + 进程启动标识，或 reaper 阈值 < 租约） | ⚪ 未覆盖（同上） |
| **F-9b** | claim 残留上限论证为「≤60s 租约 + 一次 scan」，但**当前只有启动时扫一次、无周期 reaper** ⇒ 实际 **∞** | 要么补**周期 reaper**（复用既有 cron + leader 门），要么在风险台账留**带 owner 的跟踪项**（不接受"写在报告里算完"） | 🔴 **未落地**：无周期 reaper；本报告即为该风险的登记处，**建议 owner = 服务层持有者** |

### 11.1 我实测的红灯清单（`jest app-deployment.rollout-claim.spec.ts`）

```
Tests: 3 failed, 8 passed, 11 total

✓ 迁移 1790000000095 建了 claim 列与部分唯一索引
✓ 实体有 claim 列且索引谓词与迁移一致
✓ 门槛：service 里必须存在 claim 落库与释放两条路径        ← 对方已接上 CAS
✕ 门槛：claim 的 23505 必须显式识别新索引名，而不是只认旧索引   ← F-8
✕ 门槛：markRolloutState 不得保留「claim 专属 23505」的误归因分支 ← F-9
✕ 门槛：deploy() 复用行的清理同时覆盖 claim 列              ← F-6
✓ 门槛：必须用调用前捕获的 batchId（finishBatch 先 delete 内存态）
✓ 多行 canary：5 行 pending 合法，claim 恰好 1 行（不得误伤多行）
✓ 门槛：两实例抢**不同** owner 行 ⇒ 结构性 23505（A 的支点）
✓ 门槛 F-9：claim 冲突必须转 blocked，绝不可 {ok:true}
✓ 释放后同应用可再开灰度（batchId 守卫不得误清他人 claim）
```

### 11.2 spec 里对唯一约束的**显式模拟**（防重演「假绿」）

假仓储 `enforceClaimUniqueness` **刻意**在同应用出现第二个非空 claim 时抛 23505，并在注释里写明
「本 mock 刻意模拟，因为唯一索引不在单测环境」。这正是上一版 25 条全绿却真机全线失效的根因所在：
**mock 里没有索引 ⇒ 23505 永不发生 ⇒ 测试证明不了任何结构性保证。**
同时该 mock 的语义与 PG 一致：**唯一索引在 UPDATE 时同样做冲突检查**（不是只有 INSERT 才检查），
这也是 A 方案能成立的支点。

---

## §12 产品缺口登记（非本任务范围，但必须记账）

| 缺口 | 事实 | 影响 |
|---|---|---|
| **灰度批次无人工中止能力** | admin-api **没有**「停止/暂停灰度批次」的端点（controller 全路由无 rollout 动作；`POST /:id/stop` 只置 `status=STOPPED`，**不碰 `rolloutState`**，也不发心跳） | 批次一旦卡在 `pending/probing`，**没有任何人工出口**——只能等同心跳窗 120s 超时或重启 sweep。这也是 F-2「永久 blocked」之所以严重的原因：**没有人工兜底**。⇒ 原测试矩阵 ⑤（「手工停止 ⇒ 释放后同应用可再开灰度」）**已剔除**，因为它**没有对应实现**，照写即为假绿。替代覆盖 = B11/B12/B13 隐式路径释放。 |

---

## §13 实现约束（Lead 裁决为**约束**，非建议）

1. **崩溃顺序**：**先 settle 行终态 → 最后 release claim**。反序（先 release 后 settle）会在窗口内让应用看似空闲 ⇒
   另一实例建新批次 ⇒ **双批次 = 正是要修的缺陷**，不可接受。两种崩溃点的可恢复性论证见 §5。
2. **`release` 必须用调用前捕获的 `batch.batchId` 局部变量**，**不得**依赖 `this.rolloutBatches.get()`
   —— `finishBatch` 是「先 `rolloutBatches.delete(appId)` 再 `settleRolloutRows`」，崩在 delete 之后即无从释放。
   spec 已加断言钉住该形状（G-D）。
3. **`markRolloutState` 的 claim 专属 23505 分支必须删除**，回落到「非预期 DB 错误 → `logger.warn` + fail-open」的既有语义。

---

## §14 终版状态（Lead 裁决落地 · 2026-11-03 04:0x 复测）

> 本节**取代** §11 表中「当前状态」一列；§11 的判据不变。

### 14.1 门槛状态（按 Lead 裁决的**验收语义**标注，区分「延期」与「未覆盖」）

| id | 判据 | 状态 |
|---|---|---|
| **F-8** | claim 路径显式识别 `uq_app_deployments_rollout_claim`；冲突不得 fail-open | 🔴 **未达成**。该索引名在 service 中 **grep=3，但全部位于注释**；spec 的断言在**剥注释后**判定 ⇒ 判定为「无代码路径识别该索引名」。这正是本条要挡的形态：**注释写对了、代码没接** |
| **F-9** | 误归因分支（claim 专属 23505）必须消失 | ✅ **已达成**（对方同一结论、已改为「只记 warn + fail-open，不做 claim 归因」） |
| **F-6** | `deploy()` 行复用必须同时清 `rolloutBatchClaimId` | 🔴 **未达成** |
| **F-1** | `failBatch` 后无任何行残留 `pending/probing`（结算集须含 `promotedIds`） | ⏸ **延期（门：service 冻结）**——**不是豁免**。service 冻结后**下一轮必须补**机械断言；最终 sign-off 时不得再以「等实现冻结」缺席，否则计为**未验收项**，H-2 不得标 done |
| **F-2** | SIGKILL 后（新鲜租约 + 进程已死）可被恢复 | ⏸ **延期（门：service 冻结）**——同上，同等约束 |
| **F-9b** | **hard gate**：存在周期性调度，**周期 < 租约 TTL**，且会释放过期 claim | 🔴 **未达成**（当前 `markInterruptedRolloutsFailed` 仅 `onModuleInit` 跑一次；全仓无周期 reaper） |

### 14.2 F-9b 的数值判据与最小结构性修法（Lead 裁决）

- **租约 TTL 现值**：`ROLLOUT_LEASE_GRACE_MS = 60_000`（`app-deployment.service.ts:105`）。
- **判据**：`reaper 周期 < 60_000 ms`，且每次运行会清理「claim 非空 ∧ 该 claim 的批次已无 `pending/probing` 行」的记录。
  - 取 **30_000 ms**（**2× 余量**）：最坏情况下一个过期 claim 的存活上界 = `TTL(60s) + 周期(30s) = 90s`，而非 ∞。
- **机械可判形式**（供 spec 后续落地）：
  1. `grep`：`markInterruptedRolloutsFailed` 的调用点**不止** `onModuleInit`，还应有一个带 `@Cron(...)` 的方法体内引用它；
  2. `grep`：该 `@Cron` 方法**走 `LeaderGateService` 门禁**（`check-cron-leader-gate.mjs` 实跑 26/26 全绿，范式成熟，可直接复用）；
  3. 行为断言：「构造一条 claim 非空、租约已过期、且无在途行的记录 ⇒ 跑一次 reaper ⇒ claim 被清」。
- **明确不要**：新写一套 reaper；也**不要**扩 `detectStuckDeployments` —— 已核实它**只写 `status`、从不写 `rolloutState`**，扩它会把「部署卡死」与「灰度批次回收」两件事耦合。

### 14.3 `094` 残留：**已清零**（Lead 的 grep=0 验收项现已满足）

复测：`grep -c "1790000000094\|uq_app_deployments_rollout_in_flight"` = **0**。
说明：原 `:3512` 的注释块已被对方改写为 095/claim 语义；唯一残留的 `:3700` 处注释随 F-9 分支一并删除。
⇒ **§9 第 3 条待办（"写出 `:3512` 精确替换文本"）已自然消解**，无需替换文本。**注意行号已多次漂移，后续一律以 grep 计数为验收口径，不以行号。**

### 14.4 终版红灯清单（`jest app-deployment.rollout-claim.spec.ts` 复测）

```
Tests: 2 failed, 9 passed, 11 total      ← 03:52 首次为 3 failed / 8 passed
✕ claim 的 23505 必须显式识别新索引名，而不是只认旧索引        ← F-8
✕ deploy() 复用行的清理同时覆盖 claim 列                     ← F-6
```
（相比首跑，**F-9 已转绿**、`094` 残留已清零；**F-8 / F-6 仍红**。）

**结论：本报告状态 = 「部分交付 + 门槛表生效」。** 我的直接产出（迁移 095 / 实体 / PLAN-CLAIMS / 门禁 spec / 本报告）已完成并自证；
服务层接线与 F-1/F-2 断言按 Lead 裁决**延期至 service 冻结后**。**请勿将本轮记为完成态。**
