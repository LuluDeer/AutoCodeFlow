# 「观测调用超时」（observation timeout）判定判据

> R213 立项。**先定判据，再写代码**（R388）。按 R393 的纪律：**先列「候选信号 × 它会被什么打穿」**。
>
> 状态：**已落地并真机验证**（R213）：`observation-timeout.util.ts` + 三处接线 +
> `npm run test:r213-observation-timeout-live`（**11/11**，见 §7）。

## 1. 要解决的缺陷（R212 真机实测发现）

R212 在验证 `degraded` 时用 `docker pause` 卡住 Redis，**预期**是「观测调用抛错 ⇒ `degraded: true`」。
实测结果**不是**：

```bash
$ curl -s -m 25 http://127.0.0.1:3106/api/agent/sessions/queue-stall -H "Authorization: Bearer ..."
（25 秒后空返回 —— 超时，不是 200，也不是 500）
```

⇒ **Redis 不应答（但 TCP 仍在）时，观测端点会挂死**，既不报错也不降级。
运营看到的是浏览器转圈，**而不是**一个明确的「队列状态未知」徽标。

### 1.1 根因（**不是**判据设计问题，是连接配置的直接后果）

`apps/admin-api/src/app.module.ts:642-687`：

```text
maxRetriesPerRequest: null   ⇒ 请求永不因重试耗尽而失败，而是**无限挂起**
enableOfflineQueue: true     ⇒ 断线期间命令进离线队列，重连后重放
connectTimeout: 10000        ⇒ 只管**建连**，不管**已有连接上的命令**
```

这三条组合是 **BullMQ 的硬性要求**（它要 `maxRetriesPerRequest: null` 才能在阻塞命令上无限等），
**不能改**。⇒ 缺陷必须在**观测层**补，不能在连接层改。

### 1.2 为什么这比「误报」更难排查

| 形态 | 运营看到 | 可诊断性 |
|---|---|---|
| 误报（`stalled: true` 但其实正常） | 一个红色徽标 | 点开能看到成因 |
| 读失败（`degraded: true`） | 「队列状态未知」徽标 | 文案直接说「没读到」 |
| **挂死（本条）** | **转圈 / 空白 / 前端超时** | **没有任何信号说明「是 Redis 卡了」** |

⇒ 第三种是**唯一**一种「观测系统自己坏了，却让观测面看起来像没数据」的形态。

## 2. 候选信号 × 它会被什么打穿（R393 的强制步骤）

| 候选方案 | 会被什么打穿 | 结论 |
|---|---|---|
| 全局 `commandTimeout` | **BullMQ 的 `BRPOPLPUSH` 阻塞命令会被误杀**（它本来就该等多久都行）⇒ 队列彻底不工作 | ❌ |
| 在连接层加 `retryStrategy` 上限 | BullMQ 明确要求 `null`；改了会在 Redis 抖动时**永久断连**（A4 审计已踩过，见 `app.module.ts:678`） | ❌ |
| 只在前端加超时 | 后端仍占着连接与事件循环；且**其他调用方**（CLI/监控）照样挂死 | ❌ 不解决根因 |
| **观测层每个调用加超时**（`Promise.race`） | 需保证**超时后不留悬挂 promise**（否则连接泄漏） | ✅ **采用** |

## 3. 判据

> **观测调用必须在上界内返回**：任意一个 BullMQ 观测调用若超过 `OBSERVATION_TIMEOUT_MS`，
> **必须**被当作「读失败」处理（⇒ `degraded: true` / `degradedCounts: true` / `workersKnown: false`），
> **而不是**继续等待。

### 3.1 超时上界怎么定（R403：不允许魔法数）

```text
OBSERVATION_TIMEOUT_MS = 一次「健康的 Redis 往返」的合理上界
```

**由什么推导**？本仓**已有**的量：`connectTimeout: 10000`（建连上界，`app.module.ts:669`）。
一次**命令**往返必然**短于**建连（建连含 TCP 握手 + 认证 + 选库；命令只是一次 RTT）。
⇒ 取 **`connectTimeout / 2 = 5000ms`** 作为命令往返上界。理由：

- 比它快 ⇒ 正常 Redis（本地/内网通常 < 5ms）**永远**不会触顶；
- 比它慢 ⇒ 已经**远超**任何健康往返 ⇒ 不值得再等（运营要的是「3 秒后告诉我不知道」，不是「等 30 秒然后挂死」）；
- 它是**推导**出来的（半个建连上界），不是拍的数。

