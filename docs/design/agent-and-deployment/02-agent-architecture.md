# 02 · 中台 Agent 运行时架构

> 目标：admin-api 内置一个**常驻、自主、可调工具、有边界**的 Agent，负责长期运维 + SOP 协作 + AI 写代码编排。

## 1. 为什么不是"AI 分析对话"

你明确说了「不是简单的 ai 分析对话」。这个区分是本设计的立论基础，先把差异钉死：

| 维度 | 现有 AI（`modules/ai`） | 中台 Agent（`modules/agent`） |
|---|---|---|
| 触发 | 被动：任务失败后调一次 | **主动**：定时醒、订阅事件醒、被指派醒 |
| 轮次 | 单轮 prompt → 单轮 response | **多轮** tool-calling 循环，直到任务完成或触界 |
| 能力 | 只读（读日志 → 输出文本） | **读写**：调工具改配置、重启、部署、建任务 |
| 记忆 | 无 | 会话 + 步骤 + 工具调用全持久化 |
| 生命周期 | 毫秒级函数调用 | **长期常驻**，跨小时/跨天的任务上下文 |
| 失败影响 | fail-open 返回 `""` | 有自己的失败语义 + 升级通知人工 |
| 产出 | 一段文本 | **改变系统状态** + 汇报 |

一句话：现有 AI 是**函数**，Agent 是**进程**。

## 2. 模块位置与装配

```
apps/admin-api/src/modules/agent/
├── agent.module.ts                   装配（imports: Ai, Task, Executor, Application,
│                                              Notification, Config, Scheduler...）
├── agent.controller.ts               HTTP 面：会话 CRUD / 对话 / 指派 / 审批
├── runtime/
│   ├── agent-runtime.service.ts      ★ 推理循环（tool-calling）核心
│   ├── agent-session.service.ts      会话生命周期 + 步骤持久化
│   ├── agent-trigger.service.ts      触发器编排（定时/事件/人工/指派）
│   └── agent-budget.service.ts       预算闸门（轮次/令牌/时长/成本）
├── tools/
│   ├── tool-registry.service.ts      工具注册表 + 分级 + 审批判定
│   ├── tool-executor.service.ts      统一执行入口（审计 + 超时 + 熔断）
│   ├── mcp-tool.adapter.ts           ★ 收编 mcp-server 的 43 个工具
│   └── builtin/                      内部工具（doctor / sop / notify...）
├── boundary/
│   ├── agent-boundary.service.ts     ★ 边界闸门（§6）
│   └── agent-approval.service.ts     危险动作审批（对接 DEP-04）
├── providers/
│   └── agent-llm.service.ts          LLM 路由（qwen/openai/ollama）
├── entities/
│   ├── agent-session.entity.ts
│   ├── agent-step.entity.ts
│   └── agent-tool-call.entity.ts
└── __tests__/
```

### 2.1 模块装配原则

- `AgentModule` 依赖多个业务模块 → 用 `forwardRef`（沿用 `task.module` 装配 `ai.module` 的既有模式）
- **`AgentModule` 不被任何业务模块依赖**——单向依赖。这是「Agent 失败绝不影响主链」的结构性保证
- 新表迁移：`apps/admin-api/src/migrations/`（现有 70 个迁移，编号接续 `1790000000040+`）

## 3. 数据模型

### 3.1 `agent_sessions`

| 列 | 类型 | 说明 |
|---|---|---|
| `id` | uuid PK | |
| `kind` | enum | `ops_watch`（运维值守）/ `incident`（事件处置）/ `sop_authoring`（写 SOP）/ `sop_review`（复核回问）/ `app_scaffold`（AI 写应用）/ `chat`（人工对话） |
| `status` | enum | `pending` / `running` / `waiting_input`（等人工/等执行器）/ `succeeded` / `failed` / `aborted` / `budget_exceeded` |
| `title` | varchar | 人可读标题，用于列表 |
| `triggerSource` | varchar | `cron` / `event:<name>` / `user:<id>` / `agent:<sessionId>`（子 Agent 回问） |
| `parentSessionId` | uuid NULL | **多 Agent 协作的关键**：执行器 Agent 回问时挂到中台会话下 |
| `contextJson` | jsonb | 任务目标、涉及的应用/任务/执行器 ID、SOP 引用 |
| `budgetJson` | jsonb | 本会话预算（§5） |
| `resultJson` | jsonb | 终态结论（结构化） |
| `summary` | text | 给通知渠道的一句话摘要 |
| `startedAt` / `finishedAt` | timestamptz | |
| `createdAt` / `updatedAt` | timestamptz | |

