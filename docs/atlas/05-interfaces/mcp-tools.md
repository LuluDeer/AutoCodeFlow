# MCP 工具地图（40 个）
> 所属: docs/atlas/05-interfaces · 最后核对: 2026-09-13 · 对应代码: packages/mcp-server/src（tools.ts 注册 40 个 server.tool；index.ts 入口）

## 怎么连

- 包名 `autocodeflow-mcp-server`（npm），bin 名 **`autocodeflow-mcp`**；stdio 传输（JSON-RPC on stdin/stdout），服务器名 `autocodeflow`。
- 启动：`node dist/index.js`（无参数即跑）；`--help` / `--version` 直接退出。未设置 token 时进程直接 exit 1（fail-closed，W-07）。
- 客户端配置（Claude Desktop / Cursor 等）示例：

```json
{
  "mcpServers": {
    "autocodeflow": {
      "command": "npx",
      "args": ["-y", "autocodeflow-mcp-server"],
      "env": {
        "AUTOCODEFLOW_API_URL": "http://localhost:3105",
        "AUTOCODEFLOW_API_TOKEN": "<JWT access token>",
        "AUTOCODEFLOW_API_REFRESH_TOKEN": "<可选，启用 401 自愈>"
      }
    }
  }
}
```

## 鉴权（JWT env，非 OAuth）

| 环境变量 | 必填 | 说明 |
|---|---|---|
| `AUTOCODEFLOW_API_URL` | 否 | 默认 `http://localhost:3105` |
| `AUTOCODEFLOW_API_TOKEN` | **是** | 用户 JWT Bearer token；缺失则启动即退出 |
| `AUTOCODEFLOW_API_REFRESH_TOKEN` | 否 | 设置后 401 自动单飞 `POST /auth/refresh` 并重放原请求；token 只存内存（BUG-14） |

请求侧：30s 超时预算（`REQUEST_TIMEOUT_MS`）；工具调用即对应 REST 端点，因此同样受 RBAC/限流约束——建议给 Agent 建独立低权用户而非共用 ADMIN。

## 工具地图（按注册域分组，共 40 个）

### Task 域 — registerTaskTools（18 个）

| 工具 | 参数概要 | 语义（→ REST 端点） |
|---|---|---|
| list_tasks | page/pageSize/status/name | 任务列表（GET /tasks） |
| get_task | taskId | 任务详情（GET /tasks/:id） |
| trigger_task | taskId, params? | 立即触发并返回 executionId（POST /tasks/:id/trigger）；不支持 per-run 钉扎（DTO 白名单 400） |
| update_task | taskId + 任务字段… | PATCH 更新；`executorId` 钉扎/置 null 清除；与 `executeMode="broadcast"` 互斥 400 |
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
