# dispatch-core · 开源调度内核调研（专项）

> **本文件是 `dispatch-core.md` §4 的展开版**。原任务要求「派孙 Agent（Firefox 开源调研专项）」执行本部分，但**本会话 delegation depth 上限为 1**（`subagent` / `subagent_fork` 均返回 `subagent depth 2 exceeds maxDepth 1`，已实测两次），故由本 Agent 直接执行。**主 Agent 应据此对 §4 取舍做一次独立复核**（见 `dispatch-core.md` §8 D-7）。

- **调研方式**：本地源码深读（`/home/yongsheng/project/open_sourse/`）+ 联网核验官方 LICENSE 原文（GitHub API `repos/<owner>/<repo>/license`）
- **我方基线**：TypeScript / NestJS / TypeORM / BullMQ 的自研调度中台，License = **AGPL-3.0-only**

---

## 0. License 合规总表（全部经官方 LICENSE 原文核验）

| 项目 | 官方 LICENSE 首行/关键声明 | SPDX | 与 AGPL-3.0-only 的兼容性 | 风险 |
|---|---|---|---|---|
| [hatchet-dev/hatchet](https://github.com/hatchet-dev/hatchet) | 本机副本 `LICENSE`：`MIT License / Copyright (c) 2023-present Hatchet Technologies Inc.` | **MIT** | ✅ MIT 可进 AGPL 项目 | 🟢 无 |
| [temporalio/temporal](https://github.com/temporalio/temporal) | 本机副本 `LICENSE`：`The MIT License / Copyright (c) 2025 Temporal Technologies Inc.` | **MIT** | ✅ | 🟢 无 |
| [celery/celery](https://github.com/celery/celery) | 官方 LICENSE 第三段：`Celery is licensed under The BSD License (3 Clause).` | **BSD-3-Clause** | ✅ | 🟢 无（GitHub API 报 `NOASSERTION` 是因 LICENSE 为多许可拼接，实为 BSD-3-Clause） |
| [hashicorp/nomad](https://github.com/hashicorp/nomad) | ⚠️ **2026-11-03 复核订正**：当前 `main/LICENSE` 为 **Business Source License 1.1**（`Licensed Work: Nomad Version 1.7.0 or later` / `Change License: MPL 2.0` / 含 **Additional Use Grant 竞品条款**）—— **非** OSI 开源；**≤ v1.6.0** 才为 MPL-2.0（实测 `v1.6.0/LICENSE` 首行 `Mozilla Public License, version 2.0`） | **BSL 1.1（≥1.7.0）** / MPL-2.0（≤1.6.0） | ⚠️ BSL 为 **source-available**（非 OSI）：仅可**借鉴思路**，**不可复制代码**；≤1.6.0 的 MPL-2.0 可进 AGPL 项目 | 🟡 **非零**（原判「无风险」有误：原核验取到的是 v1.6.0 旧版） |
| [kubernetes/kubernetes](https://github.com/kubernetes/kubernetes) | 官方 LICENSE：`Apache License / Version 2.0, January 2004` | **Apache-2.0** | ✅ Apache-2.0 → AGPL 单向兼容 | 🟢 无 |
| [apache/airflow](https://github.com/apache/airflow) | 官方 LICENSE：`Apache License / Version 2.0, January 2004` | **Apache-2.0** | ✅ | 🟢 无 |
| [alibaba/Sentinel](https://github.com/alibaba/Sentinel) | 官方 LICENSE：`Apache License / Version 2.0, January 2004` | **Apache-2.0** | ✅ | 🟢 无 |
| [resilience4j/resilience4j](https://github.com/resilience4j/resilience4j) | 官方 `LICENSE.txt`：`Apache License / Version 2.0, January 2004` | **Apache-2.0** | ✅ | 🟢 无 |

**结论（2026-11-03 复核订正）**：本表**无 GPL/AGPL 项目**；所有项目均可安全「借鉴思路」。⚠️ 但**不得据此复制代码**：Nomad 当前版本为 BSL 1.1（source-available，含竞品限制），非 OSI 开源——「借鉴思路」对它依然成立，「复制代码」则不成立。**严禁照搬代码**：我方为 AGPL-3.0-only，若未来引入 GPL/AGPL 实现，必须**仅借鉴思路不复制代码**并由法务确认。

---

## 1. Hatchet（MIT）—— 重点深读：最可比的对标实现

> 本机副本：`/home/yongsheng/project/open_sourse/hatchet-main`，核心目录 `pkg/scheduling/v1/`（18 个非测试 .go 文件，约 8.4k 行）

### 1.1 架构：决策层与副作用层的严格分离（**这正是我方 Q1 要做的**）

`pkg/scheduling/v1/scheduler.go:34-46`（Scheduler 结构体头注）：

> All mutable scheduling state is owned by a single run-loop goroutine: every read and write happens inside an op sent to the loop via `do()`. **There are no locks and no lock-ordering rules. Database reads run outside the loop, so assignment is never blocked on I/O**; replenish reconciles its reads against assignments that completed in the meantime.

**可复用点（架构层，价值最高）**：
- **DB 读在决策之外**：候选快照由「replenish 周期」读入**内存 slot 池**，决策（`assignSingleton`）只读内存池，**决策过程零 IO** → 决策可单测、可推理。我方 `dispatch()` 恰恰相反：**查库 + 决策 + 写库 + 发 HTTP 全在一个方法里**（`executor.service.ts:5146-5758`）。
- **slot 池的整池过期**（`pkg/scheduling/v1/slot_pool.go:11-13`）：
  ```go
  // slot expiry is 1.5 seconds to account for the 1 second replenish rate, plus 500 ms of
  // buffer time for unacked slots to get written back to the database.
  const defaultSlotExpiry = 1500 * time.Millisecond
  ```
  以及 `slotPool.staleAt()` / `freeCountAt()`：**过期整池作废**（而非逐槽排空），保证「free 计数永不漂移」。
  → 我方对应物：`estimatedDurationsByExecutor()`（`:4733-4791`）每次派发现查 RUNNING 行做采样，**无过期概念**（陈旧样本会被当新样本用）。可借鉴「整池过期」。

### 1.2 核心可复用点 ①：纯函数打分层 `computeWeight`

`pkg/scheduling/v1/worker.go:13-73`：

```go
// computeWeight computes the weight of a worker based on the desired labels. If the worker does not
// meet the required labels, the weight is -1.
func (w *worker) computeWeight(s []*sqlcv1.GetDesiredLabelsRow) int {
    totalWeight := 0
    for _, desiredLabel := range s {
        labelFound := false
        for _, workerLabel := range w.Labels {
            if desiredLabel.Key == workerLabel.Key {
                labelFound = true
                conditionMet := false
                switch desiredLabel.Comparator {
                case sqlcv1.WorkerLabelComparatorEQUAL:
                    if (...) { totalWeight += int(desiredLabel.Weight); conditionMet = true }
                case ... NOTEQUAL / GREATERTHAN / LESSTHAN / GREATERTHANOREQUAL:
                }
                if !conditionMet && desiredLabel.Required {
                    return -1        // ← 硬约束不满足 → 直接淘汰
                }
                break
            }
        }
        if desiredLabel.Required && !labelFound {
            return -1
        }
    }
    return totalWeight
}
```

**与我方对照**：
- 我方 `executor-deployment-affinity.util.ts:125-186` 的 `partitionByDeploymentAffinity` 已经是纯函数（**形态正确**），但语义是**二值分组**（preferred / 非 preferred），**没有权重**。
- 我方 `executor-score.util.ts:71-91` 的 `computeExecutorLoadScore` 也是纯函数（load 50% + cpu 25% + mem 25% + estimated 10%），**但 affinity 完全不参与打分**（affinity 是「分区前置」而非「加分」）。
- Hatchet 的形态：**一个统一权重函数 + `required` 标志区分硬/软** → 「软亲和=加分、硬亲和=淘汰」在同一函数里表达。

**采纳建议**：我方把「affinity / anti-affinity / deployment 归属 / interpreter 真缓存」四个**软信号**统一为**加权分**（而非 4 段独立的 filter+partition 链），`required` 维度（group/tags/runtime/interpreter）仍是硬过滤。**这会直接砍掉 `dispatch()` 里约 8 个分支**，是 §5 阶段 3.3 的核心。

### 1.3 核心可复用点 ②：`rankWorkerIds` 的分层淘汰 + 同分并列组

`pkg/scheduling/v1/scheduler.go:1468-1531`：

```go
func (s *Scheduler) rankWorkerIds(
    qi *sqlcv1.V1QueueItem,
    labels []*sqlcv1.GetDesiredLabelsRow,
    workerIds []uuid.UUID,
) ([]uuid.UUID, int) {
    ranked := make([]rankedWorker, 0, len(workerIds))
    for _, workerId := range workerIds {
        rank := 0
        switch qi.Sticky {
        case sqlcv1.V1StickyStrategyHARD:
            if qi.DesiredWorkerID != nil && workerId != *qi.DesiredWorkerID {
                continue                      // ← 硬 sticky：直接淘汰
            }
        case sqlcv1.V1StickyStrategySOFT:
            if qi.DesiredWorkerID != nil && workerId == *qi.DesiredWorkerID {
                rank = 1                      // ← 软 sticky：加权
            }
        default:
            if len(labels) > 0 {
                worker := s.workers[workerId]
                if worker == nil { continue }
                rank = worker.computeWeight(labels)
                if rank < 0 { continue }      // ← required 不满足 → 淘汰
            }
        }
        ranked = append(ranked, rankedWorker{id: workerId, rank: rank})
    }
    ...
    // 计算 topRankCount（同分并列组的规模）
    topRankCount := len(ranked)
    for i := 1; i < len(ranked); i++ {
        if ranked[i].rank != ranked[0].rank {
            slices.SortStableFunc(ranked, func(left, right rankedWorker) int {
                return right.rank - left.rank
            })
            topRankCount = 1
            topRank := ranked[0].rank
            for topRankCount < len(ranked) && ranked[topRankCount].rank == topRank {
                topRankCount++
            }
            break
        }
    }
    return result, topRankCount
}
```

**三个关键设计**：
1. **HARD / SOFT / NONE 三态 sticky** → 对应我方 **pinned（=HARD）/ appName 点名（≈SOFT）/ 全机队（=NONE）**。Hatchet 把这三种**显式类型化**了；我方目前是 `dispatch()` 里 `if (task.executorId) {...} else {...}` 的一大坨嵌套（`:5165-5353`，**189 行**）。
2. **`topRankCount`（同分并列组规模）** → 后续 `assignSingleton`（`:1259-1370`）用 `offset % topRankCount` 在**并列组内轮转**。
3. **标签缺失即淘汰**（`worker == nil → continue`）——对应我方「候选池里没有的行根本不参与」。

### 1.4 核心可复用点 ③：`ringOffset` 同分轮转（**解决我方一个真实缺陷**）

`pkg/scheduling/v1/action.go:19-21`：

```go
// ringOffset rotates the starting worker between assignments so load spreads
// across the action's workers. Sticky and label ranking keep higher scores
// first; the offset only rotates within the highest-rank tied group.
ringOffset int
```

`pkg/scheduling/v1/scheduler.go:1283-1290`（`assignSingleton` 内）：

```go
// NOTE: ringOffset increments each assign, so we start at that worker and
// wrap with % if it has no free slot, instead of always packing onto
// the first worker in the tied group.
for i := 0; i < topRankCount; i++ {
    workerId := candidates[(offset+i)%topRankCount]
    if sel, ok := selectSlotsFromPools(s.poolsByWorker[workerId], requests, now); ok {
        selected = sel
        break
    }
}
```

**我方对照（真实缺陷）**：`executor.service.ts:5378-5380`
```ts
const sorted = withScores
  .sort((a, b) => a.score - b.score)     // ← 稳定排序，同分恒取数组首元素
  .map((s) => s.executor);
```
→ **同分候选永远取第一台**。若两台执行器负载完全相同（都是 0 任务、同 CPU/内存），**所有任务都会压到同一台**，另一台永远空转。Hatchet 的 `ringOffset` 正是为解决此问题。

**采纳建议**（阶段 3.3，默认关闭）：同分并列组内按 `ringOffset` 轮转。**注意语义影响**：同一执行的重试可能落到不同机器 → 需主 Agent 确认（`dispatch-core.md` §8 D-4）。

### 1.5 核心可复用点 ④：`starved` / `RestoreStarved` 饥饿检测

`pkg/scheduling/v1/action.go:82-160`：
- `MarkStarved(queue, request)`：一次 miss 记录「该队列 × 该 slot 类型集」的**饥饿事件**，返回是否是**新事件**（重复 miss 不重复记录，避免反复唤醒）；
- `RestoreStarved(poolsByWorker, workerIds, now)`：replenish 重建池后检查「是否有 worker 对该类型集恢复了空闲槽」，有则**清除饥饿标记并唤醒队列**。

**我方对照**：`executor.service.ts:5535-5555` 的失败出口有**三类**（`MutexWaitError` / `DeploymentConstraintWaitError` / `NO_DISPATCHABLE_EXECUTOR`），其中前两类靠 `task.processor.ts:387/403` 的 token 前缀识别 → 置 WAITING → 由 scheduler 的 **10s sweep** 无条件唤醒（`task.processor.ts:410-420` 注释）。

**我方差异**：我方的 WAITING 唤醒是**无条件轮询**（10s 扫全部 WAITING 重试），Hatchet 是**事件驱动**（只在容量恢复时唤醒）。
- Hatchet 的做法更省（不空转），但需要「容量恢复事件源」——我方**已经有**：占坑成功时 `claimExecutorSlotForExecution` 成功即释放了某个组的槽位。**可借鉴：占坑成功时主动唤醒该 mutexGroupId / deployment 集合的 WAITING 执行**，替代 10s 无条件 sweep。
- 采纳成本：**中**（需要新的唤醒通道，且要防「唤醒风暴」）。**优先级低于 §3 的决策器重构**，列为观察项。

### 1.6 Hatchet 的缺陷 / 不足（对我方的警示）

| 缺陷 | 详情 | 对我方的意义 |
|---|---|---|
| **Go 实现，零代码复用** | 全部 8.4k 行 Go | 只能借鉴架构与算法 |
| **slot 池是内存态 + 定期 replenish** | 容量真相在 worker 侧上报，不在我方 DB | 我方是 **DB 原子 UPDATE**（`claimExecutorSlotForExecution` `:4925-4935`），**持久化单点真理** → 比我方简单场景的方案更强，**不应照搬** |
| **slot 类型系统（slotType + units）** | 支持「一个任务要 3 个不同类型的 slot」 | 我方无此需求，过度设计 |
| **并发策略子系统（`pkg/scheduling/v1/concurrency/`）** | 11 个 .go 文件 + `decideCancelQueuedExceptNewest` / `decideGroupRoundRobin` / `decideCancelInProgress` 等 7 种 `decideFn` 策略 | 我方互斥组只有「device / global」两档（`executor.service.ts:4961-4963`），**不照搬** |
| **slot 池过期 1.5s 是硬编码** | 注释自述「1 秒 replenish 速率 + 500ms 缓冲」 | 说明**任何基于内存快照的决策都有陈旧窗口** → 我方若引入「快照式决策」必须自建版本号/epoch 机制（我方 `estimatedDurationsByExecutor` 已有 ADR-017 §7 的行身份归组，但**无 epoch**） |
| **全局单 run-loop** | 全部状态单 goroutine | 我方 Node 单进程多 worker（BullMQ concurrency 5），**无单点 run-loop**，无法照搬 |

---

## 2. Temporal（MIT）—— 抢占、队列公平、sticky 降级

> 本机副本：`/home/yongsheng/project/open_sourse/temporal-main`，核心目录 `service/matching/`（30+ .go 文件）

### 2.1 公平分发模型：`<pass, id>` 二元层级

`service/matching/fairness.md`（完整读）核心定义：

```
**Task ID**: sequential int64 assigned to tasks. Two tasks never have the same id.
**Pass**: int64 used to "spread out" tasks.
**Fair level**: tuple of <pass, id>. Fair levels are ordered lexicographically and ordered that way
by persistence.
Tasks are _written_ out of order and we rely on persistence to order them by level
(most importantly by pass).
```

配合 `service/matching/fairness_util.go:39` 的 `ditherPass(seed, key, base, inc)` —— **按公平键抖动化分配 pass**，避免同键任务批量落在同一 pass。

**我方对照**：
- 我方 BullMQ 单队列 `task-queue`（`task.processor.ts:88` `@Processor("task-queue", { concurrency: 5 })`），**无优先级、无公平分发**——任务按入队顺序被 5 个并发 worker 取走。
- 我方 `Task` 实体**有** `priority` 列（`task.service.ts:713` 的 `VERSION_ROLLBACK_COLUMNS` 含 `priority`），但**优先级在派发链上未被使用**（`dispatch()` 完全不读 `task.priority`）。
- **这是一个可发现的能力缺口**：任务有优先级语义但调度面不消费。

**采纳建议**：Hatchet/Temporal 的公平分层（pass + id）比「单队列 FIFO」复杂得多，**我方短期不采纳**。但**「优先级未接入派发链」是一个独立且低成本的缺口**，建议单独立项（不在本域切口内，登记为观察项）。

### 2.2 Sticky 队列的降级：硬 sticky vs 可降级

`service/matching/matching_engine.go:75-77`：
```go
// If sticky poller is not seen in last 10s, we treat it as sticky worker unavailable.
// This seems aggressive, but the default sticky schedule_to_start timeout is 5s, so 10s seems reasonable.
stickyPollerUnavailableWindow = 10 * time.Second
```
`service/matching/matching_engine.go:659-670`：
```go
sticky := partition.Kind() == enumspb.TASK_QUEUE_KIND_STICKY
...
} else if sticky && !stickyWorkerAvailable(pm) {
    return "", false, serviceerrors.NewStickyWorkerUnavailable()
}
```
`service/matching/fair_task_reader.go:353-360`：
```go
// - versioning says StickyWorkerUnavailable
if _, ok := errors.AsType[*serviceerrors.StickyWorkerUnavailable](err); ok {
    return dropReasonStickyWorkerUnavailable // drop the task
}
```

**Temporal 的语义**：sticky 是**性能优化**（尽量派回原 worker），**不可用时降级到普通队列**——sticky **不是语义约束**。

**我方对照（语义分歧点，必须澄清）**：
- 我方 `task.executorId`（pinning）的语义是**「我指定这一台」**——`executor.service.ts:5166-5171` 注释明确：「a pinned executor at capacity fails the dispatch (**no fallback to another executor — that is the point of pinning**）」。
- **这是与我方根本不同的语义**：Temporal 的 sticky = 优化；我方的 pinned = **约束**。
- **因此不可直接照搬 Temporal 的降级**。但 Temporal 的做法揭示了一个**当前未区分的问题**：

| 我方 pinned 失败态 | 当前错误码 | HTTP 状态 | 用户看到 |
|---|---|---|---|
| 设备不存在 | `PINNED_EXECUTOR_NOT_FOUND` | **500** | 「指定的固定执行器 {{executorId}} 不存在」 |
| 设备离线 | `PINNED_EXECUTOR_OFFLINE` | **500** | 「指定的固定执行器 "{{appName}}" ({{executorId}}) 已离线」 |
| 设备满载 | → 占坑返回 `unavailable` → 落到 `NO_DISPATCHABLE_EXECUTOR` | **500** | 「没有可用的执行器（所有候选执行器都已离线或达到容量上限）」—— **完全丢失了「是 pinned 那台满了」这个信息** |

**发现（新增 finding F-13）**：**pinned 执行器满载时，用户看到的文案是「没有可用的执行器（所有候选执行器都已离线或达到容量上限）」——完全不提 pinned**。这与 pinned 离线/不存在的文案形态**不一致**，运维排查时无法区分「pinned 设备满了」（可等）与「pinned 设备挂了」（要处理）。**建议**：为 pinned 满载增设独立错误码（如 `PINNED_EXECUTOR_AT_CAPACITY`），并在 `task.processor.ts` 的分类链中**显式识别**（现状：它落 `NO_DISPATCHABLE_EXECUTOR` → 归 `EXECUTOR_OFFLINE` → **可重试**；语义上「设备满了」确实可重试，但归因文案错了）。

### 2.3 Ack / Read Level 分离 → at-least-once 显式化

`service/matching/fairness.md`：
```
A is the ack level (persisted): We have dispatched all tasks <= A. ...
A can only move forwards within the lifetime of a partition. However, we don't write A to
persistence on every dispatch, we only update it once in a while. So one partition owner may
move A forwards in memory, then crash, then another owner may load the partition. In that case
it will see an old version of A. **This is allowed to cause repeated dispatch of some tasks.**
```

**我方对照**：`executor.service.ts:5728-5756` 的派发失败回滚（减 `runningTaskCount`）+ 占坑成功但 HTTP 失败 → 回滚 → 任务重试 → **可能重复派发**。我方注释（`:5496-5511`）已明确讨论过「良性并发误判」，但**没有把「重复派发」作为显式语义写下来**。

**采纳建议**：在 `dispatch()` 的方法头注里**显式声明 at-least-once 语义与重复派发窗口**（低成本、纯文档、零风险），并列出「哪些异常路径会导致重复派发」。

### 2.4 Temporal 的不足（对我方的警示）

| 缺陷 | 对我方的意义 |
|---|---|
| **持久化工作流引擎**（activity 超时/重试由 server 保证，history 不可变） | 我方是**短任务执行器**，无 workflow 概念；Temporal 的复杂度远超需求 |
| **全局命名空间 + namespace 隔离** | 我方多租户靠 `projectId` 列，无 namespace 概念 |
| **sticky 与我方 pinned 语义相反** | **不可照搬降级策略**（见 2.2） |
| **匹配引擎与业务完全解耦**（matching 服务独立部署） | 我方是单体 admin-api，**过度解耦无收益** |

---

## 3. Kubernetes Scheduler（Apache-2.0）—— 架构级最高价值

### 3.1 Filter + Score 两阶段框架

k8s 调度器的核心插件接口（`pkg/scheduler/framework/types.go`）：

```go
type FilterPlugin interface {
    Plugin
    Filter(ctx context.Context, state *CycleState, p *v1.Pod, nodeInfo *framework.NodeInfo) *Status
}
type ScorePlugin interface {
    Plugin
    Score(ctx context.Context, state *CycleState, p *v1.Pod, nodeInfo *framework.NodeInfo) (int64, *Status)
}
```

**关键语义**：Filter 返回 `Success` / `Unschedulable`（**不可调度即不调度**）；Score 返回 `int64` 权重（**越大越优**），**所有 Score 插件的分数相加**后再取最高。

### 3.2 我方对照：当前把「硬过滤」与「软偏好」混在一个方法里

`executor.service.ts:5245-5352` 的 dispatch 过滤链：

| 维度 | 我方当前形态 | k8s 对应 | 语义 |
|---|---|---|---|
| `executorAppName` 点名 | **硬过滤**（filter，`:5247`） | Filter | 硬 |
| `executorGroup` | **硬过滤**（`:5272`） | Filter | 硬 |
| `executorTags`（AND 子集） | **硬过滤**（`:5277`） | Filter | 硬 |
| `executorAffinityTags`（OR 命中） | **硬过滤**（`:5292`） | Filter（硬亲和）或 Score（软亲和） | ⚠️ **我方固定为硬** |
| `executorAntiAffinityTags` | **硬过滤**（`:5307`） | Filter（反亲和） | 硬 |
| `runtime` / capabilities | **硬过滤**（`:5317`） | Filter | 硬 |
| interpreter 缓存池 | **硬过滤**（`:5328`） | Filter | 硬（但我方 3.8+ 允许在线下载绕过） |
| 负载评分（load/cpu/mem/longTask） | **Score**（`:5362` `computeExecutorLoadScore`） | Score | 软 |
| 部署归属（ARCH-35） | **分区前置**（`:5436` `partitionByDeploymentAffinity`） | Score（ImageLocality 式） | ⚠️ **我方是「分组前置」而非「加分」** |
| 解释器真缓存（2026-10-31） | **分区前置**（`:5471` `partitionByInterpreterCache`） | Score（Affinity 式） | ⚠️ 同上 |

**核心洞察**：
1. 我方**已经有** Score 阶段（`computeExecutorLoadScore`），但**只有 4 个信号**（load/cpu/mem/estimated）。部署归属、解释器真缓存这两个软信号被实现为**「分组前置」**——**这在语义上等价于「无限大的权重」**，但**丢失了打分能力**（无法表达「部署归属值得 +0.3 分，解释器缓存值得 +0.1 分」）。
2. **Hatchet 的加权 + k8s 的 Score 相加**，两者结合就是我方想要的形态：**把 4 个软信号统一进 `computeExecutorLoadScore`**，把「分区前置」降级为「加分」。

**采纳建议（§5 阶段 3.3 的核心）**：
```
新 score = 0.5×loadRatio + 0.25×cpuRatio + 0.25×memRatio + 0.1×longTaskPenalty
           + w_deploy×deploymentAffinity + w_interp×interpreterCacheAffinity
```
`w_deploy` / `w_interp` 由配置项控制，**默认 0**（= 保持现有「分区前置」行为不变）→ **灰度安全**。

### 3.3 k8s 的 NodeAffinity / PodAffinity：硬软分离

`pkg/scheduler/framework/plugins/nodeaffinity/`：
- `NodeAffinity`（**硬**）：`requiredDuringSchedulingIgnoredDuringExecution` 的 `nodeSelectorTerms` → 不满足即 `Unschedulable`；
- `PreferredDuringSchedulingIgnoredDuringExecution`（**软**）→ 变成 **Score 加成**（`nodeaffinity.NewScore` 按偏好权重累加）。

**这正是我方 affinity「硬 vs 软」统一的模板**：
- 硬亲和（用户明确「必须在那台」）→ Filter；
- 软亲和（用户「优先那台」）→ Score。

**我方当前的问题**：`task.executorAffinityTags` 在 `dispatch` 里是**硬过滤**（`:5291-5298`），在 `dispatchBroadcast` 里被**显式裁决为「收窄扇出面」**（`:6195-6203` 注释），在 `selectLeastLoaded` 里**完全缺失**（`:4632-4668`）。**三种语义，三处实现。** k8s 的硬软分离能一次性统一这三种。

### 3.4 k8s 的不足（对我方的警示）

| 缺陷 | 对我方的意义 |
|---|---|
| **Filter 失败 = 不可调度**（不降级） | 我方 dispatch 的「降级回全机队」（`:5382-5390` 注释）是**核心产品语义**，与 k8s 相反 → **不能照搬** |
| **kube-apiserver + etcd + informer 缓存** | 我方是单体 admin-api + TypeORM，无此层 |
| **Pod ↔ Node 是 1:N 亲和** | 我方 Executor ↔ Deployment 是 N:M，更复杂 |
| **Score 是「插件分数相加」的线性模型** | 无法表达「必须有解释器缓存」这类**组合约束** → 我方的 interpreter 过滤**必须留在 Filter** |

---

## 4. Airflow（Apache-2.0）—— Pool / Slot 抽象

### 4.1 Pool 模型

`airflow/models/pool.py`：
- `Pool` 有 `slots`（总并发）、`occupied_slots`、`queued_slots` 三列；
- `include_deferred` 标志决定「deferred 任务是否占用 slot」；
- 调度时检查 `pool.occupied_slots + pool.queued_slots + 1 <= pool.slots`。

### 4.2 我方对照：互斥组的占位语义缺口（**新增 finding F-14**）

我方 `claimExecutorSlotForExecution` 的组占用计数（`executor.service.ts:5002-5012`）：

```sql
-- global 档
SELECT COUNT(*)::int AS count FROM "task_executions"
 WHERE "mutexGroupId" = $1 AND "status" = 'running' AND "id" <> $2
-- device 档
SELECT COUNT(*)::int AS count FROM "task_executions"
 WHERE "executorAddress" = $1 AND "mutexGroupId" = $2 AND "status" = 'running'
```

**只数 `status = 'running'`**。而**排队中（`status = 'waiting'`）的执行不计入组占用**。

**后果（具体推演）**：
- 应用挂互斥组，`maxConcurrentPerDevice = 1`；
- 派发 10 个任务到**同一台执行器**：
  - 第 1 个：占坑成功（组占用 0 → 1 ≤ 1 ✓），执行中；
  - 第 2 个：占坑时 `occRows.count = 1 >= 1` → 返回 `mutex_full` → **抛 `MutexWaitError` → WAITING**（`:5537-5539`）；
  - 第 3~10 个：同上 → WAITING。
- **看起来正确**。但换一个场景：
  - 派发 10 个任务到**10 台不同执行器**（device 档，组并发数 1）：
    - 第 1 个在执行器 A 上跑（组占用 A×组 = 1）；
    - 第 2 个落到执行器 B：**B 的组占用计数 = 0**（A 上的那个占用的是 **A 的地址**）→ **占坑成功** → **组内并发数 1 的语义被突破**（A 和 B 同时在跑同组任务）。
  - **这在 device 档是设计如此**（device 档 = 同设备 × 同组互斥，注释 `:4961` 明说「device=单点互斥（同设备×同组，存量行为）」）→ **不是缺陷，是刻意的语义**。
- **但 global 档（`scope = 'global'`，`:4963`）的语义是「组内跨设备串行」**——此时计数是全组的 running，**排队的执行不计入**：
  - 组并发数 1，10 台设备；
  - 第 1 个在 A 上跑；第 2~10 个**全部占坑成功**（因为 `occRows.count` 只数 running，第 1 个在跑 → count=1 → `1 >= 1` → 应该是 mutex_full！）。

  **重新推演**：global 档第 2 个的 `occRows.count = 1`（A 上的 running）→ `1 >= maxConcurrentPerDevice(1)` → `mutex_full` ✓。**正确**。

  那第 3~10 个呢？它们同样查 `occRows.count`——**注意 `occRows` 是在 `FOR UPDATE` 行锁内读的**（`:4984-4988` 锁的是**执行器行**，不是组行……不对，global 档**先锁组行**：`:4970-4975` `SELECT "id" FROM "mutex_groups" WHERE "id" = $1 FOR UPDATE`）→ **global 档下组行锁串行化所有竞争者** → 每次只有一个事务进入 → `occRows.count` 精确 → 第 2~10 个全部 `mutex_full` ✓。

**结论修正**：**我方 global 档的互斥计数是正确的**（组行锁保证了串行化）。**但 device 档的「组并发数」实际语义是「每设备每组并发数」**（`maxConcurrentPerDevice` 字段名如实反映了这点）——**跨设备的组并发数在 device 档下不生效**。

**→ 真实缺口（F-14）**：`MutexGroup.maxConcurrentPerDevice` 这个字段名暗示「组并发数」，但 **device 档下它实际是「单设备内的组并发数」**。若用户以为设了 1 就意味着「整个组同时只跑 1 个」，在 device 档下会**同时在 N 台设备上跑 N 个**。**这是语义歧义，不是实现缺陷**，但需在文档/UI 层澄清。

**Airflow Pool 的启发**：Airflow 的 `occupied + queued` 双计数能表达「组内总在途（含等待）≤ 组并发数」的更强约束。但我方 device 档本就是「按设备计」，套 Airflow 语义会**改变 device 档的行为** → **需主 Agent 拍板**（`dispatch-core.md` §8 D-1）。

### 4.3 Airflow 的不足

| 缺陷 | 对我方的意义 |
|---|---|
| Pool 是**独立的计数行**（乐观锁递增），与「谁在跑」分离 | 我方是**从执行行反推占用**（`:5002-5012`），注释自述「无第二账本」设计的代价是「释放也是对执行行的写」——**我方已经避免了双账本的一致性问题**，Airflow 反而是反面教材 |
| Airflow 的 pool 排队是**无限等待** | 我方有 WAITING + 10s sweep（更精细，有明确终态） |
| Airflow 的 pool 抢占语义弱 | 不适用我方的抢占式占坑 |

---

## 5. Celery（BSD-3-Clause）—— 路由与 worker 池

### 5.1 核心亮点

- **路由表**（`celery/app/routes.py`）：`task_type → queue` 映射；
- **prefetch 公平分发**（`celery/worker/consumer/consumer.py`）：每 worker 的预取上限，避免单 worker 抢光队列；
- **优先级队列**（`celery/app/amqp.py`）：`task_priority` 0-9；
- **多队列 + 每队列独立 worker 池**。

### 5.2 我方对照

| Celery | 我方 | 差距 |
|---|---|---|
| 路由表（task_type → queue） | **单一队列** `task-queue` | 我方所有任务类型共用一个队列 |
| prefetch 限制 | BullMQ `concurrency: 5`（`task.processor.ts:88`） | 我方 worker 并发固定 5，**无按执行器/任务类型的区分** |
| 优先级队列 | `Task.priority` 列存在但**派发链不消费** | 优先级语义未接入 |
| 每队列独立 worker 池 | 单一队列 | 任务类型无隔离 |

**采纳建议**：
1. **prefetch 思想** → 我方派发 HTTP 慢（`axios.post` timeout = `(task.timeout+10)*1000` 秒，`:5720`）→ **单个慢派发会占住一个 worker 槽**。BullMQ 的 `concurrency: 5` 意味着 **5 个慢派发就能把整个派发队列堵死**。Celery 的 prefetch 是**每 worker 预取上限**（防止单个 worker 囤积），BullMQ v11 没有直接的 prefetch 概念（job 被 worker 取走即「预取」）。**可借鉴的等价做法**：限制**同时在途的 HTTP 派发数**（信号量），与 worker 并发解耦。**低-中优先级**。
2. **优先级接入** → 我方 `Task.priority` 未被 `dispatch()` 消费。**这是一个独立缺口**（不在本域切口内，登记为观察项）。
3. **路由表** → 我方暂无多队列需求（单队列 + 类型由 `executeMode` 字段区分）。**不采纳**。

### 5.3 Celery 的不足

- **Python-only**，我方中台是 TS → 零代码复用；
- **单机进程池**，无跨机调度；
- 优先级模型（0-9）与我方 `priority` 语义不对齐。

---

## 6. Nomad（≤1.6.0 为 MPL-2.0；≥1.7.0 为 BSL 1.1）—— 计划-再验证两阶段

### 6.1 核心亮点

Nomad 的调度是**两阶段**：
1. **Plan**：调度器算出「应该把这个 allocation 放到哪个 node」（含 feasibility 检查）；
2. **Apply**：真正下发到 client 时**再次验证** placement 是否仍有效（node 是否还在、容量是否够）。

### 6.2 我方对照

我方 `dispatch()` 的候选查询与占坑之间存在**时间窗**：
```
:5241  candidates = all            ← 候选池查完（DB 读）
:5358  estimatedDurations          ← 又两次 DB 读
:5378  sort                        ← 排序
:5520  for each candidate → 占坑   ← 才写 DB
```
**这个窗口内设备可能已被别人占掉**。我方**已经用正确的方式兜底**了——占坑 UPDATE 的原子性（`:4925-4935` 的 `WHERE runningTaskCount < max AND status = ONLINE`），**这比 Nomad 的「再验证」更严格**（Nomad 的再验证仍可能有竞态，只是窗口更小）。

**采纳建议**：Nomad 的思路**不构成本域缺陷**。唯一可借鉴的是**观测**：「首选候选占坑失败 → 试下一个」这个循环（`:5520-5533`）在决策日志里**只记了最终选中者**（`topRunners` 记的是**评分前三**，不是**占坑失败原因**）。建议**补一条决策日志字段**：`claimAttempts`（尝试了几个候选、各自的失败原因 `unavailable`/`mutex_full`）——**低成本、高可观测性收益**。

---

## 7. Sentinel（Apache-2.0）/ Resilience4j（Apache-2.0）—— 熔断限流

### 7.1 核心亮点

- **Sentinel**：熔断（`OPEN`/`HALF_OPEN`/`CLOSED` 状态机）、限流、热点参数、系统自适应保护；
- **Resilience4j**：Bulkhead（舱壁）、RateLimiter（令牌桶）、CircuitBreaker、TimeLimiter。

### 7.2 我方对照

| 机制 | 我方现状 | 采纳价值 |
|---|---|---|
| **Bulkhead（舱壁）** | **已有**——`maxConcurrentTasks` 就是对单执行器的舱壁（`executor.service.ts:4931-4934` `WHERE runningTaskCount < :max`） | ✅ 已是此形态，**无需改造** |
| **出站熔断** | **无**——我方对同一离线执行器连续派发失败无短路，每次都走完整候选链 | 🟡 **低优先级**：候选链本身已有「离线设备被 `status = ONLINE` 过滤掉」的天然短路；熔断只省 DB 往返 |
| **RateLimiter** | 无（但 BullMQ 有队列级限速） | 🟢 不适用 |

**风险提示**：若采纳出站熔断，必须与 **pinned 语义**协调——pinned 执行器熔断不应导致「不派发」，只应「跳过该候选」（但 pinned 本就只有 1 个候选 → 熔断 = 直接失败）。**净收益低，不建议本轮做。**

---

## 8. 汇总：对我方的采纳决策

| 项目 | 采纳形态 | 优先级 | 落地位置 | 默认行为 |
|---|---|---|---|---|
| **Hatchet `computeWeight` + 加权** | 把「部署归属」「解释器真缓存」两个软信号并入 `computeExecutorLoadScore`（权重可配） | **高** | 阶段 3.3 | 权重 0（= 现状） |
| **Hatchet `rankWorkerIds` 三态 sticky** | `pinned` / `appName 点名` / `全机队` 三态**类型化**（当前是 189 行嵌套 if） | **高** | 阶段 2.1 决策器 | 语义不变 |
| **Hatchet `ringOffset`** | 同分候选并列组内轮转 | 中 | 阶段 3.3 | 关闭 |
| **Hatchet slot 池整池过期** | 估时采样池引入 epoch/过期 | 中 | 阶段 3.3 | — |
| **k8s Filter/Score 两阶段** | 决策器内部结构：硬过滤段 + 打分段 | **高** | 阶段 2.1 | 语义不变 |
| **k8s 硬/软亲和分离** | affinity 拆成「硬过滤」与「软加分」两个可配形态 | 中 | 阶段 3.3 | 硬（现状） |
| **Temporal sticky 降级** | **不采纳**（语义相反）；但**新增 pinned 满载的独立错误码** | 中 | 阶段 1.2 | — |
| **Temporal at-least-once 显式化** | `dispatch()` 头注写明重复派发窗口 | 低 | 阶段 2.1 | 纯文档 |
| **Airflow Pool 双计数** | **需拍板**（改变 device 档行为） | 待定 | §8 D-1 | — |
| **Celery prefetch** | 在途 HTTP 派发数信号量 | 低-中 | 观察 | — |
| **Nomad 计划-再验证** | **不采纳**（我方占坑原子性更强）；但补 `claimAttempts` 决策日志字段 | 低 | 阶段 1.4 | — |
| **Sentinel/Resilience4j 熔断** | **不采纳**（净收益低） | 🟢 不做 | — | — |
| **Celery 优先级队列 / Temporal 公平分层** | **不采纳**（独立缺口，另立项） | 🟢 观察 | — | — |

---

## 9. 补充 finding（本次调研新发现，建议并入 `dispatch-core.md` §1）

| ID | finding | 位置 | 证据 |
|---|---|---|---|
| **F-13** | **pinned 执行器满载时丢失 pinned 语义**：落 `NO_DISPATCHABLE_EXECUTOR`，文案「没有可用的执行器（所有候选执行器都已离线或达到容量上限）」，与 pinned 离线/不存在的文案形态不一致，运维无法区分「pinned 设备满了」（可等）与「pinned 设备挂了」（要处理） | `executor.service.ts:5520-5555` + `catalog/executor.ts` 的 `NO_DISPATCHABLE_EXECUTOR` | 占坑循环只区分 `claimed` / `mutex_full` / `unavailable`（`:5525-5532`），`unavailable`（满载）与「离线」不可区分；pinned 分支（`:5165-5222`）**未对满载单独处理** |
| **F-14** | **`MutexGroup.maxConcurrentPerDevice` 的语义歧义**：字段名暗示「组并发数」，但 device 档下实际是「单设备内的组并发数」——跨设备不生效（global 档才是全平台） | `executor.service.ts:4961-4963`（device/global 分档）、`:5002-5012`（按 `executorAddress` 计数） | device 档的计数谓词含 `"executorAddress" = $1`；global 档只按 `mutexGroupId` 计数 |
| **F-15** | **`Task.priority` 未接入派发链**：实体有 `priority` 列且在版本回滚白名单里（`task.service.ts:713`），但 `dispatch()` 完全不读它——优先级语义在调度面**未实现** | `task.service.ts:713`（`VERSION_ROLLBACK_COLUMNS` 含 `priority`）；`executor.service.ts:5146-5758` 无 `priority` 引用 | grep `priority` 在 dispatch 行段零命中 |
| **F-16** | **决策日志缺「占坑尝试轨迹」**：只记评分前三与最终选中者，**不记**实际占坑时试了几个候选、各自失败原因（满载 / 离线 / 互斥满） | `executor.service.ts:4805-4891`（`logExecutionDispatchDecision` 入参无 `claimAttempts`） | 占坑循环 `:5520-5533` 收集了 `anyMutexBlocked` 但**未落日志** |

---

## 10. 引用来源

- 本机源码（只读）：`/home/yongsheng/project/open_sourse/hatchet-main/pkg/scheduling/v1/{scheduler.go,worker.go,action.go,slot_pool.go,queuer.go,concurrency.go,concurrency/strategy.go,concurrency/slot.go,pool.go,snapshot.go,lease_manager.go}`
- 本机源码（只读）：`/home/yongsheng/project/open_sourse/temporal-main/service/matching/{fairness.md,fairness_util.go,matching_engine.go,fair_task_reader.go}`
- 联网核验（GitHub API，只读）：`https://api.github.com/repos/{celery/celery, kubernetes/kubernetes, apache/airflow, hashicorp/nomad, alibaba/Sentinel, resilience4j/resilience4j}/license`
- 既有调研产物（只读，避免重复）：`/home/yongsheng/project/open_sourse/agent_talk/03_recommendations/01-priority-register.md` —— **该册子的 27 条候选 + 6 条裁定新增中无一条属于 dispatch-core 域**（已逐条 grep `dispatch`/`executor` 核对），故本报告与既有调研**无重叠**，可独立放行。
