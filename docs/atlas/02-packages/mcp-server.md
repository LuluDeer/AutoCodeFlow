# mcp-server — AI Agent 的 MCP 入口

> 所属: docs/atlas/02-packages · 最后核对: 2026-09-13 · 对应代码: packages/mcp-server

## 职责

npm 包 `autocodeflow-mcp-server`（v1.2.0，bin `autocodeflow-mcp`）：把 AutoCodeFlow 的任务/执行/应用/部署/执行器/审计能力以 **MCP（Model Context Protocol）工具**形式暴露给 Claude、Cursor 等 AI Agent。本质是 admin-api REST 的一个"带语义包装"的客户端——每个工具做参数校验、端点调用、信封拆包与错误翻译，不含任何调度/执行逻辑。

依赖（package.json 核实）：`@modelcontextprotocol/sdk 1.30.0`、`node-fetch 3.3.2`、zod；engines `node>=20`。测试 vitest（根目录 `npm run test:mcp`）。

## 目录结构与关键文件

```
packages/mcp-server/
├── package.json        bin: autocodeflow-mcp → dist/index.js
├── src/
│   ├── index.ts        McpServer 装配 + 注册 6 组工具 + bin CLI（--help/--version）
│   │                   VERSION 常量带 x-release-please-version 标记（lockstep 同步点）
│   ├── api.ts          apiRequest：Bearer 头、30s 超时、401 自愈刷新、信封 unwrap、错误翻译
│   ├── tools.ts        全部工具注册 + TASK_TEMPLATES + buildExecutionTimeline
│   └── __tests__/      api / tools / cli 测试
```

## 传输与鉴权（以代码为准）

- **传输：仅 stdio**（`StdioServerTransport`，JSON-RPC over stdin/stdout）。代码中无 HTTP/SSE transport——若需远程 MCP 需自行扩展。
- **鉴权：JWT Bearer**（不是 API Key）。环境变量：
  - `AUTOCODEFLOW_API_URL`（默认 `http://localhost:3105`）；
  - `AUTOCODEFLOW_API_TOKEN`（**必填**，缺失直接退出 exit 1，W-07）；
  - `AUTOCODEFLOW_API_REFRESH_TOKEN`（可选）：401 时单飞 `POST /auth/refresh` 换发并重放一次，新 refreshToken 只存内存（BUG-14 自愈；进程重启重新注入）。
- 每次 API 调用 30s 超时（N12）；成功响应剥掉 admin-api 全局 `{code,message,data}` 信封。unwrap 判据（WIKI-OPT-4 收紧）：对象含 `data` 键且 `code` 为**数值**即视为信封（对齐 ResponseInterceptor 的 `code` 恒为 `statusCode ?? 200`）；`message` 不再作为判据——实体自带 data+message 而无数值 code 时原样透传，不再被误解包截断成 data 值。
- bin 入口支持 `--help` / `--version`；无参即启动 stdio server。

## 工具清单（40 个，自 src/tools.ts 的 server.tool() 逐个核实）

**任务组 registerTaskTools（18）**

| 工具 | 关键参数 | 语义 |
|---|---|---|
| `list_tasks` | page/pageSize/status/name(模糊) | 分页列任务 |
| `get_task` | taskId | 任务详情（脚本源、cron、超时、依赖） |
| `trigger_task` | taskId, params? | 手动触发；**无 executorId 参数**（DTO 白名单会 400，执行器绑定是任务级字段） |
| `update_task` | taskId + PATCH 字段（含 executorId 可置 null、executeMode、executorGroup/Tags 等） | 部分更新；executorId 与 broadcast 互斥（400） |
| `list_task_versions` / `rollback_task_version` / `compare_task_versions` | taskId[, versionId(s)] | 版本史 / 回滚 / 字段级 diff |
| `list_executions` | taskId?/status?/page | 列执行（status: pending/running/success/failed/timeout/killed/cancelled） |
| `get_execution` | executionId | 执行详情+日志+AI 分析 |
| `analyze_execution` | taskId, executionId | 触发 AI 失败分析 |
| `get_execution_stats` | taskId | 成功率/平均时长/近 20 次 |
| `suggest_schedule` | taskId | AI 建议 cron |
| `get_execution_logs` | executionId, fromLine, limit(≤2000) | 行分页日志 |
| `kill_execution` | taskId, executionId | 强杀（路由 task-scoped 所以要 taskId） |
| `retry_execution` | taskId, executionId, params? | 重跑=新建执行（admin-api 无原生 retry 端点），自动回放原执行 params（NF-06） |
| `pause_task` / `resume_task` | taskId | 停/恢复排程（不影响进行中执行） |
| `create_task_from_template` | template, name, description?, overrides? | 从内置模板建任务（见下） |

