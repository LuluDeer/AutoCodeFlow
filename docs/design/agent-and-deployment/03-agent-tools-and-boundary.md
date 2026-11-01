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

### Tier 2 · `write` — 条件下开放，**默认放行**（21 个里只有 5 个带逐工具审批）

> 这一列写的是**代码里真实发生了什么**，不是希望发生什么。默认策略是
> `writeRequiresApproval=false`（`agent-boundary.service.ts:68`），所以「写类工具
> 默认不审批」是**默认值**，不是例外；只有 `approvalRequired: true` 的 5 个工具
> （`update_task` / `rollback_task_version` / `upgrade_deployment` / `stop_deployment` /
> `sop_publish`）会被闸门拦下要人点头。
>
> 谁没有门、为什么没有：单一事实源是 `apps/admin-api/src/modules/agent/tools/gate-inventory.ts`
> 的 `GATE_INVENTORY`（16 条，逐条带理由类别与证据），由
> `apps/admin-api/src/modules/agent/tools/__tests__/gate-inventory.spec.ts` 双向守卫。

| 工具 | 代码里的实际姿态 | 理由 |
|---|---|---|
| `trigger_task` | **允许**（无逐工具审批；可被全局 `writeRequiresApproval` 收紧） | 触发是幂等意图、可终止，是排障最常用的动作 |
| `retry_execution` | **允许** | 同上（回放原 params 走 manual-trigger，不改任务定义） |
| `pause_task` / `resume_task` | **允许** | 可逆 |
| `update_task` | **需审批**（`approvalRequired: true`） | 改生产任务配置 |
| `rollback_task_version` | **需审批**（`approvalRequired: true`） | 影响运行行为 |
| `create_task_from_template` | **允许**——⚠️ **零门**（已知缺口，见下） | 新建不破坏既有；但 `overrides` 可携代码源直达执行器，已登记为 S1-C1 |
| `kill_execution` | **允许** | 终止是收敛性动作，方向安全 |
| `create_application` | **允许** | 新建无破坏 |
| `update_application` | **不可执行**：注册表有声明、`tool-binder` 里**没有** `register`，调用即「尚未实现」 | 绑定执行体那天必须回来重新裁定要不要门 |
| `delete_application` | **需审批**（`dangerous` 类：默认禁用 + 默认强制审批） | 不可逆 |
| `deploy_application` / `deploy_app` | **允许**——⚠️ **Agent 侧没有审批**，门全在下游 DEP-04，而 DEP-04 是**按应用**开关且默认 `false` | 见 §3.1（代码事实）与 §3.2（方案 C 的残余风险） |
| `upgrade_deployment` / `stop_deployment` | **需审批**（`approvalRequired: true`） | |
| `cancel_deployment` | **不可执行**：同 `update_application`，注册表有声明、无执行体 | 只有 `chat`（不限工具）拿得到，且调了也只得到「尚未实现」；绑定执行体那天必须重新裁定要不要门 |
| `create_mutex_group` | **允许** | MUTEX-01：新建组不改任何既有应用行为（应用只在 `update_application` 里显式挂组才入组）；会话白名单只给 `chat` / `sop_authoring` / `app_scaffold` |
| `update_mutex_group` | **允许**（写类默认不审批；真正的闸是**会话白名单**） | 只有 `chat` 会话可调：收紧 `scope`/`maxConcurrentPerDevice` 会**立即限制**在跑业务的并发，属「人该拍板」（registry 头注如此定性，但**未**设逐工具 `approvalRequired`，兜底靠白名单） |
| `sop_assign` | **允许** | 把已发布 SOP 版本指派给执行器（生成执行器拉取的指派单，`resourceKind=sop`）；会话白名单只给 `sop_authoring`。搬运的是**已发布**版本——发布那一步有人工闸 |
| `sop_draft` | **允许** | 只写工作副本（draft 语义）；已发布版本是快照，改工作副本不影响它，成为执行依据仍需 `sop_publish` |
| `sop_reply_clarification` | **允许**（受控修订） | 只对在途指派的既有澄清行生效、bump 固定 `patch`，且走与 `sop_publish` 同一严格校验 + 版本快照；`sop_review` 白名单刻意不给 `sop_publish`/`sop_draft` |

