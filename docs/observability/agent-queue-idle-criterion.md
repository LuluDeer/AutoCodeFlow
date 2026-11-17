# 「队列空转」（queue idle-stuck）判定判据

> R206 立项。**先定判据，再写代码**（R388）。按 R393 的纪律：**先列「候选信号 × 它会被什么打穿」**。
>
> 状态：**判据已定 + 纯函数已实现并测**（`agent-queue-idle-check.ts`）+ **接线已落地并测**
> （R207：`agent-queue-idle.service.ts` / `GET /agent/sessions/queue-idle` / `QueueIdleBadge`，
> 见 §6）。

## 1. 要解决的缺陷（**第四个的补充，不是第五个**）

R205 已落地「队列停摆」（有活排队但**没有 worker**）。但它**覆盖不到**另一种形态：

> **worker 还在注册表里、`active > 0`（它确实在处理东西），却再也没有新 job 被消费。**

典型场景：
- worker 的 `getNextJob()` 调用**卡住**（连接池耗尽 / Redis 卡顿 / 事件循环被同步重活长期占住）；
- worker 处理完一个 job 后**不再取下一个**（连接泄漏 / 内部异常导致循环退出，但进程还活着、注册表还在）。

⇒ 表现是：**有 job 一直排着，没人动**；而 `active` 可能偶尔 > 0（卡住的那一个还在跑，只是永远跑不完）。

⚠️ R204/R205 曾记录「这类情形**报不出来**（需要跨采样状态）」——**R206 把这个结论推翻了**：
BullMQ 的 job 有 **`timestamp`（入队时间）** ⇒ **「最老 waiting job 的年龄」可以在单次请求内算出**，
**不需要跨采样**。见 §3。

⚠️⚠️ **R207 真机修正（重要，原文写错过）**：本文档 §2/§3.1 原先断言「waiting 底层是 Redis 有序集合
（score = 入队时间）」。**在 BullMQ 9.x 上这是错的** —— 真机实测（`addStandardJob-9.lua` 的
`pushCmd = opts['lifo'] and 'RPUSH' or 'LPUSH'`；`TYPE bull:<q>:wait` → **`list`**）：
`wait` 是 **LIST**，按**插入顺序**排列；`timestamp` 只是 job 自己的一个字段，**不是排序键**。
生产路径上二者**恰好一致**（同一条 `add` 里先算 `timestamp` 再 `LPUSH`）⇒ 取表头**通常**就是最老；
但 `delayed` job 被 promote 进 `wait` 时（本仓 GAP-3 自动续跑 + 普通 job 混合的场景），
它会插到**表头**而 `timestamp` 仍是「当初算 delay 的时刻」⇒ **顺序与 timestamp 错位**。
实测偏差是**把年龄算小**（`[0]` 更年轻）⇒ **偏向漏报，不会误报**（详见 §5）。

## 2. 候选信号 × 它会被什么打穿（R393 的强制步骤）

| 候选信号 | 会被什么打穿 | 结论 |
|---|---|---|
| `waiting > 0` | **合法积压**（并发仅 2，批量触发时 18 个正常排队） | ❌ |
| `active === 0` | **瞬态**（两批 job 之间、刚启动） | ❌ 单独不可用 |
| `waiting` 的**年龄** > N | **合法积压**（跑 5 分钟×18 ⇒ 第 18 个等 45 分钟**是正常的**） | ⚠️ 见 §3.2 |
| **`最老 waiting job 的年龄` > N，且该年龄 > 「单 job 合理耗时」** | ？ | ✅ **采用**（§3） |
| **该 job 的 `attemptsStarted` / `processedOn`** | 无 | ✅ 辅助（§3.3） |

## 3. 判据

> **queue idle-stuck = 存在一个 `waiting` job，其「入队至今」的年龄 > 阈值 T，
> 且该 T **大于**「单个 job 的合理耗时上界」。**

### 3.1 「最老 waiting job 的年龄」怎么算（**单次请求，无状态**）

```ts
const [oldest] = await queue.getWaiting(0, 1);   // 表头 = **最早入队**（LIST，非 ZSET）
const ageMs = Date.now() - oldest.timestamp;      // timestamp = 入队时间
```
- ⚠️ **`getWaiting(0, 1)` 的 `end` 是闭区间** ⇒ 会取 **2 个** job（下标 `0` 和 `1`）；
  无妨（我们只要第一个），但**别以为 `getWaiting(0, 0)` 是「只取 1 个」** —— 在
  `asc=true` 的路径上 `start===0 && end===0` 取的仍是表头那一个，语义容易读错。
