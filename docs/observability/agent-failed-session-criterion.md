# 「Agent 会话失败」判定判据

> R279 立项。**先定判据，再写代码**（本仓纪律：判据没定就动手 = 写出一个「能跑但说不清在判什么」的东西）。
>
> 状态：**已实现**（`AgentInboxService.counts().failedSessions` + 收件箱 `agentFailures` 小节）。
> 立项来源：真机造 3 条失败会话后收件箱七项计数全 0 —— 见
> `artifacts/autonomy/R279/failed-sessions-invisible.md`。

## 1. 要解决的问题

收件箱的七个小节（`deployments` / `agentApprovals` / `agentWaiting` / `stalled` /
`backlogged` / `queueStall` / `recentFailures`）里，前六项只看**非终态**
（`pending` / `running` / `waiting_input`），唯一的「失败」小节 `recentFailures`
查的是 `task_executions`（**任务执行**），不是 `agent_sessions`（**Agent 会话**）。

⇒ **一条 Agent 会话失败了，它不会出现在任何观测面上**（收件箱不可见、顶栏徽标恒 0）。

**为什么这是真问题（而非「少一个徽标」）**：运营的心智是「**待办 = 需要我管的活**」。
一条失败会话需要人判断「配置问题还是任务问题、要不要重跑」——**这比审批更该被看见**，
因为审批单至少还有一个「等」的明确信号，失败会话只是安静地留在列表里。

**它比谎报更隐蔽**：不是「读不到伪装成没有」（那是 R278 修的），而是
「**没建模的东西永远不出现**」。而且这些计数**确实是 0**（没有 pending、没有 waiting），
数字是对的 —— **真实的 0 掩盖了「有 N 条失败等你处理」**。

## 2. 判据

> **failedSessions（失败会话数）= 时间窗内、状态 ∈ {`failed`, `budget_exceeded`} 的 Agent 会话数。**

### 2.1 为什么含 `budget_exceeded`

`AGENT_SESSION_STATUSES` 的七个值里，四个终态是
`failed` / `aborted` / `budget_exceeded` / `succeeded`。

- `succeeded` —— 不需要人管，**不计**；
- `aborted` —— **人主动停的**，是「已决定」，不是「待办」，**不计**（这是本判据与
  既有 `AGENT_TERMINAL_STATUSES` 的**唯一分歧点**，故意的）；
- `failed` —— 需要人判断原因、决定是否重跑，**计**；
- `budget_exceeded` —— 触达预算闸门（轮次/令牌/墙钟/工具调用数任一超限）。
  它**不是**「人决定的」，而是系统拦下来的；且它的处置动作与 `failed` 一致
  （调整 SOP/预算后重跑）⇒ **与 `failed` 同口径计入**。

⚠️ **不要**把 `agentFailures` 小节的**行数据**也放宽到两者：
行数据走 `GET /agent/sessions?status=failed`（只取 `failed`），
因为 `budget_exceeded` 的处置路径（去会话详情调预算后重跑）与会话列表的
「按状态筛选」心智不同。**计数含两者、列出只列 `failed`** 这个不对称是**刻意的**，
下一个人若「顺手对齐」会让小节标题与实际行数对不上。

### 2.2 为什么必须有时间窗

收件箱是「**今天要处理的**」，不是全 history。没有窗口的后果：

- 一个跑了三个月的部署，`failedSessions` 会累积到几千 ⇒ 徽标变成一个永远巨大的数字
  ⇒ 运营**学会忽略它**（告警疲劳的标准成因）；
- 而「历史上失败过多少次」这个问题，会话列表按状态筛选就能答，不需要收件箱承担。

**窗口默认 24 小时**（`AGENT_FAILED_SESSION_WINDOW_HOURS`）。
为什么是 24h 而不是 1h / 7d：① 1h 会把「昨晚失败的」直接吞掉，而早晨正是处理它的时间；
② 7d 会让数字大到失去「今天该做什么」的指向性。24h 与「一个工作日」对齐。

### 2.3 为什么 `failedSessions` 不参与全会话求和

