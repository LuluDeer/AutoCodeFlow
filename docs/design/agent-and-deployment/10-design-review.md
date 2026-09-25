# 10 · 设计复审：发现的缺口与补充

> 本文是对 01-09 的**系统性复审**——把设计与代码事实逐项对照后发现的缺口、矛盾与遗漏。不是重述，是补漏。

## 复审方法

对照了这些**既有的事实源**（不是凭印象）：

- `docs/atlas/04-flows/security-model.md`（凭据矩阵 / 信任链）
- `docs/atlas/04-flows/approval-flow.md`（DEP-04 状态机细节）
- `docs/atlas/02-packages/mcp-server.md`（43 工具 + 传输与鉴权细节）
- `docs/atlas/01-apps/admin-api/modules/api-keys.md`（scope 模型）
- `apps/executor-desktop/src/main/{config-store,config-sanitize}.ts`
- `apps/executor-node/src/routes/{execute,deploy}.ts`
- `apps/executor-node/src/env-whitelist.ts`

## 一、发现的重要缺口（必须补）

### ★ 缺口 1：「智能运维」的 AI 配额会与任务失败分析打架

**问题**：`modules/ai` 的 `analyzeFailure` 是**任务失败后自动触发**的（`TaskProcessor` 调用），会用 `ai.*` 配置的 provider。而中台 Agent 也会大量调用 LLM。

两者若共享同一个 provider/API Key：
- Agent 的高频调用可能**打满配额**，导致任务失败分析静默失效（fail-open 返回 `""`，**没人会发现**）
- 反之，任务失败风暴时 Agent 被饿死

**这是真实的耦合风险**——fail-open 设计让"配额被打满"这个故障**不可观测**。

**补充设计**：

| 措施 | 说明 |
|---|---|
| **独立 provider 配置** | Agent 用 `agent.llm.*`（独立 Key/配额），不复用 `ai.*` |
| **配额分区** | 至少支持不同 API Key；理想是不同账号 |
| **配额耗尽可观测** | 新增指标 `autoflow_ai_provider_quota_exhausted_total{consumer="task_analysis|agent"}` |
| **降级优先级** | 配额紧张时，**保任务失败分析，让 Agent 排队**（任务链路优先级更高） |

> 这一条应写进 [02](./02-agent-architecture.md) 的「资源与隔离」章节——原先我只考虑了 CPU/队列隔离，**漏了配额隔离**。

### ★ 缺口 2：Agent 的动作走哪条凭据链？（[03 §7] 说对了但没落实）

**问题**：`security-model.md` 明确了 5 类凭据：

```
用户 JWT  |  API Key "acf_..."（三档 scope）  |  执行器共享/per-executor token
任务子进程一次性 token  |  外部订阅方 HMAC
```

我在 [03 §7](./03-agent-tools-and-boundary.md) 说「新增 `agent@system` + `AGENT` 角色」，但**没说它用哪种凭据**。这是缺口。

**关键发现**：`JWT_ONLY_API_KEY_PATHS = ["api-keys","auth","users","config"]` ——**API Key 永远碰不到系统配置面**。

这对 Agent 有直接影响：Agent 若要用 API Key 身份，**它就无法读写 `system_configs`**（而 `agent.*` 配置、`ai.*` 配置都在那里）。这意味着：

| 方案 | 可行性 |
|---|---|
| Agent 用 API Key（`manage` scope） | ❌ 无法访问 config 面；且 Agent 需要审批权限，而审批是 ADMIN JWT-only |
| **Agent 用内部服务身份（不走 HTTP）** | ✅ **推荐**——Agent 在 admin-api 进程内，直接调 Service 层，不需要 HTTP 凭据 |
| Agent 用专用 JWT | ⚠️ 需要签发与轮换机制，增加复杂度 |

