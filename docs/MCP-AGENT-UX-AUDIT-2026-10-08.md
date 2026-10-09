# MCP Server —— Agent 视角工具面审计

> 日期：2026-10-08 · 基线 commit：`e4678866` · 包版本：`autocodeflow-mcp-server@1.9.0`
> 审计对象：`packages/mcp-server/src`（`tools.ts` 1699 行 / `index.ts` / `api.ts`）
> 验证方式：**真实 stdio JSON-RPC 握手**（`initialize` + `tools/list`，见 §9 探针脚本）
> ＋ 源码逐工具对读 ＋ 后端 DTO 对账。
> 对照对象：`packages/acf-cli`（同日已修复，见 `docs/CLI-AGENT-UX-AUDIT-2026-10-08.md`）

> **⚠ 计数时效（2026-10-09 补注）**：本文的 **52 工具**、**161/161 测试** 是
> 2026-10-08 基线的**当时值**，作为历史记录保留、不逐处改写。此后：
> · MCP 工具 **52 → 56**（MUTEX-01 互斥组四工具 `list/create/update/delete_mutex_group`，
>   见 `docs/atlas/02-packages/mcp-server.md`）；
> · 探针的绝对计数断言已同步为 `EXPECTED_TOOLS = 56`（`scripts/mcp-tools-probe.cjs`）。
> 下文的「52」一律按此口径换算，不再单独标注。

---

## 修复状态（2026-10-08 同日闭环）

P0 与两项 P1 已落地；`packages/mcp-server` **161/161 全绿**（基线 152 + 新增 9 条回归）
+ `tsc --noEmit` 退出 0。修复前后实测（同一探针脚本）：

| 指标 | 修复前 | 修复后 |
|---|---|---|
| `WITH annotations` | **0 / 52** | **52 / 52** |
| schema 里真 enum 属性 | 2（`get_execution_logs.level`、`sop_clarification_reply.resolution`） | **4**（+ `deploy_application.runMode`、`deploy_app.runMode`） |
| 缺省 runMode 发给后端 | **不传** → 后端落 `daemon`（部署即跑） | **显式 `scheduled`**（仅部署、待触发） |
| 显式 `once`/`daemon` 的返回 | 无任何提示 | `startsImmediately: true` + 说明文案 |
| SOP/agent 6 个工具的 ADMIN 标注 | 无（靠 403 才发现） | description 前缀 `ADMIN only.` |

实测的 annotations 落点（`tools/list` 真实回包）：

```
list_tasks          {"readOnlyHint":true,"idempotentHint":true}
trigger_task        {"destructiveHint":false}
kill_execution      {"destructiveHint":true}
delete_application  {"destructiveHint":true}
deploy_application  {"destructiveHint":true}
```

> **⚠ 关于 `destructiveHint` 的规范语义**（我第一版分类做错了，留痕）：
> 该字段在 MCP 规范里**默认就是 `true`**，所以标 `destructiveHint: true` 只是"确认默认值"、
> 不改变客户端行为；真正有信息量的是给**纯增量写**标 `destructiveHint: false`
> （`trigger_task` / `create_application` / `import_task` 等），避免客户端对它们弹确认。
> 而 `readOnlyHint` 默认 `false`，标 `true` 才有意义。已按此重做分类。

---

## 0. 结论摘要

MCP 面**功能完整度高于 CLI**（52 个工具，覆盖 8 个域），而且**实测全部可被客户端列出**、52/52 都有 description 与 inputSchema、152/152 单测绿。基础工程质量是好的。

但和 CLI 一样，问题不在"有没有"，而在**给 agent 的语义精度**。四类：