同一个会话可能在窗口内**先 failed、后被重跑成 succeeded**。若把它与
`waitingSessions` / `stalled` 一起相加，会：

- **重复计**（一条会话在两个状态里各出现一次）；
- 让顶栏总数在执行「重跑」这个动作时**不降反升或凭空跳动**（用户会以为出了新问题）。

⇒ `failedSessions` 是**独立显示项**，与 `agentApprovals` 同款处理：
徽标单独显示「会话失败 N」，不进 `summarizeInboxCounts` 的相加项。

### 2.4 `null` vs `0`（沿用 R278 纪律，不得例外）

| 值 | 含义 | UI |
|---|---|---|
| `number > 0` | 事实：有 N 条待处理 | 显示「会话失败 N」，小节可见 |
| `0` | **事实**：窗口内没有失败会话 | 小节**隐藏**（与 InboxBadge 的「0 件隐藏」同款） |
| `null` | **读不到**（DB 抖动 / 服务缺席） | 显示「**—**」+ 降级提示，**绝不显示 0** |

`failedWindowHours` **不适用**这条：它是**配置**而不是事实，
读不到时回落默认 24（显示「近 24 小时」），不回 `null`。

## 3. 与相邻判据的关系（都不重叠）

| 判据 | 看什么 | 与本章的区别 |
|---|---|---|
| 待接管（R198） | `waiting_input` 会话 | 那条是「**等**人工」，本条是「**已经失败**」 |
| 卡住（R199） | `running` 且最近 step 超时 | 那条会话**还在跑**，本条已经**结束** |
| 积压（R201/R203） | `pending` 但队列无 job | 那条**没开始跑**，本条跑完了且失败 |
| 队列停摆（R204/R205） | 队列 worker 注册面 | 结构性故障，与单条会话无关 |
| 空转（R206/R207） | worker 在册却不消费 | 同上 |
| **失败（本章 R279）** | `failed` / `budget_exceeded` **终态** | **唯一看终态的判据** |
| 最近失败（`recentFailures`） | `task_executions.status=FAILED` | **任务执行**，不是 Agent 会话（两张表） |

⇒ 本章补的是「**终态可见性**」这一格，此前**完全空缺**。

## 4. 验收判据（可机械验证）

真机上按下列步骤，**期望**与**本轮修复前实测**对照：

```bash
# 造 N 条失败会话（AI_PROVIDER=disabled ⇒ 创建后必失败）
for n in A B C; do
  curl -s -X POST http://127.0.0.1:PORT/api/agent/sessions \
    -H "Authorization: Bearer $T" -H 'Content-Type: application/json' \
    -d "{\"kind\":\"chat\",\"title\":\"smoke $n\"}"
done

curl -s -H "Authorization: Bearer $T" http://127.0.0.1:PORT/api/agent/inbox/counts
```

| | 修复前（实测） | 修复后（期望） |
|---|---|---|
| `failedSessions` | **字段不存在** | `>= N` |
| `failedWindowHours` | 不存在 | `24` |
| 收件箱页面 | 七小节全 0，无异常指示 | 出现「Agent 会话失败 N（近 24h）」小节，行内显示 `errorMessage` |
| 顶栏徽标 | 不显示 | 显示「会话失败 N」 |

**反证（判据有齿）**：把窗口临时改成 `1`（小时）且失败会话是 2 小时前创建的 ⇒
`failedSessions` 必须变 `0`；改回 24 ⇒ 恢复 `>= N`。

## 5. 未覆盖 / 已知边界

- **`aborted` 的可见性仍为空缺**：本判据刻意不计它，但「人主动停掉的会话」目前在
  任何观测面上也不出现。若将来有「谁停了多少」的运营需求，应**另立判据**
  （它的读者是审计而非值班，窗口与呈现都不同），不要塞进本章。
- **只有计数，没有「已处理」标记**：运营看完成功重跑后，`failedSessions` 会因窗口
  自然衰减而下降，不会因「我处理了」而立即清零。这是**有意的简化**——
  加「已确认」状态需要一张新表，属独立交付面。