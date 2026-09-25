# agent 模块 — 中台 Agent 运行时（P2 底座 + P3 工具边界 + P4 触发通知）

> 所属: docs/atlas/01-apps/admin-api/modules · 最后核对: 2026-09（P4） · 对应代码: apps/admin-api/src/modules/agent
> 设计文档: [docs/design/agent-and-deployment/](../../../../design/agent-and-deployment/README.md)

## 职责

中台**常驻自主运维 Agent** 的运行时底座。与既有 [ai](ai.md) 模块的本质区别：

| 维度 | ai 模块（既有） | agent 模块（本模块） |
|---|---|---|
| 触发 | 被动：任务失败后调一次 | **主动**：定时醒（P4）、订阅事件醒（P4）、被指派醒（P6） |
| 轮次 | 单轮 prompt → 单轮 response | **多轮** tool-calling 循环 |
| 能力 | 只读（读日志 → 输出文本） | **读写**（P3 接入工具后改系统状态） |
| 记忆 | 无 | 会话 + 步骤 + 工具调用全持久化 |
| 失败影响 | fail-open 返回 `""` | 有自己的失败语义 + 升级通知 |

一句话：既有 AI 是**函数**，本模块是**进程**。

## 目录结构

```
modules/agent/
├── agent.module.ts                    装配（单向依赖 + 独立队列 + 工具装配）
├── agent.controller.ts                HTTP 面（全 ADMIN-only）
├── entities/
│   ├── agent-session.entity.ts        会话（一次 Agent 任务）
│   ├── agent-step.entity.ts           一步（一轮「消息→模型响应」）
│   └── agent-tool-call.entity.ts      一次工具调用（按工具维度风控）
├── boundary/
│   └── agent-boundary.service.ts      ★ 边界闸门（五道检查，唯一入口）
├── tools/
│   ├── tool-registry.ts               ★ 43 工具定义 + 分级 + 会话白名单
│   ├── tool-executor.service.ts       ★ 工具执行器（超时/截断/脱敏/熔断）
│   ├── agent-api.client.ts            执行体路由（in-process 调 Service）
│   └── tool-binder.service.ts         只读工具 → 内部 Service 绑定
└── runtime/
    ├── agent-session.service.ts       生命周期与持久化（唯一落库入口）
    ├── agent-budget.service.ts        预算闸门（四道）
    ├── agent-runtime.service.ts       推理循环（可重入）
    ├── agent-notify.service.ts        会话通知（§7.2 分级 + 静默成功 + fail-open）
    └── agent.processor.ts             BullMQ worker（并发固定 2）
```

另有 `trigger/`（P4 自主醒来）：

```
trigger/
├── agent-trigger.service.ts           触发编排（@Cron 定时 + 领域事件订阅）
└── agent-event-aggregator.service.ts  聚合窗口（防事件风暴的核心）
```

## 路由（controller 前缀 `agent`，实际路径 `/api/agent`；全部 `@Roles(ADMIN)`）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/sessions` | 会话列表（分页，可按 kind/status 过滤） |
| GET | `/sessions/:id` | 会话详情（含 steps / toolCalls / 子会话） |
| POST | `/sessions` | 创建会话并入队执行 |
| POST | `/sessions/:id/resume` | 恢复挂起/失败的会话（终态会话拒绝） |
| GET | `/budget` | 当前生效预算（运维核对用） |

权限全部 ADMIN-only，理由与 [ai](ai.md) 的 N11/R11 一致：Agent 能改系统状态
（P3 之后），能自主烧令牌配额——这类入口绝不能对普通用户开放。

## 三张表的职责边界

| 表 | 承载 | 关键设计 |
|---|---|---|
| `agent_sessions` | 一次 Agent 任务 | `budgetJson` 是**创建时快照**（事后调配置不追溯）；`scopeJson` 缺省空对象 = 不可操作任何资源；`parentSessionId` 支撑 P6 澄清链 |
| `agent_steps` | 一轮推理 | **全量落库**——循环必须可重入；唯一约束 `(sessionId, seq)` 保证重放顺序 |
| `agent_tool_calls` | 一次工具调用 | 独立成表以支持**按工具维度 SQL 聚合**；`denied`/`awaiting_approval` 同样落库 |

### 为什么 steps 必须全量落库

推理循环要**可重入**——会话会在两种情况下中断并从 DB 重建上下文：
① `waiting_input` 挂起（等审批/等澄清）后 resume；② admin-api 重启（进程内 state 全丢）。
没有全量 steps，重启后会话只能作废；有了它，`run()` 每次从 DB 重建 messages
再继续，语义与中断前一致。这也是审计与复盘的基础。