**补充结论**：中台 Agent 是 **in-process** 的（[02](./02-agent-architecture.md) 的设计），它应**直接调用 Service 层**，只在审计与 RBAC 判定时**代入 `agent@system` 身份**。这样：
- 不需要给它签发凭据（无泄露面）
- 但 `RolesGuard` 的判定逻辑要能被显式代入身份（需要一个小改造）

**而执行器 Agent 是跨网络的**，必须走网络凭据——**建议复用执行器 token 链**（`validateTokenByAddress`，它已经是验证过的机器身份）。

### ★ 缺口 2 补：能力标记已有现成扩展点

我在写缺口 2 时以为要「新增能力位」，核对代码后发现 **`executors.capabilities` 已经存在**：

```typescript
// executor.entity.ts:102
@Column({ type: "simple-array", nullable: true }) capabilities: string[];

// executor.service.ts:2208 —— 已有按能力过滤的语义
!e.capabilities || e.capabilities.length === 0
  ? true                                    // 空 = runtime 通用
  : e.capabilities.includes(opts.runtime!);
```

现有语义是**运行时能力**（`["python","node","shell"]`），用于任务派发过滤。派发给执行器 Agent 的 SOP 完全可以复用这个字段：

```
capabilities: ["python", "node", "agent:sop", "browser", "gui"]
                  ↑ 既有             ↑ 新增域
```

**好处**：
- 零新字段（不新增迁移的列）
- 复用既有的**派发过滤逻辑**（一处改动，两处受益）
- 「哪些机器能接 SOP」变成与「哪些机器能跑 python」同一套判定

**注意**：`:4255` 有个既有语义「空 capabilities = runtime 通用」。**SOP 派发不能沿用这条**——空能力列表的机器不应被当作"能做任何 SOP"。需要一个显式的 `agent:sop` 标记。

> 这条修正很有价值：**原设计会新造一个字段，而正确的做法是扩展一个已有字段的语义**。这是复审对照代码才能发现的。

### ★ 缺口 3：MCP 是 stdio-only —— 执行器 Agent 无法直接用

**问题**：`mcp-server.md` 明确写着：

> **传输：仅 stdio**（`StdioServerTransport`）。代码中无 HTTP/SSE transport——**若需远程 MCP 需自行扩展**。

我在 [03 §1](./03-agent-tools-and-boundary.md) 说「收编 mcp-server 的 43 工具」，但**没注意它只是个 stdio 进程**——它是给 Claude Desktop 本地拉起的，**不是服务**。

中台 Agent 在 admin-api 进程内，可以不走 MCP 直接调 Service；但**执行器 Agent 在外面**，它需要工具就必须有网络通道。

**补充设计**：

| 消费者 | 工具获取方式 |
|---|---|
| 中台 Agent（in-process） | 直接调 Service 层（不走 MCP，也不走 HTTP） |
| 外部 AI（Claude/Cursor） | 既有 stdio MCP（不变） |
| **执行器 Agent** | **需要新的通道**——见下 |

执行器 Agent 需要的能力（[04 §3](./04-sop-protocol.md)）：
- 拉取 SOP
- 发起澄清
- 回报完成
- 上传候选应用包

**这些都不在 43 个工具里**（43 个工具是「管理平台资源」的，不是「执行 Agent 协作」的）。所以要**新增一组 API**，且要走执行器身份鉴权。

> **这是一个原设计遗漏的完整子系统**。建议在 [02](./02-agent-architecture.md) 之外补一节「Agent 协作 API」，或独立成 [11](./11-agent-collaboration-api.md)。

### 缺口 4：DEP-04 的「一个应用只能有一个 in-flight 部署」会影响 Agent

**问题**：`approval-flow.md` 明确：

> 待审批行会一直占坑，须 approve/reject/cancel 三选一释放。
> 提交即 409：该应用已有 in-flight 行（含挂着的待审批行）

**对 Agent 的影响**：Agent 若提交了部署但没人审批，**这个应用就被卡住了**——Agent 想改进方案重新部署会撞 409。