⚠️ 但「观测要等多久」和「Redis 有多慢」是**两件事**：一个 5 秒还没返回的观测，
即使最终会成功，对**运营决策**也已无用（人已经在刷新页面了）。⇒ 这个上界同时是
**用户体验**与**技术合理性**的交点，且**可配**（`AGENT_OBSERVATION_TIMEOUT_MS`）。

### 3.2 超时后必须产生什么（**这是本判据的核心**）

超时 **必须**走与「读失败」**完全相同**的路径：

| 观测 | 超时后 |
|---|---|
| `getWorkersCount()` | `workersUnknown = true` ⇒ `workersKnown: false`，**且不得据此判停摆** |
| `getWaitingCount()` 等计数 | `degradedCounts = true`，回落 0 |
| `getActiveCount()` / `isPaused()` | `degraded = true`，回落值 |

⇒ **复用 R210/R211 已有的分路与两位**，不新增第三条修复路径。
这也是为什么本条是「补观测层」而不是「重做判据」：**判据已经对了，只是喂给它的不是失败而是挂起**。

### 3.3 与另五条判据**不重叠**（R399 的强制步骤）

| 判据 | 覆盖 | 本条**不**覆盖 |
|---|---|---|
| 待接管 / 卡住 / 积压 / 停摆 / 空转 | 队列或会话的**业务状态** | 本条只管「**观测本身**能不能在有限时间内给出答案」 |
| `degraded`（R211） | 「读**失败**了」 | 本条补的是「读**没返回**」——**同一格子在时间维度上的补集** |

⇒ 它们是**正交**的：本条不改变任何业务判据，只保证那些判据**总能拿到输入**（哪怕是「不知道」）。

## 4. 动作：**自动降级**（与其它五条**不同**）

其余五条都是「只告警不处置」。本条**必须**自动处置 —— 因为「不处置」的后果就是挂死。
但处置的**范围必须极小**：只把这一个观测调用**放弃**并标记为未知，
**绝不**改队列、会话、job 的任何状态。

## 5. 已知边界（**如实登记**）

- **`Promise.race` 不取消底层命令** —— **R214 已真机裁定，结论分两半**（详见 §8）：

  | 命令类型 | 超时后 | 对本仓是否要紧 |
  |---|---|---|
  | **阻塞型**（`BLPOP`/`BRPOPLPUSH`） | 连接进入 `flags=b` 阻塞态，**该连接上后续命令全部卡住**（实测 1.5s 内 `PING` 不返回） | ❌ **不适用**：观测**只发非阻塞命令** |
  | **非阻塞型**（`LLEN`/`ZRANGE`/`LRANGE`/`GET`/`CLIENT LIST`） | 超时后命令被丢弃，**连接自动康复**（`commandQueue` 归 0，往返 0ms），**且响应不错位** | ✅ 本仓形态 |

  ⇒ R213 原文写的「高频超时会**累积**悬挂命令」在**非阻塞形态下不成立**；
  但「**绝不能对观测发阻塞命令**」是一条**必须保留的硬约束**（阻塞型确实会毒化连接）。
- **健康 Redis 上不会触发**：本地的观测往返是**亚毫秒级**（R209/R212 实测），
  与 5000ms 相差 4 个数量级 ⇒ 不会把正常波动报成超时。
- **未覆盖**：`agent-backlog.service.ts` 的 `queue.getJob()` 是**逐个**调用（上限 200 个），
  最坏情况 200 × 5000ms —— 但它们是**串行**还是**并行**需先确认再定（见 §6 落地范围）。

## 6. 落地范围（**先确认，再动手**）

| 文件 | 调用 | 现状 |
|---|---|---|
| `agent-queue-stall.service.ts` | 6 个（`waiting`/`delayed`/`prioritized`/`active`/`workers`/`paused`） | **并行**（`Promise.all`）⇒ 一处超时即可判定 |
| `agent-queue-idle.service.ts` | 5 个（同上 + `getWaiting(0,1)`） | **并行** |
| `agent-backlog.service.ts` | `queue.getJob(id)` + `job.getState()` × N（**N ≤ 200**） | **串行 `for` 循环**（`findBacklogged`，R202） |

⚠️ **已读实现确认（R213）**：`agent-backlog.service.ts:93-117` 是
`for (const { id } of probed) { await this.queue.getJob(id); await job.getState(); }`
—— **串行**，且**每个 session 两次往返**（`getJob` + `getState`）⇒ 最坏
**200 × 2 = 400 次串行往返**。若按 5s/次，最坏 **2000 秒** ⇒ 单调用超时**完全不解决问题**。