| 级别 | 问题 | 影响 | 状态 |
|---|---|---|---|
| **P0** | `deploy_application`/`deploy_app` 缺省 = `daemon`（部署即启动入口脚本），与 CLI 已修的 P0 事故同源 | agent 按描述"部署"一个应用，实际立刻跑起来 | **✅ 已修** |
| **P1** | 119 个字符串参数里只有 **2 个**是 `z.enum`，其余约 15 个枚举字段是散文 | agent 传错值拿不到 schema 级校验，只能靠 400 试错 | **✅ 部分**（两个 `runMode` 已改真 enum；其余 13 处待做） |
| **P1** | 0/52 有 `annotations`（readOnly/destructive/idempotent 提示） | 客户端无法对 12 个破坏性工具做确认策略 | **✅ 已修**（52/52） |
| **P1** | SOP/agent 6 个工具面向 ADMIN-only 端点却不提 ADMIN | 非管理员 agent 靠 403 才发现 | **✅ 已修** |
| **P2** | `sop_assignments_pending` 服务端不分页却做客户端全量过滤 | 大 SOP 面下拉全表，无上限 | ⬜ 未做 |
| **P2** | `get_execution` 的 "512 KB" 在描述与 note 里各硬编码一次 | 常量漂移（改一处漏一处） | ⬜ 未做 |
| **P2** | 0/52 有 `outputSchema` / `structuredContent` | 消费方无法从契约得知返回形状 | ⬜ 未做（较重） |

**关键结论：MCP 不是 CLI 的子集或超集，两者互补。** MCP 独有 8 项 CLI 完全没有的能力（§4.1），
CLI 独有 5 项 MCP 没有的（§4.2）——详见对照。

---

## 1. 实测基线（真实握手，非静态推断）

用 `initialize` + `tools/list` 跑真实构建产物：

```
serverInfo: {"name":"autocodeflow","version":"1.9.0"}
TOOL COUNT: 52
missing description: (none)          ← 52/52 都有
missing inputSchema: (none)          ← 52/52 都有
WITH outputSchema: 0 / 52            ← 关键
WITH annotations : 0 / 52            ← 关键
required-param total: 49
tools with 0 required params: 15
schema props with enum: 2 | plain string props: 119   ← 关键
enum-bearing prop samples: get_execution_logs, sop_clarification_reply
```

**方法学更正留痕**：我最初用 `z\.enum\(` 单行 grep 得"0 个 enum"，
与子代理的"2 个"冲突。核实后**子代理正确、我错**——枚举参数写成跨行形式：

```ts
level: z
  .enum(["ERROR", "WARN", "INFO", "DEBUG"])
```

单行 grep 漏掉。这也解释了为什么 `enum(` 计数是 2。教训：跨行链式调用的 grep
必须按 `enum(` 而非 `z.enum(` 匹配，或直接跑真实 schema 自省（本次探针即后者）。

---

## 2. 工具清单（52 个，按域）

| 域（注册函数） | 工具数 | 工具 |
|---|---|---|
| `registerTaskTools` | 21 | …（见上行） |
| `registerApplicationTools` | 6 | `list_applications` `get_application` `create_application` `update_application` `delete_application` `analyze_application` |
| `registerDeploymentTools` | 9 | `list_deployments` `deploy_application` `deploy_app` `upgrade_deployment` `stop_deployment` `list_pending_approvals` `approve_deployment` `reject_deployment` `cancel_deployment` |
| `registerExecutorTools` | 3 | `list_executors` `get_executor` `get_executor_metrics` |
| `registerObservabilityTools` | 3 | `get_execution_timeline` `list_dead_letters` `get_scheduler_health` |
| `registerAuditTools` | 1 | `list_audit_logs` |
| `registerProjectTools` | 3 | `list_projects` `get_project_members` `get_my_project_roles` |
| `registerSopTools` | 6 | `sop_list` `sop_get` `sop_assignments_pending` `agent_session_list` `agent_session_get` `sop_clarification_reply` |
| **合计** | **52** | 21+6+9+3+3+1+3+6 = 52（脚本机械计数，见 §9） |

> 注：`list_task_templates`/`create_task_from_template` 注册在 `registerTaskTools` 内
> （函数体未按能力域拆分），上表按**实际注册位置**归组，不按语义归组。