索引：`(status, createdAt)`、`(kind, createdAt)`、`(parentSessionId)`

### 3.2 `agent_steps`

一次「思考 → 调工具 → 观察」为一个 step，**全量落库**（审计与复盘的基础）。

| 列 | 类型 | 说明 |
|---|---|---|
| `id` | uuid PK | |
| `sessionId` | uuid FK → agent_sessions | ON DELETE CASCADE |
| `seq` | int | 会话内序号，唯一约束 `(sessionId, seq)` |
| `role` | enum | `system` / `user` / `assistant` / `tool` |
| `content` | text | 消息正文（已脱敏） |
| `reasoning` | text NULL | 模型的思考过程（若 provider 返回） |
| `toolCallsJson` | jsonb NULL | 本步请求的工具调用（可能多个） |
| `tokensIn` / `tokensOut` | int | 计费与预算 |
| `latencyMs` | int | |
| `provider` / `model` | varchar | 记录实际路由到的模型（多模型混合时必需） |
| `createdAt` | timestamptz | |

### 3.3 `agent_tool_calls`

与 step 一对多，独立成表便于**按工具维度做统计与风控**。

| 列 | 类型 | 说明 |
|---|---|---|
| `id` | uuid PK | |
| `sessionId` / `stepId` | uuid FK | |
| `toolName` | varchar | |
| `tier` | enum | `read` / `write` / `dangerous`（§4 分级） |
| `argsJson` | jsonb | **已脱敏**（见 §6.3） |
| `resultJson` | jsonb NULL | 截断存储（大结果只存摘要 + 哈希） |
| `status` | enum | `ok` / `denied`（被边界闸门拦）/ `awaiting_approval` / `timeout` / `error` |
| `errorMessage` | text NULL | |
| `approvalId` | uuid NULL | 关联 DEP-04 审批记录 |
| `durationMs` | int | |
| `createdAt` | timestamptz | |

索引：`(toolName, createdAt)`、`(status)` where `status != 'ok'`

> 这三张表的保留策略需要定（见 §9 开放项）：建议 `agent_steps` 保留 30 天，`agent_tool_calls` 保留 90 天（审计价值更高），由定时任务清理。

## 4. 推理循环（核心）

### 4.1 伪代码

```
run(session):
    ctx = loadContext(session)                    # 目标 + 可用工具 + 预算
    messages = buildPrompt(ctx)                   # system + 历史 steps（滑动窗口）

    loop:
        # ── 闸门 1：预算 ──
        if budget.exhausted(session):  return markBudgetExceeded(session)

        # ── 闸门 2：墙钟超时 ──
        if now() - session.startedAt > budget.wallClockMs:
            return fail(session, "wall-clock timeout")

        # ── 推理 ──
        resp = llm.chat(messages, tools=toolRegistry.available(session))
        persistStep(session, role=assistant, content=resp.content,
                    toolCalls=resp.toolCalls, tokens=..., provider=...)

        # ── 终态判定：模型不再要求调工具 = 给出结论 ──
        if resp.toolCalls.isEmpty():
            return finalize(session, parseResult(resp.content))

        # ── 工具执行 ──
        for call in resp.toolCalls:
            # 闸门 3：边界（§6）—— 这是最关键的一道
            verdict = boundary.check(session, call)
            if verdict == DENY:
                persistToolCall(call, status=denied, reason=verdict.reason)
                messages.append(toolResult(call, "DENIED: " + verdict.reason))
                continue                              # 让模型知道被拒，自行换路
            if verdict == NEED_APPROVAL:
                approval = approvalService.request(session, call)
                persistToolCall(call, status=awaiting_approval, approvalId=...)
                # 会话挂起，不阻塞 worker（§4.2）
                return suspend(session, waitingFor=approval.id)

            # 闸门 4：并发与熔断
            if circuitBreaker.tripped(call.toolName): 
                messages.append(toolResult(call, "CIRCUIT OPEN")); continue

            result = toolExecutor.execute(call)       # 带超时 + 审计
            persistToolCall(call, result)
            messages.append(toolResult(call, truncate(result)))

        messages = trimToWindow(messages, maxTokens=budget.contextTokens)
```

