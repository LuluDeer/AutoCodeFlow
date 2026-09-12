# 产品定位与能力地图

> 所属: docs/atlas/00-overview · 最后核对: 2026-09-13 · 对应代码: README.md、docs/quickstart.md

## 一句话定位

AutoCodeFlow 是一个**分布式任务调度与执行平台**：在管理后台里用 Cron 调度动态脚本任务（JavaScript / Python），把脚本下发给多个执行器运行，回收日志与产物，并提供监控、通知、审计与 AI 辅助能力。

## 能力地图

```
┌─ 调度与任务 ──────────────────────────────────────────────┐
│ 任务 CRUD / Cron 调度 / 手动触发 / 启停 / 任务模板          │
│ 重试策略 / 超时策略 / 任务依赖 / 失败链路追踪               │
└──────────────────────────────────────────────────────────┘
┌─ 执行侧 ──────────────────────────────────────────────────┐
│ Node.js / Python / Electron桌面 三种执行器                 │
│ 自动注册 + 心跳保活 + 并发控制                              │
│ Glue 脚本动态下发执行                                       │
└──────────────────────────────────────────────────────────┘
┌─ 支撑设施 ────────────────────────────────────────────────┐
│ 私有 npm(Verdaccio) / PyPI 仓库 → 任务可装内部依赖          │
│ 执行产物(Artifacts) 上传与下载                              │
│ 通知渠道: 企微 / 钉钉 / Slack Webhook / SMTP 邮件          │
│ Prometheus 指标 + 健康检查 + 审计日志                       │
└──────────────────────────────────────────────────────────┘
┌─ 生态入口 ────────────────────────────────────────────────┐
│ admin-web 管理台 / acf CLI / MCP Server(AI Agent)          │
│ Python SDK(autoflow-sdk) / Node SDK(@autocodeflow/sdk)     │
│ AI 辅助(OpenAI/Ollama): 脚本生成 + 失败分析                 │
└──────────────────────────────────────────────────────────┘
```

## 目标用户与典型场景

- **运维 / 自动化工程师**：把重复脚本变成有调度、有告警、有审计的正式任务。
- **开发团队**：通过"应用（Application）"分组隔离不同业务线的任务与执行器。
- **AI Agent**：通过 MCP Server 直接创建任务、触发执行、分析失败原因。

## 核心用户旅程

1. 管理员登录 admin-web → 创建应用 → 创建任务（选语言、写 Glue 脚本、配 Cron / 重试 / 超时）。
2. 执行器（预先注册）通过心跳领取任务 → 动态加载脚本与依赖（可从私有仓库安装）→ 执行。
3. 执行器回调 admin-api 上报状态 / 日志 / 产物。
4. 用户在管理台看执行详情、对比历史；失败时收通知，可用 AI 分析失败原因。

## 术语表

| 术语 | 含义 | 详见 |
|---|---|---|
| Task | 一次可调度的任务定义（脚本 + 调度 + 策略） | [05-core-concepts.md](05-core-concepts.md) |
| Execution | Task 的一次实际运行记录 | 同上 |
| Executor | 执行器实例（node/python/desktop），注册后领任务 | [02-system-architecture.md](02-system-architecture.md) |
| Application | 任务分组单元，权限与批量操作边界 | [05-core-concepts.md](05-core-concepts.md) |
| Glue 脚本 | 任务运行时动态下发的 JS/Python 胶水代码 | [04-flows/task-lifecycle.md](../04-flows/task-lifecycle.md) |
| Manifest | 脚本的依赖/入口声明，随任务下发 | [04-flows/task-lifecycle.md](../04-flows/task-lifecycle.md) |
| Artifact | 执行产物文件，执行器上传、管理台下载 | [04-flows/execution-callback.md](../04-flows/execution-callback.md) |
| Executor Package | 应用级安装包，由执行器下载安装 | [01-apps/admin-api/modules/executor-package.md](../01-apps/admin-api/modules/executor-package.md) |

## 相关文档

- 总体架构: [02-system-architecture.md](02-system-architecture.md)
- 仓库目录: [03-repo-layout.md](03-repo-layout.md)