---

## 3. P0：部署缺省 `daemon` —— 与 CLI 已修事故同源

### 证据

`tools.ts:870-873` 与 `:924-927` 两处（`deploy_application` / `deploy_app`）：

```ts
runMode: z
  .string()
  .optional()
  .describe("Run mode: once | daemon | scheduled (default daemon)"),
```

`runMode` 是 `.optional()`，handler 里按 `Object.entries({...}).filter(...)` 只发非
undefined 字段（`:882` / `:948`）——**不传就不发**，于是落到后端默认值。而后端：

```ts
// apps/admin-api/src/modules/application/dto/...:61
@ApiPropertyOptional({ enum: RunMode, default: RunMode.DAEMON })
@IsEnum(RunMode)
@IsOptional()
runMode?: RunMode;
```

`RunMode.DAEMON = "daemon"`。

### 为什么是 P0

这正是 CLI 在 2026-10 实测修掉的同一个 P0（`apps.ts` 的 `-m` 语义事故）：
**`daemon` = 部署时立刻启动入口脚本且异常自动重启**。agent 读到 "Deploy an application"
的自然理解是「把代码放上去、待命」，实际会**立即执行**——若该应用随后还被任务调度
触发，就是两边并发写同一产物目录的双跑事故。

CLI 那边已把缺省改成 `scheduled` 并加黄警；**MCP 这边描述仍写 "default daemon"**，
且没有对应的预警分支。

### 建议（✅ 已实施）

- 与 CLI 对齐：`runMode` 缺省时**显式传 `scheduled`**（不再让后端落 daemon）；
- 显式传 `once`/`daemon` 时，返回体加 `startsImmediately: true` + 说明文案
  （复用既有的 `pending_approval` → `dispatched:false` 分支模式）；
- 工具级 description 与参数 `.describe()` 都写清 "OMIT for the safe default"；
- `runMode` 由 `z.string()` 升级为 `z.enum(["once","daemon","scheduled"])`，非法值在 schema 层即拒。

> 回归锁：`tools.test.ts` 新增 `describe("deploy runMode safety (P0)")` 共 4 条
> （缺省发 scheduled / 显式 daemon 带 startsImmediately / scheduled 不带 / runMode 是真 enum）。

---

## 4. CLI ↔ MCP 能力对照（互补关系）

### 4.1 MCP 有、CLI 完全无入口（8 项）

| MCP 工具 | 能力 | CLI 现状 |
|---|---|---|
| `get_scheduler_health` | 调度器健康：leader/选举、BullMQ 队列深度、tick 率、P99 触发延迟 | ❌ 无（`task list` 不含） |
| `get_execution_timeline` | 执行时间线 + 失败分诊卡（failureReason → 首个动作） | ❌ 无（`task logs` 只给原始行） |
| `list_dead_letters` | 回调死信积压（按执行器聚合） | ❌ 无 |
| `list_task_templates` | 任务模板列表 | ❌ 无 |
| `create_task_from_template` | 从模板实例化任务 | ❌ 无（需手拼 `--body`，且曾踩 `version` 字段坑） |
| `get_my_project_roles` | 当前凭据的项目角色 | ❌ 无（`project list` 给 myRole 但不给 isAdmin 汇总） |
| `retry_execution` | 重跑历史执行（重放原参数） | ❌ 无（只有 `task trigger`） |
| `list_pending_approvals` 的 `applicationId` 过滤 | 按应用筛待审批 | ⚠️ CLI 有 `approval list -a`（已对齐，此处列出仅为完整性） |

> 这 7 项（除最后一行）**正是我 CLI 审计里登记为「无收窄理由、更像遗漏」的那批**。
> MCP 已经实现，说明后端能力齐备、只是 CLI 没接——**MCP 可作为 CLI 的补面依据**。

### 4.2 CLI 有、MCP 无入口（5 项）