### 为什么 tool_calls 独立于 steps

「哪个工具失败率最高」「边界闸门拦了多少次」必须能 SQL 聚合；塞在 step 的
jsonb 里就只能全表扫。且两者**保留策略不同**：写/危险 tier 需 >= 180 天以对齐
审计保留期，只读可 30 天——分表才能独立清理（见 [10 §调整5](../../../../design/agent-and-deployment/10-design-review.md)）。

## 关键机制

### 推理循环（`AgentRuntimeService.run`）

```
run(sessionId)
  ├─ 已是终态 → 直接返回（幂等；resume 与定时扫描撞车时不重复执行）
  ├─ markRunning（startedAt 只在首次置位——resume 不重置，否则墙钟预算可续命）
  ├─ rebuildMessages ← 从 DB 的 steps 重建（可重入的关键）
  └─ loop:
       ├─ 闸门 1：预算（**在循环开头**）
       ├─ chatMultimodal（带 tools）
       ├─ appendStep（provider/model 逐条记录）
       ├─ 模型不再要求调工具 → succeeded（终态判定）
       └─ 逐个执行工具 → pushToolResult → 继续
```

**闸门为什么在循环开头而不是末尾**：末尾判会让最后一轮已经产生了副作用
（可能已改生产配置），闸门就形同虚设。运行时断言专门钉住「恰好跑到
`maxSteps` 就停，不多跑一轮」。

### 预算闸门（`AgentBudgetService`）

四道，判定顺序**固定**（steps → tokens → wallClock → toolCalls），使同一份用量
总是得到同一个 `kind`——便于指标聚合与测试断言稳定：

| 闸门 | 默认 | 说明 |
|---|---|---|
| `maxSteps` | 20 | 单会话最大轮次 |
| `maxTokens` | 200000 | in + out 合计 |
| `wallClockMs` | 1800000（30min） | 从 `startedAt` 起算 |
| `maxToolCalls` | 50 | |

配置键 `agent.budget.*`（env：`AGENT_BUDGET_MAX_STEPS` 等，Joi 已注册）。
**脏配置回落默认**——非数字/负值不得让闸门失效（那样 Agent 就无限制了）。

用量累加与 step 写入**同事务**：分开写会出现「步数涨了用量没涨」的窗口，
而闸门正是读用量——那个窗口里 Agent 是无限制的。

### 可重入性

`run()` 不依赖任何进程内状态，每次从 DB 重建 messages。因此
「挂起后 resume」与「重启后恢复」走的是**同一条路径、同一份数据**，
不存在两条行为可能漂移的代码路径。

这是用函数式风格写 `messages` 的原因：`rebuildMessages` /
`pushAssistant` / `pushToolResult` 都返回**新数组**而非原地 mutate，
避免「同一数组被多方引用后状态互相污染」这类隐蔽 bug。

### 队列隔离

`agent-jobs` 与 `task-queue` 是**两条独立队列**，并发固定为 2（不随 CPU 弹性扩）。
理由：Agent 的工作负载特征与任务派发完全不同（LLM 长调用、分钟级会话、会挂起
等待），混在一条队列里一个卡住的会话就会拖住任务派发。宁可 Agent 排队慢，
不可它抢占主链资源。

`AgentProcessor` 对未预期异常**不重抛**：重抛会让 BullMQ 按默认策略重试，
而重试会**重复执行已发生的副作用**——比不重试更危险。

## 自主醒来（P4：触发器 + 通知）

Agent 除了人工建会话，还能自己醒。两条醒来的路，都有各自的闸：

### 定时巡检（cron）

`@Cron` 每小时第 5 分钟起一个 `ops_watch` 会话（`AGENT_TRIGGER_CRON_ENABLED` 可关）。
两个要点：**扫描型 tick 必须过 leader 门禁**（复用 `SchedulerService.getStats().isLeader`，
不另造选举——多副本不判 leader 会 N 倍触发且互相看不见）；巡检会话 `scope` 为空
（纯只读，自动醒来的东西不自带写权限）。

### 事件触发（先聚合，后起会话）

订阅 `execution.failed/killed`、`executor.offline`、`deployment.completed`（**显式白名单**）。
事件**不直接**起会话，先过 `AgentEventAggregator`：同 (事件， 资源) 在窗口
（`AGENT_TRIGGER_WINDOW_MS`，默认 5 分钟）内累积达阈值（默认 3）才放行**一次**，
drain 后下个窗口重新累积。一次执行器下线会刷出几十条失败事件——逐条触发就是
令牌成本爆炸 + 队列拥塞 + 通知风暴，47 条失败 → **1 个** incident 会话是验收锚点。
不同事件的噪声水平不同：`executor.offline` 单次即重要，阈值覆盖为 1（做成参数
而非多配置键，阈值语义只有一处）。