**补充设计**：
- Agent 提交部署后，**必须有超时自动撤回**（复用 `cancel_deployment`，提交人可撤）
- 建议 Agent 用**独立的 `agentTriggerType`**，便于识别与批量清理
- 会话超时时**先 cancel 部署再结束会话**，不能留下占坑的行

这条要写进 [03 §3](./03-agent-tools-and-boundary.md) 的审批流程。

### 缺口 5：审计的 append-only 特性与 Agent 高频写入

**问题**：`security-model.md` 说明审计是 **append-only**（DB 触发器拒绝 UPDATE/DELETE），180 天保留。

Agent 会**高频**产生工具调用记录。若每条都写 `audit_logs`：
- 审计表膨胀速度远超人工操作时代
- 且 **append-only + 不可删除**（只能走特殊 bypass 事务清理）

**补充设计**：
- Agent 的工具调用**主存 `agent_tool_calls`**（可归档/清理），**只在关键动作**（写操作、审批、权限变更）**双写 `audit_logs`**
- 明确哪些动作必须进审计（不可省）：任何 `write`/`dangerous` tier 调用、权限档位变更、SOP 发布
- 只读工具调用**不进 audit_logs**（它们量大且价值低）

原先 [03 §6](./03-agent-tools-and-boundary.md) 说「同时写入现有 audit 模块」，**过于笼统**，会撑爆审计表。

### 缺口 6：Agent 会话与「执行」的关系没定义

**问题**：现有平台的核心实体是 `Task` → `Execution`。而 Agent 有自己的 `agent_sessions`。

**没定义的问题**：
- Agent 触发一次任务（`trigger_task`），产生的 `Execution` 与它的 `agent_session` 如何关联？
- 用户在「执行记录」页面看到某个执行时，能否知道「这是 Agent 触发的」？
- 反过来，在 Agent 会话里能否看到「我这个会话产生了哪些执行」？

**补充设计**：在 `task_executions` 加**可空** `agentSessionId`（保持兼容红线：旧数据 NULL），并在 Admin Web 双向展示。这也符合项目既有的 `triggerType` 惯例（`approval-flow.md` 提到 `triggerType` 覆写为 `approval`）——**Agent 触发应同样标记 `triggerType='agent'`**。

> ⚠️ 这是一个**既有扩展点**，不是新概念——项目已经用 `triggerType` 区分触发来源。Agent 应该接入这个既有机制，而不是新造关联方式。

## 二、需要调整的设计细节（一致性问题）

### 调整 1：[03 §1] 的「收编工具」说法要修正

原文说「`McpToolAdapter` 把 tools.ts 的工具定义转成 LLM schema，`apiRequest` 复用为执行体」。

**问题**：中台 Agent in-process，**没理由绕一圈走 HTTP**（多一次序列化 + 一次网络往返 + 一次鉴权）。直接调 Service 层更快更可靠。

**修正**：
- `TOOL_SPECS` 抽出（✅ 保留——定义仍应共享，避免语义漂移）
- **执行体**：中台 Agent 走 Service 层；外部 MCP 走 HTTP（各自注入）
- 这与 `mcp-server` 的设计一致——它的 handler 只做 `call(...)`，具体传输由注入的 `call` 决定。**同样的模式可以用在 Agent 上**。

### 调整 2：工具数量不是 43

[03 §2](./03-agent-tools-and-boundary.md) 我按 43 个 MCP 工具做分级。但实际 Agent 还需要：

| 来源 | 数量 |
|---|---|
| 既有 MCP 工具 | 43 |
| 内部工具（[03 §4](./03-agent-tools-and-boundary.md)） | 12 |
| **Agent 协作 API 工具**（缺口 3） | ~6 |
| 合计 | **~61** |

分级表需要扩充，且新增工具要明确 tier。

### 调整 3：`agent@system` 与 `JWT_ONLY_API_KEY_PATHS` 的交互

