# 「卡住」（stalled）判定判据

> R199 立项。**先定判据，再写代码**（本仓纪律：判据没定就动手 = 写出一个「能跑但说不清在判什么」的东西）。
>
> 状态：**已实现**（`AgentSessionService.list({ stalled: true })`）· 前端入口：`AgentSessionsPage` 的
> 「待接管 N」徽标（`waiting_input`）与「卡住 N」徽标（`stalled`）。

## 1. 要解决的问题

Roadmap P1 写的是「**异常接管台**：stalled / escalated 统一队列，运营视角一键接管」。

R198 落地了其中**一半**（`waiting_input` = 等审批/等澄清 ⇒「待接管 N」）。剩下的一半是
**`stalled`（卡住不动）** —— 当前**没有任何机制**能告诉运营「有会话跑着跑着就不动了」。

**为什么这是真问题**：一个 `running` 会话若卡住（例如工具调用挂死、模型调用超时未归因、
执行器失联而回调未到），它会**永远留在 `running`** —— 列表里看上去「在跑」，
既不报错也不结束 ⇒ **运营无从察觉**，而它占着预算与并发槽位。

## 2. 判据

> **stalled（卡住）= 状态是 `running`，且「最近一步 `AgentStep` 的 `createdAt`」距今超过 N 分钟（默认 15）。**

### 2.1 为什么用「最近一步 step 的时间」而**不是**会话的 `updatedAt`

这是本判据**唯一**的技术要点，也是**最容易做错**的地方：

| 候选信号 | 为什么不合适 |
|---|---|
| `AgentSession.updatedAt` | 它是 `@UpdateDateColumn`，但仓里**有多处裸 `createQueryBuilder().update(AgentSession)`**（`autoResumeCount` 递增、`contextFoldStreak` 清零、状态推进等），**绕过** `@UpdateDateColumn` ⇒ `updatedAt` **不只**反映「业务进展」，还混着「重试计数」「上下文折叠」等**维护性写入** ⇒ 一次 `autoResumeCount` 递增就把 `updatedAt` 刷新了 ⇒ **误报**（明明卡住，却显示「刚刚还在动」）。 |
| 最后一条 `AgentToolCall` 的时间 | 工具调用**可以长时间不返回**（那正是卡住的形态之一）⇒ 用它判会把「正在卡住的那个调用」当成「有进展」⇒ **漏报**。 |
| **`AgentStep` 的 `MAX(createdAt)`** | ✅ `AgentStep` 是**纯追加**的：每一步**插一行**（`createdAt` 建了索引 `idx_agent_steps_createdAt`）⇒ 「最近一步的时间」**只在真的有进展时前进** ⇒ 与「业务进展」**严格同向**。 |

⇒ **判据只看 `AgentStep`**，不看 `AgentSession` 的任何时间列。

### 2.2 「没有 step」的 running 会话算什么？

`NOT EXISTS (最近 step 在阈值内)` ⇒ **一个 step 都没有的 `running` 会话算卡住**。

这是**有意的**：一个 `running` 却**从未产生任何 step** 的会话，正是「启动后就挂了」的形态
（更该被看见）。⚠️ 但它也可能是**刚创建**（0~1 秒内还没落第一步）⇒
**因此阈值必须 ≥ 1 分钟**（`STALLED_MAX_MINUTES`/下限钳制保证），
否则新建会话会**瞬间**被判成卡住。

### 2.3 为什么只判 `running`

`waiting_input`（等人工）**不是**卡住 —— 那是**正常等待**，R198 的「待接管 N」已经覆盖它。
`succeeded`/`failed`/`aborted`/`budget_exceeded` 是**终态**，不在「跑着不动」的范畴内。
`pending`（排队中，未开始跑）也不是卡住。

⇒ **判据只覆盖 `running`**，与 `waiting_input` **互不重叠** ⇒ 两个徽标可以同时出现，语义不冲突。

## 3. 阈值

- **默认 15 分钟**：Agent 的一步是「一次模型调用 + 若干工具调用」，大多数步骤在**秒级到分钟级**完成
  ⇒ 15 分钟既不会把「正常的长步骤」误判成卡住，也不会让真卡住的会话**长时间无人察觉**。
- **下限 1 分钟**：见 §2.2（避免新建会话瞬间被判卡住）。
- **上限 1440 分钟（1 天）**：超过一天的 `running` 会话**几乎必然**是卡住/崩溃残留；
  上限保证这个过滤器**永远能判定**（不会因为传了超大阈值就变成「永不判定」）。

## 4. 实现要点

### 4.1 用 `EXISTS` 子查询，**不用 JOIN**

`JOIN agent_steps` 会把一行会话**放大成 N 行**（一个会话几十步）⇒ `getManyAndCount` 的
`COUNT` 会**重复计数**、`skip/take` 分页也会错位。`EXISTS` 只做**存在性判断**、**不改变行数**
⇒ COUNT 与分页都正确。子查询走 `idx_agent_steps_sessionId_seq`（`(sessionId, seq)`）。

### 4.2 阈值钳制在**服务端**

`stalledMinutes` 由客户端传入 ⇒ 必须在服务端钳制（`STALLED_MAX_MINUTES` / 下限 1），
否则「传一个 10^9」就会变成「永远不判定」。

## 5. 判据的可测性（本仓纪律：每条新判据都要有「删掉就红」的用例）

| 用例 | 钉的是 |
|---|---|
| `running` 且最近 step 在阈值内 ⇒ **不**出现在 stalled 结果里 | 判据不会把「正常在跑」误判成卡住 |
| `running` 且最近 step 超过阈值 ⇒ **出现**在 stalled 结果里 | 判据**能**抓到卡住 |
| `running` 但**一个 step 都没有** ⇒ 出现（§2.2） | 启动即挂的形态不会漏 |
| `waiting_input` ⇒ **不**出现 | 与「待接管」不重叠（§2.3） |
| `stalledMinutes` 超上限 ⇒ 被钳到上限（不抛错、不放行） | §4.2 |

## 6. 已知边界（**如实登记**）

- **判据依赖 `agent_steps` 有行**。若某条 `running` 路径**从不落 step**，它会被判成卡住
  （这正是 §2.2 的有意选择，但也意味着**落 step 的完整性**是本判据的前提）。
- **时钟**：用 DB 侧 `createdAt` 与**应用进程**的 `Date.now()` 比较 ⇒ 两者时钟不一致时会偏移。
  （本仓所有 agent 表的时间都由**同一个应用进程**写入 ⇒ 实际同源。）
- **未覆盖**：跨进程重启后残留的 `running` 行（进程崩溃 ⇒ 没有代码把它改成 `failed`）
  —— 本判据**能抓到**它们（它们没有新 step）⇒ 这是它的**主要收益**之一。