事件路径**全链 fail-open**：Agent 起不来绝不能影响执行主链。自动触发的会话
`scope` 一律为空。

### 会话通知（`AgentNotifyService`，设计文档 02 §7.2）

| 会话结局 | 级别 | 行为 |
|---|---|---|
| `succeeded` 且 summary 非空 | INFO | 摘要 + 会话标识 |
| `succeeded` 无 summary | — | **不通知**（静默成功） |
| `failed` / `budget_exceeded` | ERROR | 失败原因（升级通知） |
| `aborted` | — | 管理员自己的动作，不回推 |
| 工具待审批 | WARNING | 工具名 + 审批单 id（`requestApproval` 推送） |

**静默成功是刻意设计**：运维 Agent 的价值是「有事才说话」，无事也报会让人
屏蔽渠道，真出事时通知一起被屏蔽。「无结论」的表征统一为 `summary` 为空。
通知挂在 `AgentSessionService.finish()`（终态唯一收敛点）——一处覆盖全部路径，
且 finish 的「已是终态提前返回」守卫同时防住重复通知；传给通知的是**更新后**
的快照（静默语义读的是新 summary）。全链 fail-open + 总开关 `AGENT_NOTIFY_ENABLED`
（默认开；渠道未配置时各渠道自行跳过）。

## 指标

| 指标 | 标签 | 用途 |
|---|---|---|
| `autoflow_agent_sessions_total` | kind, status | 会话终态分布 |
| `autoflow_agent_tokens_total` | provider, model, direction | **成本归因唯一数据源**（回答「这功能一个月花多少」） |
| `autoflow_agent_tool_calls_total` | tool, tier, status | 工具分布（denied 是安全信号） |
| `autoflow_agent_denied_total` | reason | 边界拦截（P3 启用） |
| `autoflow_agent_budget_exceeded_total` | reason | 预算触顶（防成本事故） |

> 指标名在 `runtime-metrics.ts` 注册表登记是**必须**的——`recordRuntime`
> 对未注册名静默忽略，漏注册会让埋点形同虚设。测试有对应断言。

## 与其他模块的关系

- **单向依赖**：本模块依赖 ai（LLM 出口）、后续 P3 依赖 task/executor/application，
  但**不被任何业务模块依赖**。这是「Agent 失败绝不影响调度/执行主链」的
  结构性保证（设计文档 02 §2.1）。
- 消费 [ai](ai.md) 的 `chatMultimodal`（多模态 + tool-calling）与 `getActiveRoute`
  （逐条记录 provider/model）。
- P4 复用 [scheduler](scheduler.md) 的 leader 状态（定时触发门禁，不另造选举）、
  [notification](notification.md) 的渠道扇出（会话通知，§7.2）、事件总线的
  领域事件（`execution.failed` 等白名单）。
- `task_executions.agentSessionId`（迁移 `1790000000040`）：Agent 触发的任务
  其执行行带上会话 id，配套复用既有 `triggerType` 自由串记 `'agent'`。

## 边界闸门（P3，设计文档 03 §5）

**`ToolExecutorService.execute()` 是工具执行的唯一入口**，它**强制先调
`AgentBoundaryService.check()`**。没有任何工具能绕过——这是「模型行为不可信，
全靠代码层闸门」的机制保证（不是靠约定，是靠只有这一条路径）。

### 五道检查（顺序固定）