若未来 Agent 需要经 HTTP 访问（如远程运行时模式 [02 §8](./02-agent-architecture.md)），**API Key 到不了 config 面**这个限制会卡住它。

**修正**：远程模式下 Agent 需要**专用 JWT 或内部网络信任**，不能复用 API Key。这一点要在 [02 §8](./02-agent-architecture.md) 的升级路径里写明——否则将来切远程时会踩坑。

### 调整 4：权限档位的配置位置

[09 §4.1](./09-permission-profiles.md) 说配置放 `config-store.ts`。但**企业集中管控**（[09 §4.2](./09-permission-profiles.md)）要求中台下发。

**修正**：需要明确**两条配置路径的合并语义**：
```
客户端本地配置（config-store）  ←→  中台下发的策略
合并规则：最终 = min(本地, 中台上限)
冲突时：中台优先（且通知用户"你的配置被公司策略下调"）
离线时：用本地配置 + 最近一次中台策略缓存
```

「离线时怎么办」原设计没写——而执行器**经常离线**（这是 pull 模式存在的理由）。**离线时应沿用缓存的中台策略**，不能回落成"无限制"。

### 调整 5：会话与 steps 的保留期 vs 审计保留期

[02 §9.2](./02-agent-architecture.md) 我定的是 steps 30 天 / tool_calls 90 天。但审计是 **180 天**。

**问题**：若 90 天后 `agent_tool_calls` 被清理，而审计要求 180 天可查，则**90-180 天区间的 Agent 动作无法追溯细节**。

**修正**：关键动作（写/危险 tier）的 `agent_tool_calls` 应保留 **≥180 天**，与审计对齐。只读的可短（30 天）。

## 三、补充的功能建议

### 建议 1：Agent 的「能力自述」接口

执行器 Agent 上岗时要让中台知道**这台机器能做什么**（[07 §7 ①感知层](./07-executor-agent.md)）。建议标准化为 `capability_report`：

```json
{
  "os": "windows 11 23H2",
  "browsers": ["chrome 131", "edge 131"],
  "runtimes": {"python": ["3.11", "3.12"], "node": ["20.11"]},
  "office": ["excel 365"],
  "network": {"proxied": true, "reachableDomains": ["erp.corp.com"]},
  "permissionProfile": "standard",
  "limits": {"cpu": 8, "memGB": 16, "diskGB": 42}
}
```

价值：中台 Agent 可以**据此判断该把哪个 SOP 派给哪台机器**（而不是盲派）。

### 建议 2：SOP 的「可行性预检」

中台在指派 SOP 前，可对照执行器的 `capability_report` 做一次预检：

```
SOP 需要 browser  → 该机器无浏览器 → 指派前就报错，而不是派过去卡住
SOP 需要域名 X    → 该机器不可达 X → 同上
```

避免"派出去才发现做不了"的往返浪费。

### 建议 3：Agent 操作的「回放」

执行器 Agent 在网页上操作时，**录制操作序列**（不只是录屏）。价值：
- 出问题时能精确知道 Agent 点了什么
- 成功后可把操作序列**沉淀为新 SOP 的参考**
- 审计友好

### 建议 4：成本可视化

Agent 会烧钱（令牌 + 视频理解）。建议在 Admin Web 加**成本看板**：
- 按会话/按天/按模型
- 与配额对比
- 异常告警（单日超阈值）

**没有成本可视化的 Agent 在企业里活不长**——IT 无法回答"这东西一个月花多少"。

### 建议 5：Agent 会话的「人工接管」

Agent 卡住时，人应该能**接管会话**：
- 看到完整步骤历史
- 手动注入一条指令继续（而非只能终止重来）
- 或直接修改 Agent 的下一步计划

这比"失败就重来"实用得多。

## 六、对 01-09 的具体修订清单

复审结论落到「哪份文档的哪一节要怎么改」，避免只提问题不落地：

