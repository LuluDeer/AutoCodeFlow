# MCP 工具地图（56 个）
> 所属: docs/atlas/05-interfaces · 最后核对: 2026-10-25 · 对应代码: packages/mcp-server/src（tools.ts 注册 **56** 个 server.tool，9 个 register*Tools；index.ts 入口）
>
> 数量由 `scripts/check-interface-maps.mjs` 守护：源码注册的工具名必须逐个出现在本页，缺一即红。**手写枚举必然单向腐烂**（本页曾停留在 40 个，实际 56 个，漏了 16 个）。

## 怎么连

- 包名 `autocodeflow-mcp-server`（npm），bin 名 **`autocodeflow-mcp`**；stdio 传输（JSON-RPC on stdin/stdout），服务器名 `autocodeflow`。
- 启动：`node dist/index.js`（无参数即跑）；`--help` / `--version` 直接退出。未设置 token 时进程直接 exit 1（fail-closed，W-07）。
- 客户端配置（Claude Desktop / Cursor 等）示例——**推荐用 API Key**（见下节「Token 从哪来」）：

```json
{
  "mcpServers": {
    "autocodeflow": {
      "command": "npx",
      "args": ["-y", "autocodeflow-mcp-server"],
      "env": {
        "AUTOCODEFLOW_API_URL": "http://localhost:3105",
        "AUTOCODEFLOW_API_TOKEN": "acf_<你的 API Key>"
      }
    }
  }
}
```

> 本进程**没有账号密码登录**、**没有 `--token` 参数**、**不落盘**——凭据只能经环境变量注入，进程重启要重新注入。

## Token 从哪来（两条路，按 MCP 常驻时长选）

`AUTOCODEFLOW_API_TOKEN` **既接受 API Key 也接受用户 JWT**（都走 `Authorization: Bearer …`，服务端按 `acf_` 前缀分流到 API Key 校验链）。

### 路线 A：API Key（常驻 MCP 推荐）

1. 登录中台 → **系统 → 系统设置 → API Keys → 新建 API Key**；
2. 按要用的工具选 scope：

   | scope | MCP 能做什么 |
   |---|---|
   | `readonly` | 全部只读工具（`list_tasks` / `get_execution` / `get_execution_stats` …） |
   | `trigger` | 只读 + 单任务触发（`trigger_task`） |
   | `manage` | 只读 + 全部写工具（建/改/暂停任务、部署应用 …） |

3. 创建弹窗里的明文 `acf_…` **只显示这一次**（服务端只存 SHA-256），复制后填进 `AUTOCODEFLOW_API_TOKEN`。

API Key 可设有效期或永不过期，吊销下一次调用即生效；它是用户 JWT 的**真子集**（`/api-keys`、`/auth/*`、`/users`、`/config` 一律拒绝），但**本仓 56 个 MCP 工具都不碰这四个前缀**，所以对 MCP 够用。ADMIN-only 工具（如 `approve_deployment`、`list_pending_approvals`）需要走路线 B。

### 路线 B：用户 JWT（只有它能用 ADMIN-only 工具）

中台前端**没有「复制我的 token」入口**；浏览器之外的正规获取方式是 CLI：

```bash
acf login --url http://localhost:3105 --user <你>   # 密码 + TOTP
acf config show                                    # 打印配置文件路径
```

- `AUTOCODEFLOW_API_TOKEN` = `~/.config/acf-cli/config.json`（0600）里的 `token` 字段——**只有 15 分钟**；
- `AUTOCODEFLOW_API_REFRESH_TOKEN` = 同文件的 `refreshToken` 字段（30 天）——配上它，401 时才会自动续期并重放；不配就得每 ~15 分钟重启一次 MCP 进程换新 token。

> 用 API Key 时**不需要** refresh 变量：`/auth/*` 是 JWT-only 面，无票可续。

## 鉴权（env 注入，非 OAuth）

| 环境变量 | 必填 | 说明 |
|---|---|---|
| `AUTOCODEFLOW_API_URL` | 否 | 默认 `http://localhost:3105` |
| `AUTOCODEFLOW_API_TOKEN` | **是** | API Key（`acf_…`，推荐）或用户 JWT；缺失则启动即退出 |
| `AUTOCODEFLOW_API_REFRESH_TOKEN` | 否 | **仅 JWT 有意义**：设置后 401 自动单飞 `POST /auth/refresh` 并重放原请求；token 只存内存（BUG-14） |