| CLI 能力 | MCP 现状 | 评价 |
|---|---|---|
| `acf task lint <file>` | ❌ | **有意为之**：MCP 无文件系统职责（§7），lint 需要读本地文件 |
| `acf exec tail`（SSE 实时跟随） | ❌ | ⚠️ 真实缺口：MCP 只能 `get_execution_logs` 轮询分页，无流式；但 MCP 协议本身无"流式 push"原语，属架构限制而非疏漏 |
| `acf logout` / `acf whoami` | ❌ | 合理：MCP 是长驻进程、凭据走 env，无登录态管理职责 |
| `acf config *` | ❌ | 合理：CLI 特有 |
| `acf apikey *`（创建/吊销限权 Key） | ❌ 未暴露 | ⚠️ **有意收窄**（JWT-only 面），合理——不应让 agent 自造凭据 |

**判断**：4.2 里除 `exec tail` 外都属合理的职责边界。`exec tail` 的缺失是 MCP 协议
限制（无 server-push 流），可在描述里明示"用 `get_execution_logs` 轮询"以降低 agent 困惑。

---

## 5. P1：schema 精度不足（agent 最直接的痛点）

### 5.1 枚举几乎全是散文

119 个字符串参数里**只有 2 个**是真正的 `z.enum`。其余约 15 个显式枚举字段是
`z.string()` + `.describe("... a | b | c ...")`。实测样本：

```ts
// list_tasks
status: z.string().optional().describe("Filter by task status: active | paused")
// list_executions
status: z.string().optional().describe("Filter by status: pending | running | waiting | success | failed | timeout | killed | cancelled")
// agent_session_list
status: z.string().optional().describe("... pending | running | waiting_input | succeeded | failed | aborted | budget_exceeded")
```

**为什么对 agent 有害**：散文枚举意味着
1. 客户端无法在 schema 层做参数校验/自动补全；
2. agent 传 `status: "cancelled"`（美式拼写）或 `"timeout "`（尾空格）时，
   错误发生在**服务端 400**，而不是工具调用前的本地拒绝——错误反馈链更长；
3. CLI 侧同类字段有本地白名单预检（`emitUsageError` + 码 2），**MCP 反而更松**。

**建议**：把这 15 个字段改成 `z.enum([...])`（或至少加 `.refine`）。zod 4 原生支持，
改动纯声明式、零运行时风险。

**✅ 本轮进度**：两个 `runMode`（`deploy_application` / `deploy_app`）已升级为真 enum
——它们同时是 P0 的载体，故优先。其余 13 处（`list_tasks.status`、`update_task.status/
triggerType/runtime/executeMode`、`list_executions.status`、`update_application.status`、
`sop_list.status`、`agent_session_list.kind/status`、`list_audit_logs.*`）**仍未做**。

### 5.2 零 `annotations`（0/52）→ **✅ 已修（52/52）**

MCP 协议的 `annotations` 提供 `readOnlyHint` / `destructiveHint` / `idempotentHint` /
`openWorldHint`，客户端据此决定是否弹确认。修复前 **52/52 全无**，于是破坏性工具
与只读工具（`list_*` / `get_*`）在客户端看来**完全一样**。

**✅ 已实施**：52 个工具全部声明 annotations——29 个 `readOnlyHint:true`、
23 个 `destructiveHint`（其中 9 个 `true` 显式登记破坏集合、14 个 `false` 覆盖规范默认）、
13 个 `idempotentHint:true`。分类依据是 handler 实际发出的 HTTP 动词，不是工具名措辞。

> 注入用的是一次性 codemod，且**对未分类的工具名直接报错退出**
> （实测它确实拦下了一个我漏掉的 `resume_task`）——新增工具无法"静默无标注"上线。
> 回归锁见 `tools.test.ts` 的 `describe("tool annotations")` 共 5 条。

### 5.3 零 `outputSchema` / 零 `structuredContent`（⬜ 未做）

