# 03 · 工具集与边界控制

> 核心问题：Agent 能调什么？调危险动作时谁拦？拦不住会怎样？

## 1. 工具来源：为什么收编 mcp-server 而不是另起一套

`packages/mcp-server/src/tools.ts`（52 KB）已经把 admin-api 的 HTTP 面封装成 **43 个工具**，且分成 7 组注册函数：

```typescript
registerTaskTools(server, apiRequest)          // 任务 CRUD / 版本 / 触发 / 调度
registerApplicationTools(server, apiRequest)   // 应用 CRUD / 健康分析
registerDeploymentTools(server, apiRequest)    // 部署 + DEP-04 审批
registerExecutorTools(server, apiRequest)      // 执行器 / 指标 / 死信
registerObservabilityTools(server, apiRequest) // 调度器健康 / 执行时间线
registerAuditTools(server, apiRequest)         // 审计日志
registerProjectTools(server, apiRequest)       // 项目 / 角色
```

**收编方式**：`McpToolAdapter` 把 `tools.ts` 的工具定义（name + description + zod schema）转成 LLM 的 function-calling schema，`api.ts` 的 `apiRequest` 直接复用为执行体。

好处：
- 零重复实现 —— 43 个工具的定义、参数校验、401 自愈全都有了
- 语义一致 —— Agent 调的接口与 Claude Desktop 调的是同一个，不存在"行为漂移"
- 已有测试可复用 —— `tools.test.ts`（44 KB）覆盖了这些工具

**必要改造**：`tools.ts` 现在是「注册到 McpServer」，需要抽出**工具描述元数据**为独立导出（如 `export const TOOL_SPECS`），使 MCP 注册与 Agent 消费共享同一份定义。这是对 mcp-server 的**非破坏性重构**（见 [06 路线图](06-roadmap.md) 阶段 3）。

## 2. 工具分级（边界控制的基础）

**不分级就无法做边界。** 43 个工具按「产生多大后果」分三级：

### Tier 1 · `read` — 默认全部开放，无需审批

| 工具 | 说明 |
|---|---|
| `list_tasks` / `get_task` / `list_task_versions` / `compare_task_versions` | 任务只读 |
| `list_executions` / `get_execution` / `get_execution_logs` / `get_execution_stats` / `get_execution_timeline` | 执行只读（**排障主力**） |
| `list_applications` / `get_application` / `list_mutex_groups` | 应用只读（mutex 组 = 应用的并发互斥配置，MUTEX-01） |
| `list_deployments` / `list_pending_approvals` | 部署只读（`list_pending_approvals` 回待审批清单，Agent 用它答「现在有什么在等我批」；需 ADMIN） |
| `list_executors` / `get_executor` / `get_executor_metrics` / `list_dead_letters` | 执行器只读 |
| `get_scheduler_health` | 调度器健康 |
| `list_audit_logs` | 审计 |
| `list_projects` / `get_project_members` / `get_my_project_roles` | 项目只读 |
| `analyze_execution` / `analyze_application` | AI 分析（只读，但消耗 AI 配额） |
| `suggest_schedule` | 排程建议（只返回建议，不落库） |

> `analyze_*` / `suggest_schedule` 虽只读，但**会触发真实 AI 调用**（烧钱）。归入 read 但计入令牌预算。

### Tier 2 · `write` — 条件下开放，多数需审批