请求侧：30s 超时预算（`REQUEST_TIMEOUT_MS`）；工具调用即对应 REST 端点，因此同样受 scope / RBAC / 限流约束——建议给 Agent 建**独立低权用户或 readonly API Key**，而非共用 ADMIN。

## 工具地图（按注册域分组，共 56 个）

### Task 域 — registerTaskTools（21 个）

| 工具 | 参数概要 | 语义（→ REST 端点） |
|---|---|---|
| list_tasks | page/pageSize/status/name | 任务列表（GET /tasks） |
| get_task | taskId | 任务详情（GET /tasks/:id） |
| trigger_task | taskId, params? | 立即触发并返回 executionId（POST /tasks/:id/trigger）；不支持 per-run 钉扎（DTO 白名单 400） |
| update_task | taskId + 任务字段…（2026-10-25 MCP-DTO-ALIGN 对齐 UpdateTaskDto，新增 15 字段：secrets / maintenanceWindows / priority / timeout / timeoutSeconds / timeoutAction / timeoutWarnRatio / estimatedDurationSec / requirements / dependencies / blockStrategy / misfireStrategy / executorAffinity(Anti)Tags / deploymentPolicy / expectedUpdatedAt） | PATCH 更新；`executorId` 钉扎/置 null 清除；与 `executeMode="broadcast"` 互斥 400；secrets 逐键合并（叶子 `"******"` 保留存量、null 删键，键名规则复述会被拒）；priority 1-4；expectedUpdatedAt 乐观锁（冲突 409 → get_task 重取重试） |
| list_task_versions | taskId | 配置版本历史（GET /tasks/:id/versions） |
| rollback_task_version | taskId, versionId | 版本回滚（POST …/rollback） |
| compare_task_versions | taskId, v1, v2 | 版本字段级 diff |
| list_executions | taskId?, status?, 分页 | 执行列表（GET /tasks/executions/all） |
| get_execution | executionId | 执行详情+日志+AI 分析（GET /tasks/executions/:execId） |
| analyze_execution | taskId, executionId | AI 根因分析（POST …/analyze） |
| get_execution_stats | taskId | 成功率/均时长/近 20 次（GET /tasks/:id/stats） |
| suggest_schedule | taskId | AI 建议 cron（POST /tasks/:id/suggest-schedule） |
| get_execution_logs | executionId, fromLine?, limit? | 日志行分页（GET /tasks/executions/:execId/logs） |
| kill_execution | taskId, executionId | 强杀运行中执行（POST …/kill；需 taskId 因路由是 task 作用域） |
| retry_execution | executionId | 经手动触发路径**新建**一次执行（无原生 retry 端点，非续跑） |
| pause_task / resume_task | taskId | 暂停/恢复调度（不影响进行中执行） |
| create_task_from_template | name, template, overrides? | 内置模板建任务：`scheduled_backup / health_check / data_sync / log_cleanup / webhook_ping`（tools.ts `TASK_TEMPLATES`） |
| list_task_templates | — | 列出内置模板清单（本地常量，不落 REST） |
| export_task | taskId | 导出任务定义为可回灌 JSON（不含凭据） |
| import_task | 导出体 | 从导出体建任务；**幂等按名**，同名冲突走 409 |

### Application 域 — registerApplicationTools（6 个）

| 工具 | 参数概要 | 语义 |
|---|---|---|
| list_applications | 分页 | 应用列表 |
| get_application | applicationId | 详情（版本/git/runtime） |
| create_application | name(≤100 唯一)/version/runtime… | 注册应用 |
| update_application | applicationId + 字段 | 更新；**DTO 无 name 字段，不支持改名** |
| delete_application | applicationId | 删除 |
| analyze_application | applicationId | AI 健康度评估（聚合任务执行统计） |

### Deployment 域 — registerDeploymentTools（9 个，DEP-04 审批语义）