所有成功响应都是 `JSON.stringify(data, null, 2)` 的单块文本。agent 必须解析
自然语言化的 JSON 文本，而不是拿到结构化对象。`get_execution` 甚至还**改造**了
形状（§8），消费方无法从契约上得知会有 `logsStripped` / `note` 字段。

**建议**（较重，本轮未做）：至少对高频读面（`list_tasks` / `get_task` / `get_execution`）
补 `outputSchema`。

---

## 6. 破坏性与执行触发面（供客户端确认策略用）

**破坏性/不可逆（13，已标 `destructiveHint: true`）**：`delete_application`、
`kill_execution`、`stop_deployment`、`reject_deployment`、`cancel_deployment`、
`rollback_task_version`、`pause_task`、`sop_clarification_reply`（`resolution=sop_amended`
会改动线上 SOP）、`update_task`、`update_application`，以及三个**会真正拉起进程/改动线上
版本**的动作：`deploy_application`、`deploy_app`、`upgrade_deployment`。
（`approve_deployment` 批准即派发，也计入。）

**纯增量写（已标 `destructiveHint: false` 以覆盖规范默认，避免客户端多余弹确认）**：
`trigger_task`、`retry_execution`、`resume_task`、`create_application`、
`create_task_from_template`、`import_task`、`analyze_execution`、`suggest_schedule`、
`analyze_application`。

**会触发真实执行（7）**：`trigger_task`、`retry_execution`、`deploy_application`、
`deploy_app`、`upgrade_deployment`、`approve_deployment`（批准即派发）、
`create_task_from_template`。

**ADMIN 提及（修复前 5 → 现在 11）**：原有的 `list_pending_approvals`、
`approve_deployment`、`reject_deployment`（三者明写 "ADMIN only"）、`list_projects`
（"Admins see all projects"）、`get_project_members`（"Admins can read any project"）；
**本轮补齐 6 个 SOP/agent 工具**（见下）。

> **✅ 一致性已修**：`registerSopTools` 全部 6 个工具面向 ADMIN-only 的
> `/sop` `/agent` 端点，但修复前**没有一个工具的 description 提到 ADMIN**——
> 非管理员 agent 会以为 SOP 面可用，拿到 403 才发现。
> 现已在这 6 个 description 前统一加 `ADMIN only.` 前缀（与 deployment 域的做法对齐）：
> `sop_list` / `sop_get` / `sop_assignments_pending` / `agent_session_list` /
> `agent_session_get` / `sop_clarification_reply`。

---

## 7. 文件系统零职责（正确的设计）

`tools.ts` **没有任何** `fs` 写入/下载。唯一的 "download" 匹配是
`packageUrl` 的字段描述与失败手册文案。`export_task` 明确声明：

> "save it to a file yourself (MCP tool output is not written to disk)"

这是正确的边界——MCP server 不该替 agent 落盘。文件活动发生在远端执行器主机
（`list_dead_letters` 注明死信在 `<work_dir>/callbacks/dead-letter`）。

---

## 8. P2 项

1. **`sop_assignments_pending` 无分页**：其余所有分页后端列表工具都有
   `page`/`pageSize`，唯有它在客户端对**全量未分页**列表做 `.filter()`。
   SOP assignment 量大时会拖全表。建议改为服务端过滤或补分页。
2. **`512 KB` 常量重复两次**（description 与运行时 note 各一次）。应提为单一常量
   并从一处渲染，否则改一处漏一处。
3. **`get_execution` 改造响应形状**且不在任何 schema 里声明（`logsStripped`/`note`
   是运行时才出现的字段）。建议在 description 里预告，或补 `outputSchema`。
4. **`list_dead_letters` 对执行器列表无上限**（无 `.slice`），集群大时返回体无界。

---

## 9. 复现方式

```bash
cd packages/mcp-server && npm run build
node ../../scripts/mcp-tools-probe.cjs        # 真实 stdio 握手 + 52 工具自省
npx vitest run                                # → 152 passed
```

