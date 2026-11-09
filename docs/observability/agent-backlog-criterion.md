# 「调度积压」（backlogged）判定判据

> R201 立项。**先定判据，再写代码**（R388 纪律：判据文档会替你发现实现里最容易错的那一处）。
>
> 状态：**判据已定 + 纯函数已实现并测**（`agent-backlog-check.ts`）；**接线（徽标/接口）待下一轮**。
> 与 `agent-stalled-criterion.md`（「卡住」）是**两个不同的缺陷**，见 §6 对照表。

## 1. 要解决的问题

一个会话被创建成 `pending` 之后，**没有任何机制**保证它真的会被执行。

`agent-trigger.service.ts:70-76` 自己记录了这条风险（原文）：
> `enqueue` — 行建了、`queue.add` 失败 ⇒ 它**永远不会跑**，而列表上它看起来只是「刚建好」

仓里对此**只有一个计数器**（`autoflow_agent_event_trigger_failed_total{stage="enqueue"}`）——
**指标能告诉你「发生过」，但告诉不了你「现在还有几条卡在那里」**。
而 `sweepStaleRunning()` **只扫 `running`**，`pending` 完全没有清扫（R200 已核实）。

⇒ 结果是：这些会话在列表上**永远是 `pending`**，占着「看起来在排队」的位置，
而**它们排的队根本不存在**。

## 2. 判据

> **backlogged（积压）= 状态是 `pending`，且队列里**查不到**该会话对应的 job（从来没入队 / 已终结）。**

判定细节：`queue.getJob(session.id)`（因为 `queue.add` 用 `jobId: session.id`，见
`agent-trigger.service.ts:352`/`:520`）返回 `undefined`，或返回的 job 状态是
`completed`/`failed` ⇒ **这条 `pending` 永远不会被消费**。

## 3. 为什么**时间阈值是错的**（两条，都实测过；这节是本判据的核心）

第一直觉都是「`pending` 超过 N 分钟就算积压」。**两种写法都会产生大规模误报**：

### 3.1 ❌ 用 `createdAt` 判 —— **被 resume 打穿**

`reopenForResume()`（`agent-session.service.ts:992-1013`）把终态会话**重开**为 `pending`：
```ts
.set({ status: "pending", waitingFor: null, startedAt: new Date(), finishedAt: null })
```
**`createdAt` 不动**（它仍是会话最初创建的时间）。
⇒ 一个 **3 小时前创建、刚刚 resume** 的会话，`createdAt` 是 3 小时前 ⇒
**立刻**被误判成「积压 3 小时」，而它其实**刚刚**才入队。

### 3.2 ❌ 用 `updatedAt` 判 —— **被「合法排队」打穿**

`AGENT_QUEUE_CONCURRENCY = 2`（`agent.processor.ts:26`）。
⇒ 一次批量触发 20 个会话时，**只有 2 个**在跑，其余 18 个**合法地等在队列里**；
若每个会话跑 5 分钟，**第 20 个要等 45 分钟**。
⇒ 任何时间阈值（10min / 15min / 30min）都会把**正常排队**报成积压 ⇒
运营看到一片红，**下次就不看了**（这比没有判据更糟 —— 本仓「登记盲区 ≠ 放任盲区」的反面）。

⚠️ 注意这与「卡住」判据**恰好相反**：
- **stalled（running）**：**必须避开** `updatedAt`（维护性写入会污染它，见 R200），用**最近 step 时间**；
- **backlog（pending）**：**不能用** `createdAt`（resume 会让它过期），也**不能用**纯时间阈值
  （合法排队会误报）⇒ **只能查队列**。

⇒ **同一个"时间列"，在两个判据里一个是陷阱、一个是必需** —— 这就是为什么判据必须逐条写清
「为什么是这个信号」，而不能套模板。

## 4. 为什么查队列是**唯一零误报**的做法

`jobId: session.id` 给了**直接映射**（这是本判据可行的**前提**）。

| 情形 | 队列里有没有 job | 判定 |
|---|---|---|
| 刚创建、正常排队 | ✅ 在（`waiting`/`delayed`/`active`） | **不是积压** |
| 正在执行 | ✅ 在（`active`） | **不是积压** |
| `queue.add` 失败 | ❌ 不在 | **积压** ✅ |
| job 已 `completed`/`failed` 而会话仍 `pending` | ❌ 已终结 | **积压** ✅ |
| Worker 全挂、队列停摆 | ✅ 在（`waiting` 堆积） | **不是积压**（是「队列停摆」，另一个判据） |

⚠️ **最后一行很重要**：**队列停摆**（有 job 但没人消费）**不是**本判据的范畴 ——
本判据只回答「**这条会话的 job 是否存在**」。队列停摆要靠 `waiting` 堆积的度量/告警，**另一个判据**。

## 5. 阈值 / 动作

- **没有时间阈值**（§3 已论证）。
- **动作：只告警，不自动处置。** 为什么**不**像 `sweepStaleRunning` 那样自动收敛成 `failed`：
  - `queue.add` 失败是**可恢复**的（重新 `add` 一次即可，会话行和预算都还好好的）；
  - 自动判 `failed` 会让运营**只能走 resume**（多一步、且 resume 有「steps 被清理则拒绝」的限制）；
  - 相比之下「**补一次 enqueue**」是**幂等且无损**的修复动作（`jobId` 相同 ⇒ 重复 add 是安全的）。
  ⇒ 正确的人工动作是「**重新入队**」，这需要会话**仍是 `pending`**，所以**绝不能**自动改状态。
  ⇒ **自动补 enqueue 本身**属独立立项（要处理「谁会去补」「补几次」「怎么防止反复补」）。

## 6. 与「卡住」（stalled）的对照（**两个判据，别合并**）

| | **stalled**（卡住） | **backlogged**（积压） |
|---|---|---|
| 状态 | `running` | `pending` |
| 现象 | 跑着跑着不动了 | 根本没开始跑 |
| 信号 | **最近一步 `AgentStep.createdAt`** | **队列里有没有 `jobId = session.id` 的 job** |
| 为什么不用时间列 | `updatedAt` 被维护写污染（R200 实证） | `createdAt` 被 resume 打穿、纯时间会被合法排队打穿（§3） |
| 阈值 | 15 min（告警）/ 30 min（处置） | **无**（§3/§5） |
| 动作 | 徽标告警；30 min 后 `sweepStaleRunning` 自动收敛 | **只告警**（人工「重新入队」） |
| 归谁 | 运营（需要判断要不要杀掉） | 运维（重新入队即可恢复） |

⇒ 两者**互斥**（状态不同），可以同时各有一个徽标。

## 7. 已知边界（**如实登记**）

- **依赖 `jobId === session.id` 这个约定**。若将来改成随机 `jobId`（例如为了允许同一会话多次入队），
  本判据会**全部误报成积压** ⇒ 那时必须改成「按 `data.sessionId` 扫描 job」。
  ⇒ 该约定应当被**用例钉住**（`agent-backlog-check.spec.ts` 断言判据的输入是 sessionId）。
- **只查「job 存不存在」，不查「job 是否卡在 waiting 太久」** —— 后者是「队列停摆」，另一个判据（§4）。
- **需要 N 次 `queue.getJob`**（N = pending 会话数）。pending 会话**本应**很少（正常情况下几秒内就被消费），
  ⇒ 可接受；但要给 N 设上限（与 `sweepStaleRunning` 的 `take: 1000` 同款纪律）。
- **未实现的部分**：接口/徽标接线（**本轮只做判据 + 纯函数**，见文首状态）。