### 4.2 挂起与恢复（不阻塞 worker）

审批等待、等执行器 Agent 回问，都可能耗时很久。**绝不能让 BullMQ worker 阻塞等待**：

```
suspend(session, waitingFor)
    → 释放 worker（job 返回）
    → 写 session.status = waiting_input

恢复路径：
    · 审批通过 → AgentApprovalService 收到回调 → 重新入队 resume job
    · 执行器 Agent 回问 → POST /api/agent/sessions/:id/reply → 重新入队
    · 超时（可配，默认 24h）→ 定时扫描 → 标记 aborted + 通知
```

这要求 `run()` 是**可重入**的：从数据库重建 `messages`（而不是靠内存），这也是为什么 steps 要全量落库。

### 4.3 上下文窗口管理

多轮 tool-calling 会让 messages 快速膨胀。策略：

| 手段 | 做法 |
|---|---|
| 工具结果截断 | 大结果只保留前 N 字符 + 摘要；完整结果留在 `agent_tool_calls.resultJson`，模型需要时用 `get_tool_call_result` 工具回读 |
| 滑动窗口 | 保留 system + 最近 K 步；更早的步压缩为「阶段性小结」（由模型自己生成，存 step 的 `summary`） |
| 会话隔离 | 长任务拆多个会话，用 `parentSessionId` 串联，而非单会话无限增长 |

## 5. 触发器与调度

### 5.1 四种触发源

| 触发源 | 实现 | 典型场景 |
|---|---|---|
| **定时** | 复用现有 `scheduler` 模块（已有 node-cron + leader election，多副本安全） | 每小时巡检、每日体检报告 |
| **事件** | 订阅 `common/events/domain-events.ts` | 执行失败、执行器离线、部署失败 |
| **人工** | Admin Web 对话 / `POST /api/agent/sessions` | 管理员问「昨天为什么挂了」 |
| **指派** | 来自另一个 Agent 会话（`parentSessionId`） | 执行器 Agent 回问细节 |

### 5.2 事件订阅：慎重设计（防风暴）

**这是最容易出事的地方**。执行失败可能每分钟上百条，若每条都起一个 Agent 会话 → 令牌成本爆炸 + 队列拥塞。

设计：**事件不进 Agent，先进聚合窗口**。

```
domain event ──► AgentTriggerService.onEvent()
                     │
                     ├─ 过滤：白名单事件类型（不是所有事件都值得 Agent 介入）
                     ├─ 去重：相同 (eventType, resourceId) 在 T 窗口内只累积不新建
                     └─ 聚合：窗口内 N 条 → 合并成一个 incident 会话
                                （"过去 10 分钟 executions 失败 47 次，集中在 executor-node-03"）
```

| 参数 | 建议默认 | 说明 |
|---|---|---|
| 事件白名单 | 执行失败、执行器离线、部署失败、调度器健康异常 | 明确列出，不开放式订阅 |
| 聚合窗口 | 5 分钟 | 可配 |
| 触发阈值 | 窗口内 ≥ 3 条同类才起会话，否则只记指标 | 防止单次抖动就惊动 Agent |
| 并发上限 | 全局同时运行 ≤ 2 个会话 | 见 §5.3 |

### 5.3 预算与资源隔离

**这是「Agent 常驻会不会拖垮 admin-api」的答案。**

| 闸门 | 默认 | 说明 |
|---|---|---|
| 单会话最大轮次 | 20 | 超过 → `budget_exceeded` |
| 单会话最大令牌 | 200k | in+out 合计 |
| 单会话墙钟上限 | 30 分钟 | |
| 全局并发会话 | 2 | **硬上限**，队列排队 |
| 单会话工具调用次数 | 50 | |
| 相同工具连续失败 | 3 次 → 熔断该工具，本会话禁用 | |
| 每日会话数上限 | 200 | 防失控循环 |
| 每日令牌上限 | 5M | 防成本事故 |

**隔离手段（三重）**：