> ⚠️ **两个已知零门缺口**（登记在 `GATE_INVENTORY` 的 `kind: "known-gap"`，不是本表的笔误）：
> ① `create_task_from_template`（S1-C1，P0）——`overrides` 走 `freeTextFields` 且绑定时原样展开，
> `glueSource` 一路到执行器；② `deploy_application` / `deploy_app`——见 §3.1。
> 本表的作用是让它们**可见**，不是宣布它们安全。

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

### 3.1 代码事实：`deploy_application` 在 Agent 侧**没有**审批

`deploy_application` / `deploy_app` 在注册表里是 `tier: "write"`、**没有** `approvalRequired`
（`tool-registry.ts:785-804`、`:811-827`），执行体直接调 `AppDeploymentService.deploy()`
（`tool-binder.service.ts:482-492`）。因此 Agent 闸门**不会**为它建审批单、**不会**挂起会话，
`agent_boundary` 的 `NEED_APPROVAL` 分支对它不生效。

真正的人门在**下游**：应用行 `approvalRequired === true` 时，`deploy()` 把请求冻结成
`status=pending` + `approvalStatus=pending_approval` 的行并**直接返回、不派发**
（`app-deployment.service.ts:1363-1416`，派发只发生在第二人的 `approve()` 里）。
而这个开关是**按应用**的、默认 `false`（`application.entity.ts:60`）——
**从未开过审批的应用，Agent 部署是零门的**。这是方案 C 的已知残余风险。

### 3.2 为什么是方案 C（不是两层审批）

本文件早期版本在这里画过一条「`boundary.check()` 判定需审批 → 创建 AgentApproval →
挂起 → 恢复后再进 DEP-04」的流程图。**那不是代码行为**，是当时留给产品决策的一个选项。
实际落地的是方案 C：

| 方案 | 说明 | 结论 |
|---|---|---|
| A. 两层都走 | Agent 审批 + DEP-04 审批 | **未采纳**——一次部署要点两次 |
| B. 合并 | Agent 审批通过后以「已授权」标记跳过 DEP-04 | **未采纳**——需在 DEP-04 里开特例，削弱双人原则 |
| C. Agent 审批即 DEP-04 审批 | Agent 不单独审批，`deploy_application` 返回 `pending_approval`，Agent 转述给人 | **已落地**——`tool-binder.service.ts:482-484` 逐字写着「方案 C」，零特例 |

方案 C 的论据是「DEP-04 是唯一审批事实源，审计链干净」。该论据**成立的前提是应用开了审批**；
默认 `false` 意味着它对多数应用不成立，故两个部署工具按 `kind: "known-gap"` 登记在
`GATE_INVENTORY`（与 `create_task_from_template` 的 S1-C1 并列）。

> 要不要把 DEP-04 的默认值改成 `true`、或给部署工具补一个逐工具审批闸，是**产品/安全决策**，
> 不在本文档的裁定范围内；本节的职责只是把「今天实际是什么样」写对。

### 3.3 判据不再靠人记：显式清单 + 双向守卫

问题根因不是某一处写错，而是**判据只存在于人的记忆里**：`write` 且没有 `approvalRequired`
的工具天生无门，而**没有任何一处会因此变红**（默认策略 `writeRequiresApproval=false`，
`agent-boundary.service.ts:68`）。于是「文档说某工具要审批、代码里没有」可以长期静默存在
——`deploy_application` 就是这么漂移了一整个版本周期的。

落点：

- `apps/admin-api/src/modules/agent/tools/gate-inventory.ts` —— `GATE_INVENTORY` 冻结
  「`tier === "write"` 且无 `approvalRequired`」的**全部 16 个**工具名，逐条带
  ① 理由类别（收敛性 / 可逆 / 只新建 / 草稿 / 上游已闸 / 会话白名单 / 受控修订 /
  未绑定 / **已知缺口**）与 ② 证据（file:line）。`known-gap` 必须带 `ref`。
- `apps/admin-api/src/modules/agent/tools/__tests__/gate-inventory.spec.ts` —— **双向**比对：
  漏登记红（新增无门写工具）/ 陈旧红（清单里的名字删了、工具补了审批）/ 幽灵名红
  （清单里有、注册表没有）/ 空理由红 / 高危动词命名被标成 `read` 也红。
- 维护成本是**一行清单 + 一句理由**：每新增或改名一个 `tier: "write"` 的工具都要表态一次。
  这正是目的——把「忘了想审批」变成编译/测试期就撞上的墙，而不是上线后才发现。

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