探针脚本 `scripts/mcp-tools-probe.cjs` 做 `initialize` → `notifications/initialized`
→ `tools/list`，并统计：工具总数、缺 description/inputSchema 的、有 outputSchema 的、
有 annotations 的、必填参数总数、零参工具数、schema 里 enum 属性数 vs 纯 string 属性数。

§2 表格的**按域机械计数**另用一段内联脚本核对（按 `export function register*Tools`
切成区间、数区间内 `server.tool(` 出现次数，8 段之和须等于总数）：

```bash
node -e "
const fs=require('fs');const lines=fs.readFileSync('src/tools.ts','utf8').split('\n');
const f=[];lines.forEach((l,i)=>{const m=l.match(/^export function (register\w+Tools)/);if(m)f.push({n:m[1],l:i+1});});
f.push({n:'END',l:lines.length+1});
for(let k=0;k<f.length-1;k++){const seg=lines.slice(f[k].l-1,f[k+1].l-1).join('\n');
console.log(f[k].n, (seg.match(/server\.tool\(/g)||[]).length);}
"

---

## 10. 与 CLI 的对称性总评

| 维度 | acf CLI | MCP server |
|---|---|---|
| 命令/工具数 | 63 | 52 |
| 实时流 | ✅ `exec tail`（SSE） | ❌（协议限制，用 `get_execution_logs` 轮询） |
| 本地文件职责 | ✅ lint/glue/export 落盘 | ❌（正确——不该替 agent 落盘） |
| 破坏性操作确认 | ✅ 已统一 `-y` 门 | ✅ 已补 annotations（52/52） |
| 枚举参数校验 | ✅ 本地白名单预检（码 2） | ⚠️ 仅 4 处真 enum，其余 13 处散文（待做） |
| 部署缺省语义 | ✅ `scheduled` + 黄警 | ✅ `scheduled` + `startsImmediately` 提示 |
| 退出码/错误分类 | ✅ 5 类（0/1/2/3/4+130） | ⚠️ 只有 `isError` + message 文本（协议所限） |
| 输出结构契约 | ✅ `--json` 双形态（列表紧凑/详情 pretty） | ⚠️ 全为文本块，0 `outputSchema`（待做） |
| 观测面（调度器/死信/时间线） | ❌ | ✅ 3 个工具 |
| 模板面 | ❌ | ✅ 2 个工具 |
| 重试执行 | ❌ | ✅ `retry_execution` |

**一句话**：CLI 侧本轮补的是「无人值守语义」（确认门 + 退出码 + 非交互安全），
MCP 侧本轮补的是「破坏性标注 + 部署缺省安全 + ADMIN 可发现性」。
**两侧还剩的缺口不同源**：CLI 缺观测/模板面（MCP 已有），MCP 缺 schema 精度与
输出结构契约（CLI 的 `--json` 已相当成熟）——不能靠改一边解决另一边。

---

## 附：本轮证据边界（诚实声明）

- MCP **工具定义**经真实 stdio 握手验证（52 个全部列出、schema 与 annotations 自省）；
  但**未对任何工具发真实业务调用**（admin-api 未启动），故各工具的运行时返回形状
  来自源码对读与单测（161 例）。
- `runMode` 缺省 `daemon` 的结论基于**后端 DTO 源码**
  （`@ApiPropertyOptional({ default: RunMode.DAEMON })`）；修复后已用单测钉死
  "缺省必发 `scheduled`"，但**未做真实部署实测**（需起 admin-api + 执行器）。
- 断言"缺省会立刻启动入口脚本"的依据是后端 `RunMode` 语义与 CLI 侧同源的
  2026-10 实测事故记录（`apps.ts` 注释），非本轮真机复现。
- 探针脚本 `scripts/mcp-tools-probe.cjs` 是本次新增的**只读**诊断工具
  （只发 `initialize`/`tools/list`，不发任何业务调用）。