| 工具 | 默认姿态 | 理由 |
|---|---|---|
| `trigger_task` | **允许**（可配为审批） | 触发是幂等意图、可终止，是排障最常用的动作 |
| `retry_execution` | **允许** | 同上 |
| `pause_task` / `resume_task` | **允许** | 可逆 |
| `update_task` | **需审批** | 改生产任务配置 |
| `rollback_task_version` | **需审批** | 影响运行行为 |
| `create_task_from_template` | **允许**（沙箱校验后） | 新建不破坏既有 |
| `kill_execution` | **允许** | 终止是收敛性动作，方向安全 |
| `create_application` | **允许** | 新建无破坏 |
| `update_application` / `delete_application` | **需审批** | |
| `deploy_application` / `deploy_app` | **需审批（强制走 DEP-04）** | 见 §3 |
| `upgrade_deployment` / `stop_deployment` | **需审批** | |
| `cancel_deployment` | 允许（仅限自己发起的） | |
| `create_mutex_group` | **允许** | MUTEX-01：新建组不改任何既有应用行为（应用只在 `update_application` 里显式挂组才入组）；会话白名单只给 `chat` / `sop_authoring` / `app_scaffold` |
| `update_mutex_group` | **允许**（写类默认不审批；真正的闸是**会话白名单**） | 只有 `chat` 会话可调：收紧 `scope`/`maxConcurrentPerDevice` 会**立即限制**在跑业务的并发，属「人该拍板」（registry 头注如此定性，但**未**设逐工具 `approvalRequired`，兜底靠白名单） |
| `sop_assign` | **允许** | 把已发布 SOP 版本指派给执行器（生成执行器拉取的指派单，`resourceKind=sop`）；会话白名单只给 `sop_authoring` |

### Tier 3 · `dangerous` — **默认禁用，需显式开启 + 强制审批**

| 工具 | 默认 | 说明 |
|---|---|---|
| `approve_deployment` | **禁用** | ⚠️ 让 Agent 能自审批 = 审批机制形同虚设 |
| `reject_deployment` | 禁用 | 同上 |
| `delete_mutex_group` | **默认禁用**（`dangerous` 类默认 `allowDangerous=false` → 直接拒，连审批机会都不给；显式打开后仍需审批） | 仅 `chat` 会话可见。挂载中的应用经 FK **静默**解除互斥（`mutexGroupId` 置空）→ 本该串行的独占型负载（浏览器实例/单点登录顶号）开始相撞；`force=false` 时仍有应用挂载则 `409` |
| `delete_*`（各类删除） | **需审批** | 不可逆 |
| `update_task` 改 `cronExpression` | **需审批 + 额外校验** | 非法 cron 会崩调度（历史上已有 `WIKI-OPT-3` 防过） |

> ⚠️ **最重要的一条**：`approve_deployment` 必须默认禁用。DEP-04 的核心价值是「申请人 ≠ 审批人」的双人原则。若 Agent 既能 `deploy_application` 又能 `approve_deployment`，双人原则被彻底架空。**建议硬编码禁止**，不给配置开关——这是安全红线，不是可调参数。

## 3. 危险动作必须走既有审批（不给 Agent 开后门）

`deploy_application` 已支持 DEP-04：审批开启时返回 `approvalStatus=pending_approval` 且**不派发**，需第二人批准。

**Agent 调用时的行为**：

```
Agent 调 deploy_application
    → boundary.check() 判定 tier=write + 需审批
    → 不直接执行！创建 AgentApproval 记录
    → 会话挂起 waiting_input
    → 通知到配置渠道："Agent 想部署 app-foo 到 executor-03，请审批 [链接]"
    → 人工在 Admin Web 点批准
    → 恢复会话 → 真正调 deploy_application
        → 此时若 DEP-04 也开着，会**再**进一层审批
```

这里有个设计问题需要你定：**两层审批是否太啰嗦？**

| 方案 | 说明 | 倾向 |
|---|---|---|
| A. 两层都走 | Agent 审批 + DEP-04 审批 | 最安全，但一次部署要点两次 |
| B. 合并 | Agent 审批通过后，以「已授权」标记跳过 DEP-04 | 体验好，但需在 DEP-04 里开特例，**削弱了双人原则** |
| C. Agent 审批即 DEP-04 审批 | Agent 不单独审批，直接让 `deploy_application` 返回 `pending_approval`，Agent 转述给人 | **推荐**——零特例，复用既有机制，只需把 `pending_approval` 状态透传给会话 |

