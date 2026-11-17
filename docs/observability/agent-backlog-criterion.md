# 「调度积压」（backlogged）判定判据

> R201 立项。**先定判据，再写代码**（R388 纪律：判据文档会替你发现实现里最容易错的那一处）。
>
> 状态：**判据已定 + 纯函数已实现并测**（`agent-backlog-check.ts`）+ **接线已落地**
> （R202/R203：`agent-backlog.service.ts` / `GET /agent/sessions/backlogged` / `BacklogBadge`）。
> **R215 发现并修掉一处误报路径**：`jobId === session.id` 这个前提**只对首跑成立**，
> resume 入队的 job 用的是别的 id ⇒ 判据会把**正在正常排队等消费**的会话误报成积压（见 §8）。
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

- **依赖 `jobId === session.id` 这个约定 —— R215 实测确认它已经**不成立**（这条边界写对了，但被当成「将来」）**。
  本仓**已有三处** resume 入队用的是**别的 jobId**：

  | 入口 | 位置 | jobId |
  |---|---|---|
  | 人工恢复 | `agent.controller.ts:455` | `${id}:resume:${Date.now()}` |
  | 审批通过后自动续跑 | `agent.controller.ts:550` | `${sessionId}:resume:${Date.now()}` |
  | LLM 瞬时错误自动重试 | `agent.module.ts:177`（`autoResumeJobId`） | `auto-resume-${sessionId}` |

  ⇒ 一个「**审批通过、正在正常等消费**」的会话，`getJob(session.id)` 查不到 ⇒ **误报成积压**。
  修法与影响见 §8。
- **只查「job 存不存在」，不查「job 是否卡在 waiting 太久」** —— 后者是「队列停摆」，另一个判据（§4）。
- **需要 N 次 `queue.getJob`**（N = pending 会话数）。pending 会话**本应**很少（正常情况下几秒内就被消费），
  ⇒ 可接受；但要给 N 设上限（与 `sweepStaleRunning` 的 `take: 1000` 同款纪律）。
- **未实现的部分**：接口/徽标接线（**本轮只做判据 + 纯函数**，见文首状态）。

## 8. R215：`jobId === session.id` 只在**首跑**成立（误报路径，已修）

### 8.1 缺陷

判据的实现是 `queue.getJob(session.id)`（R202）。但本仓 **三条 resume 路径**的 jobId 都不是 `session.id`（见 §7 的表）。
⇒ 以下这条**完全正常**的链路会被判成「积压」：

```text
会话 waiting_input（等审批）
  → 管理员批准 → controller 以 jobId=`${id}:resume:${ts}` 入队
  → 会话仍在 pending/waiting_input，job 正在 waiting 里排队
  → 积压对账执行 getJob(session.id) ⇒ undefined ⇒ **判成「积压」** ✗
```

危害：**误报**。运营看到「积压 1」后按提示「重新入队」，而那条会话**本来就会正常执行**
⇒ 多出一条重复 job（同会话跑两遍，双份副作用）。

### 8.2 判据修正（**不改判据的语义，只补全「怎么查」**）

> **backlogged = 状态是 `pending` 且队列里**不存在任何**指向该会话的 job。**
>
> 「指向该会话」= `job.getJob(id) !== undefined` **或** `job.data.sessionId === session.id`。

实现上**不能**退化成「扫描全队列按 data.sessionId 匹配」（那是 O(n) 全表扫，且 `getJobs()` 有上限）。
实际做法（见 `agent-backlog.service.ts`）：

1. 先按既有快路径 `getJob(session.id)` 查（覆盖**首跑**这一最常见形态，**零额外往返**）；
2. 查不到时，再查**该会话的 resume 专用 id**（`<id>:resume:*` 与 `auto-resume-<id>`）——
   这是**有限枚举**（3 个候选），不是全表扫；
3. 三者都查不到才判积压。

⚠️ **`<id>:resume:<ts>` 的 ts 不可枚举** ⇒ 该形态**无法**按 id 直接查。对它的处置是：
用一个**短 TTL 的负缓存**？不 —— 那会引入状态。**R215 的裁定是：把 resume 的 jobId 改成可枚举的**
（见 §8.3），而不是让判据去猜。

### 8.3 配套改动：resume 的 jobId 改为**可枚举**

`${id}:resume:${Date.now()}` 中的时间戳**只用于绕过 BullMQ 的 jobId 去重**（避免「重复 resume 被静默 no-op」）。
但这条去重**本来就该由业务保证**（resume 前已检查 `status === running` ⇒ 409）。
⇒ 改为 **`<id>:resume`**（**不带**时间戳）：

- 它**可枚举** ⇒ 判据能直接查；
- **仍然满足** BullMQ 的「不能含单个冒号，除非恰好 3 段」规则？—— 需要实测确认段数：
  `<uuid>:resume` 是 **2 段** ⇒ **会被拒**。故改成 **`resume-<id>`**（无冒号，与 `autoResumeJobId` 同款）。

⚠️ **去重语义的变化必须如实登记**：改成固定 id 后，「同一会话连续两次 resume」的第二次
会命中**已存在的 job**（BullMQ 对相同 id 的 add 是幂等 no-op，或按 `removeOnComplete` 语义处理）。
⇒ 这**正是我们要的**（第二次 resume 本来就不该产生第二个 job）；但它把「重复 resume」从
「产生两条 job」变成「静默复用一条」—— 需要一条用例钉住这个行为。
