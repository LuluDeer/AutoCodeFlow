# 「队列停摆」（queue stall）判定判据

> R204 立项。**先定判据，再写代码**（R388）。按 R393 的纪律：**先列「候选信号 × 它会被什么打穿」**。
>
> 状态：**判据已定 + 纯函数已实现并测**（`agent-queue-stall-check.ts`）+ **接线已落地**
> （R205：`agent-queue-stall.service.ts` / `GET /agent/sessions/queue-stall` / `QueueStallBadge`）。
> **R210 真机修正**：§2/§3.2 里「事件循环阻塞 ⇒ `workers` 可能漏成 0 ⇒ 误报」这个前提
> **被实测推翻**，见 §3.2 的修正框。
> **R211**：`degraded` 把两种**风险方向相反**的失败压成了同一个布尔，见 §3.5 的拆分。

## 1. 这是**第四个**缺陷，与另三个都不重叠

R198–R203 已经把「异常接管台」的三件套做齐，但**都刻意不覆盖**本条。四者的分工：

| 判据 | 现象 | 观测对象 |
|---|---|---|
| 待接管（R198） | `waiting_input` 正常等人 | 会话状态 |
| 卡住（R199） | `running` 但久无进展 | 会话的**最近 step** |
| 积压（R201/R203） | `pending` 且**队列里没有 job** | 会话 ↔ job 的**存在性** |
| **队列停摆（本条）** | **有 job 排队，但结构上没人能消费** | **队列的 worker 注册面** |

⚠️ 前三条全部是「**某条会话**有什么问题」；本条是「**整个队列**出了什么状况」——
它会让**所有** `pending` 会话一起永远不动，而**积压判据看不见它**
（积压判据问「这个 id 有 job 吗」，答案是**有**，于是判「没积压」——**技术正确、但用户永远等不到**）。

## 2. 候选信号 × 它会被什么打穿（**R393 的强制步骤**）

| 候选信号 | 会被什么打穿 | 结论 |
|---|---|---|
| `waiting > 0`（排队数） | **合法积压**：`AGENT_QUEUE_CONCURRENCY = 2`，一次批量触发 20 个时 18 个正常排队 | ❌ 单独不可用 |
| `active === 0` | **瞬态**：两个 job 之间的间隙、刚启动时 | ❌ 单独不可用 |
| 最老 waiting job 的年龄 > N | **合法积压**（同上：跑 5 分钟×18 个 ⇒ 等 45 分钟是正常的） | ❌ 不可用 |
| `waiting > 0` 且两次采样没变化 | 需要**跨请求状态**（本端点是**无状态** GET）；且采样间隔难定 | ❌ 不可用 |
| **`workers === 0` 且 `waiting > 0`** | ⚠️ **worker 心跳失效**（事件循环阻塞时 `getWorkers()` 可能漏报）⇒ **可能误报** | ✅ **采用**（见 §3 的处置） |
| **`queue.isPaused()` 且 `waiting > 0`** | 无（暂停是**人为显式**状态） | ✅ **采用** |

## 3. 判据

> **queue stall = `pendingJobs > 0` 且（`workers === 0` **或** `queue.isPaused()`）**
>
> 其中 `pendingJobs = waiting + delayed + prioritized`（**在排队的**，不含 active）。

**为什么 `pendingJobs` 要含 `delayed` / `prioritized`**：`delayed`（例如 GAP-3 的自动续跑延迟）
与 `prioritized` 同样是「有活等着被消费」，只看 `waiting` 会**漏掉**它们。

**为什么不含 `active`**：`active > 0` 说明**有 worker 正在干**，那恰恰是「没停摆」。

### 3.1 为什么 `workers === 0` 是**结构性**信号而不是时间猜测

`getWorkers()` 读的是 BullMQ 的 **worker 注册表**（worker 启动时注册、心跳续期）——
它回答的是「**有没有人在这场子里干活**」，而不是「活干得快不快」。
⇒ 它**不受合法积压影响**（有人干活时 `workers ≥ 1`，哪怕 waiting 很长）。

### 3.2 ⚠️ 如实登记：`workers === 0` 的**误报**可能（**R210 真机已重新裁定**）

原文（R204/R205）写的是：「若某个 worker 的**事件循环被阻塞**（同步重活、GC 停顿），
它的心跳可能过期 ⇒ `getWorkers()` 返回空 ⇒ **误报**停摆」。