**我推荐 C**：不新增审批机制，Agent 只是把「需要人批」这件事转达出去。这样 DEP-04 是唯一审批事实源，审计链干净。

## 4. 内部工具（Agent 专用，非 MCP 面）

这些是 Agent 进程内注册的工具，MCP server **不暴露**（它们是 Agent 的能力，不是外部 Agent 的能力）。单一事实源是 `apps/admin-api/src/modules/agent/tools/tool-registry.ts`（`ALL_AGENT_TOOL_SPECS`：name / description / JSON Schema / `tier` / `resourceKind` / 可选 `approvalRequired`、`hardDisabled`）+ 执行体 `tool-binder.service.ts`；会话白名单在同一个文件的 `SESSION_TOOL_ALLOWLIST`，`scripts/agent-boundary-check.mjs` 断言「每个 MCP 工具要么被闸门纳管、要么在显式排除清单里」：

| 工具 | 用途 | Tier |
|---|---|---|
| `run_doctor` | 跑 `deploy.sh doctor --json`，拿环境体检结构化结果 | read |
| `read_logs` | 读 admin-api/executor 日志（带脱敏 + 行数上限） | read |
| `get_metrics` | 查 Prometheus 指标快照 | read |
| `restart_component` | 重启单个组件（受 `--component` 白名单约束） | **dangerous** |
| `sop_get` / `sop_list` | 读 SOP | read |
| `sop_draft` | 起草 SOP 草稿（落 `draft` 状态，不生效） | write |
| `sop_publish` | 发布 SOP 版本 | **需审批** |
| `sop_reply_clarification` | 回复执行器 Agent 的澄清请求 | write |
| `notify_human` | 主动通知（企微/飞书等） | write |
| `request_approval` | 显式请人审批 | write |
| `get_tool_call_result` | 回读被截断的历史工具结果（[02 §4.3](02-agent-architecture.md) 上下文折叠配套） | read |
| `get_session_steps` | 读**本会话**的步骤时间线（`seq` 倒序翻页、正序返回）——上下文折叠后复核「我第 N 步到底查了什么/当时结论」（[02 §4.3](02-agent-architecture.md) 配套；与 `get_tool_call_result` 的分工见 §4.1） | read |

**`restart_component` 的边界**：只允许重启 `admin-api` / `admin-web` / `executor-*` 这些本栈组件，且必须走 `deploy.sh restart <component>` 而非任意 `systemctl`/`kill`。**绝不接受任意命令字符串**——这与 executor-node 的 `commands.ts` 既有纪律一致（「命令类型是封闭枚举，本地路径由本模块按类型构造，绝不接受中台下发的自由路径」）。直接复用这个已验证的姿势。

### 4.1 会话自省工具（G5）：`get_session_steps` 与 `get_tool_call_result`

两个工具解决同一个痛点：**上下文折叠之后，早期步骤只剩摘要**（[02 §4.3](02-agent-architecture.md) 把早期消息压成「事件名 + 截断预览」）。折叠省 token，但也让模型失去「第 3 步到底查了什么」的事实。二者都只读、都靠执行器注入的 `ctx.sessionId` 做会话隔离（**参数里没有 sessionId**——模型可控参数若含会话 id 就是跨会话读取漏洞），都不在 MCP 面。

**`get_session_steps`（read）** —— 本会话的只读时间线，定位是 langgraph `get_state_history()` 的等价物：**不**提供分叉/回放（那需要检查点，未实现）。