1. **独立 BullMQ 队列**：`agent-jobs`，与任务调度/执行回调队列分开。Agent 拥塞不影响主链。
2. **独立并发槽**：`agent-jobs` worker 并发固定为 2，不随 CPU 弹性扩。宁可 Agent 慢，不可 Agent 抢占。
3. **可选独立进程**：若压测发现内置仍影响 admin-api，`AgentRuntimeService` 已通过接口抽象，可平移到独立进程（见 §8）。

> 需要你确认：**全局并发 2 + 每日令牌 5M** 是否符合你的成本预期？这是硬闸门，越过就拒绝服务。

## 6. 边界控制（详见 03，此处列结构）

`AgentBoundaryService.check(session, toolCall)` 是**唯一**的工具执行前闸门，串联五道检查：

```
① 工具是否在会话的可用子集内（kind 决定工具白名单）
② 工具分级（read/write/dangerous）是否需要审批
③ 参数校验（schema + 危险模式扫描，如 shell 注入、路径穿越）
④ 资源范围（能否操作该 application/executor？受会话 context 约束）
⑤ 速率与熔断（同一工具频次上限）
```

返回 `ALLOW` / `DENY(reason)` / `NEED_APPROVAL(approvalSpec)`。**没有任何工具能绕过这个入口**——`ToolExecutorService` 是唯一执行点，它强制先调 boundary。

## 7. 生命周期与观测

### 7.1 指标（接入现有 `modules/metrics`）

```
autoflow_agent_sessions_total{kind,status}
autoflow_agent_steps_total{provider,model}
autoflow_agent_tokens_total{provider,model,direction}     # 成本核心指标
autoflow_agent_tool_calls_total{tool,tier,status}
autoflow_agent_tool_duration_seconds{tool}                # histogram
autoflow_agent_denied_total{tool,reason}                  # 边界拦截次数
autoflow_agent_budget_exceeded_total{reason}
autoflow_agent_active_sessions                            # gauge
```

`autoflow_agent_tokens_total` 与 `autoflow_agent_denied_total` 是最该配告警的两个：前者防成本事故，后者是安全信号。

### 7.2 通知（复用 `modules/notification`）

| 时机 | 渠道 | 内容 |
|---|---|---|
| 会话成功且有实质结论 | 配置的渠道 | 一句话摘要 + 详情链接 |
| 会话失败 / 预算超限 | 配置的渠道（升级级别） | 失败原因 + 已尝试步骤 |
| 需人工审批 | 配置的渠道 | 待审批动作 + 一键链接 |
| 静默会话（无结论） | **不通知** | 避免噪音——大部分巡检应该是静默的 |

"静默成功"是刻意设计：**运维 Agent 的价值是「有事才说话」**，日报/噪音会让人屏蔽通知。

## 8. 升级路径（若内置不可行）

`AgentRuntimeService` 的接口设计要保证它能被搬走：

```typescript
interface AgentRuntime {
  start(sessionId: string): Promise<void>;
  resume(sessionId: string): Promise<void>;
  abort(sessionId: string): Promise<void>;
}
```

- **内置实现**：`InProcessAgentRuntime`（直接调 service）
- **远程实现**：`HttpAgentRuntime`（POST 到独立 `agent-service`）

配置键 `agent.runtimeMode = inprocess | remote` + `agent.remoteUrl`。**先做内置，压测后再决定是否需要拆**。预留接口的成本很低，事后重构的成本很高。

## 9. 待你确认的开放项

1. **预算默认值**（§5.3）：并发 2 / 每日 5M 令牌，是否合适？
2. **会话保留策略**：steps 30 天 / tool_calls 90 天，是否需要更久（合规要求）？
3. **人工对话入口**：Admin Web 里是一个独立页面，还是嵌在现有系统设置下？建议独立一级菜单「智能运维」。
4. **Agent 的身份**：以哪个用户身份调工具（影响 RBAC 判定）？建议**引入专用系统账号** `agent@system`，绑定固定角色 `AGENT`，使审计日志能明确区分「Agent 干的」和「人干的」。这需要给 `UserRole` 加枚举值——**是否接受？**（不接受的话只能借用 admin 身份，审计会混淆）
5. **多租户/项目隔离**：现有 `project` 模块有角色隔离。Agent 是否需要项目维度隔离，还是全局运维？