**R210 在真 Redis + 真 BullMQ 9.x 上实测，这个前提不成立** —— 因为它对
`getWorkers()` 的实现假设是错的：

| 事实 | 证据 |
|---|---|
| `getWorkers()` **不读心跳注册表**，而是数 Redis **`CLIENT LIST`** 里连接名匹配的**连接** | `queue-getters.js:454` 的 `matcher` 拼 `${clientName()}:w:` 前缀；`baseGetClients` 走 `backend.getClientList()` |
| ⇒ **事件循环阻塞 8 秒期间，`workers` 仍是 1** | 实测：handler 同步忙等 8s，外部连接查得 `workers=1`（TCP 连接没断） |
| ⇒ 只有 worker 的**连接真的断开**（进程崩溃 / `worker.close()` / 网络断）才 `workers=0` | 实测：`worker.close()` 后 `workers=0`；此时塞 job ⇒ `waiting=1 / active=0 / workers=0`（**真停摆**） |

**⇒ 两种「workers=0」要分开看**：
- **进程真的没了**（连接断）⇒ `workers=0` 是**结构性事实**，报停摆是**对的**；
- **事件循环阻塞**⇒ 连接还在 ⇒ `workers≥1` ⇒ **本条根本不会走到判定**（不会误报）。

**但误报窗口并没有归零**，只是换了个成因：
- **Redis `CLIENT LIST` 与 worker 的连接可能不同节点**（cluster / 多实例）⇒ 单节点视角可能看不到别的节点上的 worker；
- **`CLIENT LIST` 的可见性依赖 `SETNAME`**（BullMQ 用 client name 标记 worker；GCP 等不支持 `SETNAME` 的环境会**恒返回 1 条假 worker**，见 `baseGetClients` 的 catch）；
- 因此**当 `getWorkersCount()` 抛错**时，接线层回落成 `0` ⇒ 会**假报停摆** —— 这是当前实现里**真实存在**的误报路径（已由 `degraded` 标记，但 `stalled` 仍可能为 true）。

⇒ 处置上仍必须保守（与「积压」「卡住」一致）：
- **只告警，不自动处置**（不改 job、不改会话状态）；
- 徽标文案说「**可能**停摆」（因为第 3 条那种路径确实会把「读不到」算成 0）；
- 判据函数**不做**时间平滑（服务端无状态），接线层额外要求 `active === 0`（§3.3）。

### 3.3 接线建议（降低误报）：`workers === 0` **且** `active === 0`

若 `workers === 0` 但 `active > 0`，说明「**正在处理**（虽然注册表里看不到）」——
那更可能是一次心跳过期，**不是**停摆。⇒ 接线层宜用：

> stall = `pendingJobs > 0` 且 `active === 0` 且（`workers === 0` 或 `isPaused()`）

这样把「心跳过期但仍在干活」这一大类误报**挡掉**（它们 `active > 0`）。

### 3.5 ⚠️ `degraded` 压掉了「风险方向」（R211 拆分）

R205 起，任何**一个**观测量读失败都置 `degraded: true`。但六个观测量读失败时，
对**判定结论**的影响方向是**相反**的 —— 压成同一个布尔，前端就没法据它决定「该不该紧张」：

| 读失败的观测量 | 对 `stalled` 的影响 | 后果 | 风险方向 |
|---|---|---|---|
| `waiting` / `delayed` / `prioritized` | `pendingJobs` 变小 ⇒ **更难**判停摆 | 可能**漏报** | 漏报 |
| `active` | 变小 ⇒ **更容易**判停摆 | 可能**误报** | 误报 |
| **`workers`** | 回落 0 ⇒ **更容易**判停摆 | 可能**误报** | **误报** |
| `paused` | 回落 false ⇒ **更难**判停摆 | 可能**漏报** | 漏报 |

⇒ 同一个 `degraded: true` 既可能是「我们可能漏了」也可能是「我们可能错报了」，
而**运营的动作完全不同**（前者可等，后者要么去查、要么被告知别信）。

**R210 的修法只解决了「不许把读失败算成停摆」**（`workers` 那一路要求它自己读到了），
但**契约没变**：`workers` 仍是 `number`，「真的 0」与「读不到回落成 0」在响应里**同形**。