| 维度 | 事实 |
|---|---|
| 参数 | `limit`（整数 1–50，默认 10；越界由执行体钳位）；`beforeSeq`（整数 ≥1，只回 `seq < beforeSeq` 的行 = 往更早翻页，缺省取最新一页）。`additionalProperties: false` |
| 返回 | `{ count, steps: [{ seq, role, content, toolCalls, createdAt }] }`；分页方向是 `seq` **倒序**、返回时**反转为正序**（语义顺序） |
| 投影 | `content` 截断到 **300 字符**（非字符串 → `null`）；`toolCalls` 只回前 **10** 个**工具名**（非数组 → `null`），**不回**参数与结果 |
| 缺上下文 | `{ found: false, error: "missing session context (internal wiring error)" }`——内部接线错误的显式信号，不是空结果 |
| 实现 | `tool-registry.ts:294`（spec）+ `tool-binder.service.ts` `bindAgentTools()`（执行体）；参数被钳位而非报错（LLM 传 999 也能拿到一页） |

与 `get_tool_call_result` 的分工（**别用错**）：

| | `get_session_steps` | `get_tool_call_result` |
|---|---|---|
| 回答的问题 | 「我前面做过什么」——**时间线** | 「那次调用的完整结果是什么」——**结果正文** |
| 输入 | `limit` / `beforeSeq`（按 `seq` 翻页） | `toolCallId`（取自更早的 assistant 消息里的 `tool_call` id） |
| 返回 | 步骤行投影（seq / role / content≤300 / 工具名 / createdAt） | `full`（已脱敏原文，≤32KB；逐字段 ≤4000 字符）**或** `preview` + `sha256` + 「只存了预览」说明；均附 `toolName` / `status` / `resultTruncated` |
| 典型用法 | 折叠后重建上下文、避免重复尝试同一个动作 | 有副作用的工具（`trigger_task` / `approve_deployment` / `update_task`）**回读**结果，而**不重跑**它们 |

> 边界：两者都只读本会话，跨会话/跨线程拿不到（`toolCallId` 与 `sessionId` 双条件查询，`seq` 与 `sessionId` 双条件查询）。要「重放」某一步（分叉执行）目前**没有**工具——这是刻意留白，不是漏注册。

## 5. 边界闸门 `AgentBoundaryService`

### 5.1 五道检查

```typescript
type Verdict =
  | { kind: 'ALLOW' }
  | { kind: 'DENY'; reason: string }
  | { kind: 'NEED_APPROVAL'; approvalSpec: ApprovalSpec };

check(session, toolCall): Verdict
```

| # | 检查 | 判定 | 失败后果 |
|---|---|---|---|
| ① | **工具白名单**：该 `session.kind` 是否允许此工具 | kind → toolset 映射表 | `DENY` |
| ② | **分级审批**：tier 与 `agent.approvalPolicy` 对照 | 配置驱动 | `NEED_APPROVAL` |
| ③ | **参数校验**：schema 验证 + 危险模式扫描 | 见 §5.2 | `DENY` |
| ④ | **资源范围**：能否操作目标 resource | 见 §5.3 | `DENY` |
| ⑤ | **速率熔断**：同工具频次/连续失败 | 计数器 | `DENY` 或工具级熔断 |

### 5.2 参数校验的危险模式

工具参数来自 LLM，**必须视为不可信输入**：

| 模式 | 检测 | 处置 |
|---|---|---|
| Shell 元字符注入 | `; \| & $ \` ( ) < > \n`（在会被拼进 shell 的字段里） | `DENY` |
| 路径穿越 | `../`、绝对路径、`~` | `DENY` |
| SSRF | URL 指向 private/loopback/link-local | `DENY`（复用 `assertAndPinHttpUrl`） |
| 超长载荷 | 字段 > 100 KB | `DENY` |
| Cron 表达式 | `node-cron.validate()` | `DENY`（历史教训 `WIKI-OPT-3`） |
| 脚本源码提交 | 走 `executor-package` 上传时的既有校验 | 复用，不重写 |

### 5.3 资源范围约束

会话创建时在 `contextJson` 里绑定作用域：

```json
{
  "scope": {
    "applications": ["app-foo"],        // 只允许操作这个应用
    "executors": ["executor-03"],       // 或限定执行器
    "projects": ["proj-001"]
  }
}
```