⇒ 该端点必须用**整个端点一个总上界**（`OBSERVATION_BUDGET_MS`），而不是逐调用 5s。两种处置：

| 方案 | 做法 | 取舍 |
|---|---|---|
| **A. 端点级总预算**（采用） | `findBacklogged()` 内部维护 deadline：每次循环前检查是否已超预算，超了**立即停止探测**并返回**已探到的部分** + `truncated:true` | 语义与既有 `truncated` 天然一致（它本来就是「只查了前 N 条」）；且**已探到的部分仍然有用** |
| B. 每调用超时 | 400 × 5s | ❌ 最坏 2000s，等于没修 |

⚠️ **方案 A 的关键约束**：提前停止时**必须**置 `truncated: true` —— 否则前端会以为
「一共就查到这么几条」（R395 已立过这条纪律：截断必须可见）。

## 7. 落地结果（R213）

| 位置 | 做法 | 上界 |
|---|---|---|
| `agent-queue-stall.service.ts` | 6 个观测调用各套 `withObservationTimeout`（**并行**） | `DEFAULT_OBSERVATION_TIMEOUT_MS` = **5000ms** |
| `agent-queue-idle.service.ts` | 5 个观测调用各套（**并行**） | 同上 |
| `agent-backlog.service.ts` | **整次请求一个 `ObservationBudget`**；循环前查 `expired()`，单次取 `sliceMs()` | 总预算 **8000ms** |

**真机验证（`npm run test:r213-observation-timeout-live`，11/11）**：

| 场景 | 修复前（R212 实测） | 修复后（R213 实测） |
|---|---|---|
| `queue-stall` + Redis 卡住 | **挂死 25s+ 无响应** | **5009ms** 返回 200，`degraded:true` / `workersKnown:false` |
| `backlogged` + 5 条 pending + Redis 卡住 | 最坏 5×2×5s = **50s+**（或挂死） | **8011ms** 返回 200，`truncated:true` |
| 恢复 Redis 后 | — | `degraded:false` / `workersKnown:true`（**位回落**，不是永久降级） |

**反证（最强的一条）**：把 `withObservationTimeout` 的上界改成 1000000ms（等同不设）后重跑，
探针**不是断言失败**，而是**请求本身挂死到 `AbortSignal.timeout` 中止**（`EXIT=2`）——
**精确复现了 R212 记录的那个洞**。这证明探针测的是真行为，不是恒真的文本断言。

**顺带修掉一处测试反模式**：`agent-backlog.service.spec.ts` 的预算用例最初用**生产值 8s**，
让整个 agent 套件每条多等 8 秒 ⇒ 改为**可覆写的实例字段**（压到 200ms）。
理由写在注释里：**「测试慢」最终等于「测试不跑」**。

## 8. R214：超时后的悬挂命令（真机裁定）

`npm run test:r214-observer-leak-live`（**9/9**）。四条关键事实：

| # | 事实 | 证据 |
|---|---|---|
| ① | 观测用的命令集（`LLEN`/`ZCARD`/`CLIENT LIST`/`PING`）**全是非阻塞** | 4 条往返合计 **2ms**；且 `queue-getters.js` 的 `commandByType` 只用 `lrange`/`llen`/`zrange`/`zcard` |
| ② | **阻塞命令会毒化连接**：`BLPOP` 超时后 `CLIENT LIST` 显示 `cmd=blpop` / `flags=b` | 且该连接上后续 `PING` **1.5s 不返回** ⇒ R213 的担忧**对阻塞命令是真的** |
| ③ | **非阻塞命令不会**：`GET` 超时后同一连接**自动康复** | 恢复后 `get(k1)` **0ms** 拿到 `"v1"` |
| ④ | ★ **响应不会错位**（最危险的假设） | 超时后并发 `GET`/`LRANGE` 各自拿到**自己**的结果（`"v2"` / `["a","b","c"]`），`commandQueue` 归 0 |

⇒ **结论**：R213 登记的「悬挂命令」风险，在**本仓实际使用的非阻塞观测命令**上**不成立**；
但它揭示了一条**必须写进契约的硬约束**：

> ⚠️ **观测层永远不得对共享连接发阻塞命令**（`BLPOP` / `BRPOP` / `BRPOPLPUSH` / `XREAD BLOCK`…）。
> 一条这样的命令一旦超时，会把它所在连接**永久**停在阻塞态 —— 而观测与 BullMQ 可能**共用**连接。

这条已写进 `observation-timeout.util.ts` 的头注；将来谁想在观测里加「顺便看一眼队列头部」
之类的调用，必须用 `LRANGE` 而不是 `BLPOP`。