**R211 的裁定**（最小、向后兼容）——**已落地**（2026-11-18）：
- **`degraded` 语义收窄为「可能导致**误报**的观测失败」** —— 即 `active` / `workers` / `paused`
  这三个**直接参与停摆判定**的量。它们的失败必须让前端说「**未知**」（不敢报也**不敢说正常**）；
- **可能漏报的那三个**（计数类）**不再**把 `degraded` 置 true，而是记在
  **`degradedCounts: boolean`**（新增字段）—— 前端在**已报停摆**时用它补一句
  「在排队数可能不止这些」，**不停摆时它不改变结论**（宁可漏报，不制造假警）；
- **`workers` 读失败**额外用新增字段 **`workersKnown: boolean`** 显式表达
  —— 「`workers === 0`」与「`workers` 未知」**从此不同形**。

**落地后的可观测事实**（R211 真 HTTP 探针断言）：`GET /agent/sessions/queue-stall` 线上响应
= `{stalled, reason, pendingJobs, degraded, degradedCounts, workersKnown}` 六个字段。
徽标据此**分支选文案**：`workersKnown === false` 时用「**没读到** worker 注册情况」，
**不得**说「没有 worker」（那会把回落值说成事实）。
⚠️ 顺带补上了该端点的 **response schema**（此前 `openapi.json` 里只有
`{"200":{"description":""}}` ⇒ 新增字段在契约面完全不可见、前端只能手写类型），
以及 `queue-idle` 的同款缺口 ⇒ OpenAPI 覆盖率 **244 → 246**（棘轮已上探）。

⚠️ **为什么是新增字段而不是改 `workers: number | null`**：后者会让既有
`QueueStallSnapshot` 的**所有**消费者（`isQueueStalled` / `pendingJobCount` /
`queueStallReason` / 前端 `QueueStallSnapshot` / 既有 14 条 spec）都要处理 null，
且 `queue.getWorkersCount()` 的返回值语义会漂移。**新增只读布尔是最小面。**

### 3.4 已被别的判据覆盖的情形（**本条不重复覆盖**）

- **worker 在、job 也在，但 handler 挂死**（`active > 0` 长期不动）：
  那条会话会一直是 `running` ⇒ **R199「卡住」覆盖**（看最近 step 时间）。
- **job 根本不存在**（`queue.add` 失败）：**R201/R203「积压」覆盖**。
⇒ 本条**只**补「有活、没人干」这一格。四格互补，无重叠。

## 4. 动作：**只告警**

理由与另三条一致：自动处置（例如自动 `pause`/`resume`、把 job 重新入队）都可能在
「其实只是心跳过期」时**造成真实损害**（重复执行）。
⇒ 人看到徽标后做的是：**检查 admin-api 进程 / Worker 是否还活着，必要时重启**。

## 5. 已知边界（**如实登记**）

- **`getWorkers()` 的真实语义是「数 Redis `CLIENT LIST` 里的 worker 连接」**，不是「读心跳注册表」
  （R210 真机坐实，见 §3.2）。升级 BullMQ 后要**重跑** `npm run test:r210-stall-live`
  —— 它会断言「阻塞不降 / 断开才降」这两条，版本语义一变就红。
- **`getWorkersCount()` 抛错**：R210 已让**它自己读不到时不判停摆**（`workersKnown === false`），
  R211 又把这个事实**透出到契约**。⇒ 当前实现里**没有**已知的「读失败 ⇒ 假报停摆」路径。
  ⚠️ 但它仍**不是**「万无一失」：`CLIENT LIST` 跨节点看不到别的节点上的 worker、
  GCP 不支持 `SETNAME` 时 `baseGetClients` 的 catch 会返回 1 条假 worker ——
  这两条需要多节点/托管环境才能复现，**只登记不声称**。
- **无状态**：本判据**不做**时间平滑（不比较两次采样）⇒ 单次请求内的瞬时停顿
  （例如恰好在两批 job 之间）**可能**被报出来。§3.3 的 `active === 0` 要求挡掉了大部分。
- **未覆盖**：若 worker 注册正常、`active === 0`、`pending > 0`，但 worker 其实在
  **长时间的空转等待**（例如 `getNextJob` 卡住）⇒ 本判据**报不出来**（形如 §3.2 的反面）。
  这种情形需要「worker 空闲但队列非空且持续 T」的时间判据 ⇒ **需要跨采样状态**，属独立立项。
- **接口/徽标接线**：R205 已落地（见文首状态）。
