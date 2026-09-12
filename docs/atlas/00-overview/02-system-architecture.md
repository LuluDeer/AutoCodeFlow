# 总体架构与数据流

> 所属: docs/atlas/00-overview · 最后核对: 2026-09-13 · 对应代码: docker-compose.yml、apps/*、packages/*

## 架构总图

```mermaid
flowchart LR
    subgraph 用户入口
        WEB[admin-web<br/>React 管理台]
        CLI[acf-cli]
        MCP[mcp-server<br/>AI Agent 用]
        SDKPY[autoflow-sdk]
        SDKNODE[autocodeflow-node-sdk]
    end

    subgraph 控制面
        API[admin-api<br/>NestJS :3105]
        DB[(PostgreSQL)]
        REDIS[(Redis/BullMQ)]
    end

    subgraph 执行面
        EN[executor-node :8002]
        EP[executor-python :8001]
        ED[executor-desktop<br/>Electron]
    end

    subgraph 支撑服务
        RNPM[registry-npm<br/>Verdaccio :4873]
        RPYP[registry-pypi<br/>FastAPI :8003]
        SMTP[邮件/企微/钉钉/Slack]
        AI[OpenAI / Ollama]
    end

    WEB --> API
    CLI --> API
    MCP --> API
    SDKPY & SDKNODE -.->|任务内使用| API

    API --> DB
    API --> REDIS
    EN & EP & ED -->|注册/心跳/领任务/回调| API
    EN & EP & ED -.->|装依赖| RNPM & RPYP
    API --> SMTP
    API -.-> AI
```

## 组件职责速览

| 组件 | 角色 | 关键端口 | 详细文档 |
|---|---|---|---|
| admin-api | 控制面唯一入口：REST API、调度、回调接收、通知 | 3105 | [../01-apps/admin-api/README.md](../01-apps/admin-api/README.md) |
| admin-web | 管理台 SPA | 经 nginx :80 | [../01-apps/admin-web/README.md](../01-apps/admin-web/README.md) |
| executor-node | Node.js 任务执行 | 8002 | [../01-apps/executor-node/README.md](../01-apps/executor-node/README.md) |
| executor-python | Python 任务执行 | 8001 | [../01-apps/executor-python/README.md](../01-apps/executor-python/README.md) |
| executor-desktop | Electron 桌面执行器（托盘常驻） | - | [../01-apps/executor-desktop/README.md](../01-apps/executor-desktop/README.md) |
| registry-npm / registry-pypi | 私有依赖仓库 | 4873 / 8003 | [../01-apps/registry-npm.md](../01-apps/registry-npm.md) |
| acf-cli / mcp-server / 双 SDK | 编程入口 | - | [../02-packages/README.md](../02-packages/README.md) |

## 核心数据流：一次任务执行

```mermaid
sequenceDiagram
    participant U as 用户/AI
    participant API as admin-api
    participant DB as PostgreSQL
    participant Q as Redis/BullMQ
    participant EX as Executor
    participant N as 通知渠道

    U->>API: 创建/编辑任务（脚本+Cron+策略）
    API->>DB: 持久化 Task
    API->>Q: 调度器按 Cron 入队
    EX->>API: 心跳 + 领取任务
    API-->>EX: 下发任务（Glue 脚本 + manifest + 上下文）
    EX->>EX: 安装依赖 → 执行脚本
    EX->>API: 回调状态/日志/产物（分片上报）
    API->>DB: 写 Execution / Artifacts
    API->>N: 失败/完成 → 发通知
    U->>API: 查询执行详情、下载产物、AI 分析
```

细化拆解见 [../04-flows/task-lifecycle.md](../04-flows/task-lifecycle.md)。

## 关键架构决策（速记）

| 决策 | 内容 | 出处 |
|---|---|---|
| 单体控制面 | 所有控制逻辑集中在 admin-api，执行器无状态化 | docs/adr/ |
| Pull 模型 | 执行器主动拉任务 + 回调上报，避免入站暴露 | 04-flows/executor-registration |
| 双写迁移策略 | development 用 synchronize，其他环境用 migrationsRun | README「数据库迁移」 |
| 多实例支持 | admin-api 多实例 + outbox/claim 模式（ARCH-31） | docs/ARCH-MULTI-INSTANCE-MATRIX.md |
| 各 app 独立安装依赖 | monorepo 不做 workspace hoisting（ARCH-20） | 根 package.json description |

> ⚠️ 待核实：ADR 目录内具体条目清单未逐一核对，引用前请先看 `docs/adr/`。

## 相关文档

- 领域概念: [05-core-concepts.md](05-core-concepts.md)
- 关键流程: [../04-flows/task-lifecycle.md](../04-flows/task-lifecycle.md)
- 部署拓扑: [../06-infra/docker-compose.md](../06-infra/docker-compose.md)