**应用组 registerApplicationTools（6）**：`list_applications` `get_application` `create_application` `update_application` `delete_application` `analyze_application`（AI 健康分析）。

**部署组 registerDeploymentTools（9）**：`list_deployments`、`deploy_application`（applicationId，executorId 省略自动选最低负载）、`deploy_app`（按 name 先查 applications 再走同一路由，NF-06）、`upgrade_deployment`、`stop_deployment`，以及 **DEP-04 审批工具组**：`list_pending_approvals`（ADMIN）、`approve_deployment`（ADMIN，第二人规则：审批人≠发起人，否则后端报错）、`reject_deployment`（ADMIN）、`cancel_deployment`（仅发起人可撤）。审批启用时 deploy 工具返回 `approvalStatus=pending_approval` + `dispatched:false` + 下一步提示——**未审批前不会下发任何东西**。

**执行器组（3）**：`list_executors` `get_executor` `get_executor_metrics`。
**可观测组（3）**：`get_execution_timeline`（OBS-04：created→started→finished + 失败分诊卡）、`list_dead_letters`（按执行器聚合回调死信积压）、`get_scheduler_health`（leader、BullMQ 队列深度、P99 触发延迟）。
**审计组（1）**：`list_audit_logs`（page/pageSize/action/resource/userId/username/startTime/endTime，字段白名单外 400）。

## TASK_TEMPLATES 与 admin-api 官方模板的对齐

`tools.ts` 导出 `TASK_TEMPLATES`，含 5 个模板：`scheduled_backup` / `health_check` / `data_sync` / `log_cleanup` / `webhook_ping`。它与 admin-api 的官方预置模板是**同一口径的两份镜像**：

- 对齐声明在 `apps/admin-api/src/modules/task-template/task-template.constants.ts`（CORE-03）头部注释：五个 key、定位、config 字段集合**逐项对齐**，避免 admin 与 MCP 两套模板语义漂移；config 字段名/默认值以 CreateTaskDto 白名单为准，落库前经 `assertValidTaskTemplateConfig` 校验。
- 两侧都省略 `name`（实例化时提供）；`create_task_from_template` 的 `overrides` 可覆盖任意 CreateTaskDto 字段。
- **改动纪律**：改模板必须 admin-api 常量与本文件 `TASK_TEMPLATES` 同批改，两侧单测（task-template.service.spec / tools.test）都会拦漂移。

## 常见改动场景

**如何加一个 MCP 工具**：
1. 在 `tools.ts` 对应 `register*Tools` 里 `server.tool("my_tool", "<描述含语义与陷阱>", { zod 参数 }, handler)`；handler 只做 `call(method, path, body)` + `JSON_CONTENT`，HTTP 细节留给注入的 `call`（可 mock 单测）。
2. 新参数一律过 zod 并 `.describe()`；注意后端 `forbidNonWhitelisted`——不要透传 DTO 白名单外的字段（参考 `trigger_task` 无 executorId 的注释）。
3. 在 `src/__tests__/tools.test.ts` 用 mock `call` 补断言；若涉及新 REST 端点先看 [admin-api](../01-apps/admin-api/README.md)。
4. 更新本文档与 [MCP 工具地图](../05-interfaces/mcp-tools.md)。

## 相关文档

- [包生态总览](README.md) · [acf-cli（同源能力的终端入口）](acf-cli.md)
- [MCP 审批流（DEP-04）](../04-flows/approval-flow.md) · [审批工具语义](../05-interfaces/mcp-tools.md)
- [契约夹具](contract-fixtures.md)（api.test.ts 消费）