- ⚠️ **「第一个 = 最老的」只在「所有 job 都经同一条路径入队」时成立**（R207 真机实测）：
  `wait` 是 **LIST**（插入顺序），不是按 `timestamp` 排序的 ZSET。
  ⇒ 本判据取的是「**最早入队的那个**」的年龄，**不是**「`timestamp` 最小的那个」的年龄。
  两者在有 delayed promote 时会错位；错位方向是**年龄算小 ⇒ 漏报**（§5），可接受但要如实登记。
- **不需要扫全表**（只读 2 个元素），也不需要跨请求状态。

### 3.2 为什么**不能**只用一个固定阈值（**合法积压会打穿**）

`AGENT_QUEUE_CONCURRENCY = 2` ⇒ 一次批量触发 20 个会话、每个跑 5 分钟 ⇒
**最后一个合法地等了 45 分钟**。⇒ 任何 < 45 分钟的阈值都会把**正常排队**报成「空转」。

⇒ **阈值必须由「单 job 的合理耗时上界」推导**，而不是拍脑袋：
本仓 Agent 的一步是「一次模型调用 + 若干工具调用」，且**已有预算闸门**
（轮次 / 令牌 / 墙钟 / 工具调用数任一超限 ⇒ `budget_exceeded`）
⇒ **墙钟预算**就是「单 job 合理耗时」的**现成上界** ⇒ 阈值应取
**墙钟预算的若干倍**，而不是一个独立的魔法数。

### 3.3 `attemptsStarted` / `processedOn` 作辅助（**可选**）

- `attemptsStarted > 0` ⇒ 这个 job **曾经开始过**又回到 waiting（重试）；
- `processedOn` ⇒ 上次被处理的时刻。

⇒ 两者都**不是**判据的**必要条件**（首轮就卡住的 job 两者都没有），但**能加强**判据
（区分「从没开始过」与「开始了但反复重来」）。

### 3.4 与另三条判据**不重叠**（R399 的强制步骤）

| 判据 | 覆盖 | 本条**不**覆盖 |
|---|---|---|
| 待接管（R198） | `waiting_input` 正常等人 | — |
| 卡住（R199） | `running` 但久无进展（看**最近 step**） | — |
| 积压（R201/R203） | `pending` 且**队列里没有 job** | — |
| 队列停摆（R204/R205） | 有活 + **没有 worker**（或队列被暂停） | 本条覆盖的是「**worker 在、却不再消费**」 |

⇒ 五者互补：本条补的是「**有人但不干活**」。

⚠️ **判定顺序：停摆优先**（R207 落地）。若已停摆，本条**让位**
（API 返回 `suppressedBy: "queue-stall"`、徽标**静默**）—— 否则同一现象会同时点亮
两个徽标，而运营的注意力是稀缺资源。让位是**完整判定**，**不等于**「读不到」
（后者走 `degraded`）：把两者压成同一条分支的实现会被 `queue-idle-badge.test.tsx` ④ 抓红。

## 4. 动作：**只告警**（与其它三条一致）

自动处置（例如把那些 job 重新入队、杀掉 worker）都可能**造成真实损害**（重复执行）。
⇒ 人的动作是：**查 worker 进程 / Redis 连接**。

## 5. 已知边界（**如实登记**）

- **阈值依赖「墙钟预算」这个外部量** ⇒ 本仓的墙钟预算改了，本阈值要跟着改
  ⇒ 接线层**从配置读**预算并推导阈值（§6），**不要**在这里写死魔法数。
- **`getWaiting` 只覆盖 `waiting`**（不含 `delayed` / `prioritized`）。
  `delayed` job 的「年龄」语义不同（它是**故意**延迟的）⇒ 本条**刻意不覆盖** `delayed`。
- **误报窗口**：墙钟判定发生在**每轮开头**，真实结束时刻会略晚于 `wallClockMs`，
  且一次 LLM 调用的超时没有上界 ⇒ 阈值只加了「一拍」（心跳间隔），**不是**按最坏
  LLM 超时放大。⇒ 文案说「**可能**空转」；**只告警不处置**。