| # | 检查 | 拒绝原因标签 | 说明 |
|---|---|---|---|
| ① | 工具白名单 | `not_in_toolset` | 按 `session.kind` 查 `SESSION_TOOL_ALLOWLIST`；未登记类型 → 空集（拒绝一切） |
| ② | 硬禁用 | `hard_disabled` | `approve_deployment` / `reject_deployment`，**不可配置** |
| ③ | 参数校验 | `invalid_params` | 必填/未知键/**递归**危险模式扫描（shell/换行/路径/SSRF/超长） |
| ④ | 资源范围 | `out_of_scope` | scope 交叉验证；**空 scope = 不可操作任何资源** |
| ⑤ | 速率与熔断 | `rate_limited` / `circuit_open` | 同工具频次上限 + 连续失败熔断 |
| ⑥ | 分级审批 | `needs_approval` | 最后一道——前面都是「一律拒绝」，这里是「可批准」 |

判定顺序**固定**，使同一份输入总是得到同一个 verdict——否则
`autoflow_agent_denied_total{reason}` 会漂移，「为什么被拒」的统计失去意义。

### 面试关键的两个安全设计

**① `approve_deployment` 硬禁用且不可配置。** DEP-04 的核心价值是「申请人 ≠
审批人」的双人原则；若 Agent 既能发起部署又能自行审批，双人原则被彻底架空。
测试专门断言「即使 `agent.policy.allowDangerous=true` 仍被拒」——**这是安全
红线，不是开关**。硬禁用工具还**不暴露给模型**（纵深防御 L1：看不到就不会试）。

**② `denied` 不消耗速率预算。** 否则越权尝试会把正常调用也拖到限流，
**反而放大攻击效果**（攻击者用无效调用就能让 Agent 瘫痪）。

## 工具分级（P3）

| tier | 数量 | 默认姿态 | 示例 |
|---|---|---|---|
| `read` | 31 | 全开 | `list_tasks` / `get_execution` / `get_scheduler_health` |
| `write` | 10 | 放行（可配为审批） | `trigger_task` / `retry_execution` / `kill_execution` / `deploy_application` |
| `dangerous` | 2 | **禁用** | `delete_application`（+ 硬禁用两个审批工具） |

会话类型 → 工具集映射（`SESSION_TOOL_ALLOWLIST`）：

| kind | 工具集 |
|---|---|
| `ops_watch` | **纯只读**（定时巡检每小时醒，任何写操作都会被重复执行很多次） |
| `incident` | 只读 + 收敛性写（触发/重试/暂停/终止）；**不含** update_task |
| `sop_authoring` / `app_scaffold` | 读 + 建应用/建任务/部署（部署仍需审批） |
| `sop_review` | 纯只读（P6 会加澄清工具） |
| `chat` | 不限（管理员对话，等价于管理员自己操作） |

## 工具执行体（P3）

`AgentApiClient` 是**执行体路由**，`ToolBinderService` 在 `onModuleInit` 把
只读工具绑到内部 Service。P3 绑定了 15 个（任务/应用/执行器三组）。

**为什么 in-process 而非 HTTP**：中台 Agent 就在 admin-api 进程内。绕 HTTP 调
本机 3105 要多一次序列化 + 网络往返 + 鉴权，而且**需要给 Agent 签发凭据**——
而 `JWT_ONLY_API_KEY_PATHS` 明确把 `config` 面排除在 API Key 外，Agent 用
API Key 根本碰不到 `system_configs`。这与 mcp-server 的设计同构（handler 只做
`call(...)`，传输由注入的 `call` 决定），只是这里的 `call` 路由到内部 service。

**未绑定的工具返回错误而非静默成功**——静默成功会让模型在错误前提上继续推理，
比明确失败更危险。

## 常见改动场景

- **加一个会话类型**：`AGENT_SESSION_KINDS` + `runtime-metrics.ts` 的
  `AGENT_KINDS`（两处手工同步，漂移会被断言拦） + P3 的工具白名单映射。
- **调预算默认值**：`DEFAULT_BUDGET`（`agent-budget.service.ts`）+ Joi 默认值 +
  `.env.example`，三处需同步。
- **调触发器窗口/阈值**：`AgentEventAggregator.resolveWindowMs/resolveThreshold`
  的 fallback + `configuration.ts` + Joi + `.env.example`，四处需同步。
- **加触发事件类型**：`TRIGGERABLE_EVENTS`（白名单，显式不开放式）+
  `AgentTriggerService` 订阅/退订配对 + 资源键选择（聚合分组就按它）。
- **接工具集（P3）**：实现 `AgentToolExecutor` 接口并调
  `AgentRuntimeService.setToolExecutor()`——**不需要改动循环逻辑**，这是
  当初用接口切开循环与工具的目的。
- **加新指标**：先在 `runtime-metrics.ts` 的 `RuntimeCounterName` 与
  `RUNTIME_COUNTERS` 注册（labelValueSets 要列全，否则 series 集合不稳定），
  再埋点。

## 相关文档

- [设计文档 02 · Agent 架构](../../../../design/agent-and-deployment/02-agent-architecture.md)
- [设计文档 03 · 工具集与边界](../../../../design/agent-and-deployment/03-agent-tools-and-boundary.md)（P3）
- [ai 模块](ai.md)（LLM 出口） · [metrics 模块](metrics.md)（指标渲染）