`boundary.check()` 用 scope 交叉验证工具参数中的 resource ID。**越界的工具调用即使 tier 允许也被拒**。

这解决了「Agent 在排查 app-foo 时顺手把 app-bar 删了」的问题。scope 默认由触发源推导（事件触发的会话自动绑定到该事件的资源）。

## 6. 审计与不可否认

每个工具调用落 `agent_tool_calls`（见 [02 §3.3](02-agent-architecture.md)），关键字段：

- `argsJson` —— **已脱敏**（复用 `sanitizeLogs()`，且额外剥离凭据类字段）
- `status` —— `denied` / `awaiting_approval` 也记录（**被拒的尝试同样有价值**，是攻击信号）
- `approvalId` —— 关联审批记录，形成「谁批的 → Agent 做了什么」完整链

同时写入现有 `audit` 模块（`modules/audit`），使 Agent 动作与人工动作在**同一个审计视图**里可查——这对排查「这个配置是谁改的」至关重要。

## 7. Agent 身份与 RBAC（需要你决策）

Agent 调工具时携带什么身份？

| 方案 | 优点 | 缺点 |
|---|---|---|
| A. 专用系统账号 `agent@system` + 新角色 `AGENT` | 审计清晰；权限可精确控制 | 需给 `UserRole` 加枚举（影响迁移、前端枚举校验——项目有 `check-enum-drift.mjs` 守卫，需同步） |
| B. 借用触发它的用户身份 | 无需改 RBAC | 事件触发的会话无用户；审计混淆「人做的」vs「Agent 做的」 |
| C. 借用 admin 身份 | 最简单 | 权限过大；审计完全无法区分 |

**推荐 A**。理由：一个能自主改生产系统的实体，如果无法在审计里与人类操作区分，出事后无法定责。`AGENT` 角色建议权限集 = 人类 `USER` 的读权限 + 明确列举的写权限，**不给 ADMIN 的审批权**（呼应 §2 的 `approve_deployment` 禁用）。

需要同步的地方：`UserRole` 枚举、迁移、前端角色显示、`check-enum-drift.mjs` 白名单、Swagger 文档。

## 8. 兜底：Agent 被攻破/失控时会怎样

假设最坏情况——模型被提示注入攻破，试图执行恶意操作。防御纵深：

| 层 | 拦截点 |
|---|---|
| L1 | 工具白名单（会话 kind 限定）——越权工具根本不在可用列表 |
| L2 | 分级审批——写操作需人工点头 |
| L3 | 参数校验——shell/路径/SSRF 注入被拒 |
| L4 | 资源范围——越出 scope 即拒 |
| L5 | 速率熔断——批量破坏被频次限制拦住 |
| L6 | **Agent 身份非 ADMIN**——审批类工具 API 层直接 403 |
| L7 | 审计留痕——事后可追溯 |
| L8 | 预算闸门——即使没被拦，轮次/令牌上限限制了破坏规模 |

**没有任何一层是「靠模型乖」**。这是设计原则：模型行为不可信，全靠代码层闸门。

## 9. 待你确认的开放项

1. **审批方案 A/B/C**（§3）——我推荐 C（复用 DEP-04，不新增机制）。
2. **`approve_deployment` 硬编码禁用**是否接受？（§2 的安全红线）
3. **Agent 身份方案 A**（新增 `AGENT` 角色）是否接受？涉及枚举漂移守卫同步。
4. **`trigger_task` / `kill_execution` 默认允许**是否接受？这两个是排障主力，若默认审批会让 Agent 几乎无法自动处置故障。
5. **`restart_component` 是否要做**？它让 Agent 能自愈「进程假死」类问题，但重启 admin-api 会中断 Agent 自己——需要特别处理自重启场景（建议：重启 admin-api 时延迟执行 + 重启后自动恢复会话）。