| 文档 | 章节 | 修订 |
|---|---|---|
| [02](./02-agent-architecture.md) | §5.3 预算与资源隔离 | **补配额隔离**（缺口 1）：Agent 独立 `agent.llm.*`，不与任务失败分析共享配额；新增配额耗尽指标；降级时任务链路优先 |
| [02](./02-agent-architecture.md) | §3 数据模型 | **补 `task_executions.agentSessionId`**（缺口 6）——复用既有 `triggerType` 扩展点，标记 `triggerType='agent'` |
| [02](./02-agent-architecture.md) | §8 升级路径 | **补**：远程模式不能用 API Key（`JWT_ONLY_API_KEY_PATHS` 挡住 config 面），需专用 JWT 或内网信任（调整 3） |
| [02](./02-agent-architecture.md) | §9.2 会话保留 | **修正**：写/危险 tier 的 tool_calls 保留 ≥180 天（对齐审计保留期），只读的 30 天（调整 5） |
| [03](./03-agent-tools-and-boundary.md) | §1 工具来源 | **修正**：中台 Agent in-process **直接调 Service 层**，不走 HTTP；`TOOL_SPECS` 共享仍保留（调整 1） |
| [03](./03-agent-tools-and-boundary.md) | §2 工具分级 | **扩充**：43 MCP + 12 内部 + ~6 协作 API ≈ 61 个，新增工具补 tier（调整 2） |
| [03](./03-agent-tools-and-boundary.md) | §3 审批 | **补**：部署提交需**超时自动撤回**（DEP-04 待审批行占坑会 409 卡死该应用）；用独立 `agentTriggerType` 便于识别清理（缺口 4） |
| [03](./03-agent-tools-and-boundary.md) | §6 审计 | **修正**：不是「同时写 audit」，而是**只读工具不进 audit_logs**（表膨胀 + append-only 不可删），仅写/危险 tier 双写（缺口 5） |
| [03](./03-agent-tools-and-boundary.md) | §7 身份 | **补**：中台 Agent in-process 代入 `agent@system` 身份（不签发凭据）；执行器 Agent 复用 `validateTokenByAddress` + `capabilities` 扩展（缺口 2） |
| [07](./07-executor-agent.md) | §7 迭代循环 | **补** `capability_report` 标准化（建议 1）+ SOP 可行性预检（建议 2） |
| [09](./09-permission-profiles.md) | §4 配置 | **补**离线语义（调整 4）：离线沿用缓存的中台策略，**不回落成无限制** |
| **新增** | — | **[11-agent-collaboration-api.md](./11-agent-collaboration-api.md)**：执行器 Agent ↔ 中台 Agent 的协作 API（缺口 3，原设计整个漏掉的子系统） |

## 七、复审结论

| 类别 | 数量 | 影响 |
|---|---|---|
| **必须补的缺口** | 6 | 缺口 1/2/3 会阻塞实现；4/5/6 会埋雷 |
| **需调整的细节** | 5 | 一致性问题，不改会漂移 |
| **功能建议** | 5 | 增强，非阻塞 |

**最严重的三个**：
1. **缺口 3（执行器 Agent 的协作 API 缺失）**——原设计**整个漏了**这个子系统
2. **缺口 2（Agent 凭据链未定义）**——直接决定实现方式
3. **缺口 1（AI 配额打架）**——会导致任务失败分析静默失效，且不可观测

**建议**：缺口 1/2/3 补进设计后再开工 P7；缺口 4/5/6 可在 P3/P5 阶段落地时处理。

## 八、下一步

我建议：

1. **先补缺口 3**（执行器 Agent 协作 API）——它是唯一「整个子系统缺失」的，且 P7 依赖它
2. 缺口 1/2 是**小改动**（配额隔离、身份落实），已在上面给出具体落点
3. **同时开工 P0 部署脚本**——它不受这些缺口影响，独立可用

要我继续写 [11-agent-collaboration-api.md](./11-agent-collaboration-api.md)，还是先开工 P0？