- **顺序偏差 ⇒ 只漏报、不误报**（R207 真机实测，见 §1 的修正框）：`delayed` job 被 promote 时
  会插到 `wait` **表头**，而它的 `timestamp` 是「当初算 delay 的时刻」⇒ 取 `[0]` 得到的年龄
  **≤** 真实最老年龄。实测两例：偏差 217ms（小规模）与 6.2s（40 个 job 压着）。
  ⇒ 判据可能**晚一点**才响，但不会把正常队列报成空转。这是刻意接受的取舍：
  要精确取「`timestamp` 最小」就得扫全表（O(n) Redis 往返），而本端点是无状态 GET。
- **真机验证已做（R207 补充）**：`npm run test:r207-queue-idle-live`
  （`scripts/r207-queue-idle-live-probe.mjs`）在**真 Redis 8.10.3 + BullMQ 9.x + 真 Worker**
  上跑 **17 条断言**并全部通过（exit 0）：
  ① 阈值推导 = 3,630,000；② `getWaitingCount`；③ `getWaiting(0,1)` 表头 = **最早入队**；
  ④ `job.timestamp` 反序列化保真；⑤ `attemptsStarted` 可读；⑥ 无 worker ⇒ **停摆成立（本条让位）**；
  ⑦ 判据本体确实会判空转（年龄 4,000,000 > 阈值）⇒ 让位是**必要**的；⑧ 真 worker 占满 2 槽；
  ⑨ worker 在册 ⇒ 停摆**不**成立；⑩ worker 卡住 + 最老 job 超阈值 ⇒ **空转成立**；
  ⑪ 两个判据在真队列上**互斥**；⑫ 放行后恢复消费 ⇒ 不再判空转（正向控制组）；
  ⑭⑮ **顺序偏差真实存在且方向是「年龄算小 ⇒ 只漏报」**（实测表头 759ms vs 真·最老 2h，
  偏差 2 小时）；⑬⑫b⑯ **清理残留 = 0**（不是「我删了」，是「查出来是 0」）。
  **反证**：把 ⑨ 的断言改坏 ⇒ 该条立刻红（16/17），证明它不是恒真。
  ⚠️ **仍有边界（如实登记）**：探针复刻接线层的**读法**（`getWaiting(0,1)` + `job.timestamp` +
  `attemptsStarted`）并调用**生产纯函数**判定，**没有**启动完整 NestJS 进程去打真实 HTTP 端点；
  也**没有**覆盖「worker 事件循环阻塞导致心跳过期」那一类（那是停摆判据的误报窗口）。

## 6. R207 接线（阈值推导与两个新字段）

### 6.1 阈值怎么来的（R403：不允许魔法数）

```text
thresholdMs = wallClockMs × AGENT_QUEUE_CONCURRENCY + tickMs
            = 1800000     × 2                     + 30000  = 3,630,000（60.5 分钟）
```

每一环都是本仓**已有**的量，不是系数：

| 分量 | 来源 | 为什么它是「正确的那一个」 |
|---|---|---|
| `wallClockMs` | `agent.budget.wallClockMs`（配置面） | 它是**代码层硬闸门**：超时即 `budget_exceeded` ⇒ 单 job 耗时**结构上**不会超过它 |
| `concurrency` | `AGENT_QUEUE_CONCURRENCY`（`agent.processor.ts:34`） | 最老 job 能合法等很久的**唯一**成因是「前面的 job 占满并发槽」⇒ 峰值合法等待 = 槽位 × 上界 |
| `tickMs` | `executor.heartbeatInterval`（默认 30000） | 吸收派发往返 + 「墙钟判定在轮轮开头」的微小超时；**加一拍，不是乘系数** |

⚠️ **任一分量缺失/非法 ⇒ 阈值 0 ⇒ 判据层「不判定」**（宁可漏报）。
**不**回落到默认值：那会把「配置坏了」伪装成「判定正常」，正是本仓主导缺陷类。

### 6.2 API 契约（`GET /agent/sessions/queue-idle`）

`{ idleStuck, oldestAgeMs, thresholdMs, waitingCount, retried, suppressedBy, degraded, basis }`

- `degraded`：任一个观测量读失败 ⇒ **`idleStuck` 恒 false 且标 degraded**（前端显示「未知」）。
- `suppressedBy`：`"queue-stall"` ⇒ 本条让位（§3.4）；`null` ⇒ 本判据是这一格的最终结论。
- `basis`：`{ wallClockMs, concurrency, tickMs, thresholdMs, formula }` —— 把**依据**一起交出去，
  否则下一次调参就会退化成改魔法数。
- 服务缺席（只可能发生在测试装配里）⇒ **显式 503** `AGENT_QUEUE_IDLE_CHECK_UNAVAILABLE`，
  绝不返回「队列在正常消费」。