| 工具 | 参数概要 | 语义 |
|---|---|---|
| list_deployments | appId?, 分页 | 部署列表 |
| deploy_application | applicationId, executorId?, runMode?, env?, startCommand? | 部署；executorId 空=自动选最低负载在线执行器；开启审批的应用返回 `pending_approval` |
| deploy_app | appName（按名解析）… | 同上，按名称部署（GET /applications 解析 id） |
| upgrade_deployment | deploymentId | overlay 升级拉最新版本 |
| stop_deployment | deploymentId | 停止部署 |
| list_pending_approvals | — | 审批队列（ADMIN） |
| approve_deployment / reject_deployment | deploymentId, reason? | 审批通过/拒绝；**第二人规则**：审批人≠发起人，否则 API 报错（ADMIN） |
| cancel_deployment | deploymentId | 发起人撤回自己的待审批请求 |

### Executor 域 — registerExecutorTools（3 个）

| 工具 | 参数概要 | 语义 |
|---|---|---|
| list_executors | — | 执行器列表（在线状态/负载/心跳） |
| get_executor | executorId | 单执行器详情 |
| get_executor_metrics | executorId | 7 天执行统计 + 当前 runningTaskCount/CPU 等指标 |

### Observability 域 — registerObservabilityTools（3 个）

| 工具 | 参数概要 | 语义 |
|---|---|---|
| get_execution_timeline | executionId | OBS-04 时间线：created→started→finished + 失败 triage 卡片（failureReason → 建议动作） |
| list_dead_letters | — | 各执行器回调死信积压量（本地目录，退避重放，5 轮后进死信） |
| get_scheduler_health | — | 调度健康：leader 选举、BullMQ 队列深度（null=Redis 不可达）、tick 速率、P99 触发延迟 |

### Audit 域 — registerAuditTools（1 个）

| 工具 | 参数概要 | 语义 |
|---|---|---|
| list_audit_logs | 分页 + AuditQueryDto 白名单过滤 | 审计日志查询；越权查询字段 400 |

### Mutex 域 — registerMutexTools（4 个）

| 工具 | 参数概要 | 语义 |
|---|---|---|
| list_mutex_groups | — | 互斥组列表（同组任务不并发跑） |
| create_mutex_group | name, taskIds? | 建互斥组 |
| update_mutex_group | groupId + 字段 | 改组（成员/名称）；列级补丁写（ADR-026） |
| delete_mutex_group | groupId | 删除组（不删任务） |

### Project 域 — registerProjectTools（3 个）

| 工具 | 参数概要 | 语义 |
|---|---|---|
| list_projects | — | 当前用户可见的项目 |
| get_project_members | projectId | 项目成员与角色 |
| get_my_project_roles | — | 我在各项目里的角色（前端菜单/权限推导同源） |

### SOP 域 — registerSopTools（6 个）

| 工具 | 参数概要 | 语义 |
|---|---|---|
| sop_list | 分页/状态 | SOP 列表 |
| sop_get | sopId | SOP 详情（含版本与当前指派） |
| sop_assignments_pending | — | 待我处理的 SOP 指派 |
| sop_clarification_reply | assignmentId, body | 回复澄清提问（写入审计 `sop.reply`） |
| agent_session_list | 分页 | 中心 agent 会话列表（ADR-019） |
| agent_session_get | sessionId | 单会话详情 |

## 与 REST 的对应关系要点

1. 所有工具都是 **REST 的薄封装**（`apiRequest(method, path, body)` 注入式转发），无独立后端路由；端点语义以 [rest-api.md](rest-api.md) 为准。
2. 后端 ValidationPipe `forbidNonWhitelisted` → 任何工具传 DTO 外字段必 400（trigger_task 不设 executorId 正是因此）。
3. 工具返回值为 REST 响应 JSON 的 `text` content（`JSON.stringify` 缩进 2）。

## 常见坑

- **长进程 401**：不配 refresh token 时 access token 过期（默认 15 分钟）后所有工具永久 401，需重启进程换 token。
- MCP 侧**不持有** executor 共享 token；执行器面操作（注册/心跳/回调）不在工具范围内。
- stdio 传输：日志只允许写 stderr（`[autocodeflow-mcp] …`），stdout 全留给 JSON-RPC。

## 相关文档

- [../02-packages/mcp-server.md](../02-packages/mcp-server.md) — 包实现、测试与发布
- [rest-api.md](rest-api.md) — 工具背后的端点全集 · [../04-flows/approval-flow.md](../04-flows/approval-flow.md) — 审批第二人规则
- [../01-apps/admin-api/modules/task.md](../01-apps/admin-api/modules/task.md) — 任务域 DTO 细节
