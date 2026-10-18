# AutoCodeFlow

[![CI](https://github.com/LuluDeer/AutoCodeFlow/actions/workflows/ci.yml/badge.svg)](https://github.com/LuluDeer/AutoCodeFlow/actions/workflows/ci.yml)
[![Release](https://github.com/LuluDeer/AutoCodeFlow/actions/workflows/release.yml/badge.svg)](https://github.com/LuluDeer/AutoCodeFlow/actions/workflows/release.yml)
[![License: AGPL-3.0](https://img.shields.io/badge/License-AGPL%203.0-blue.svg)](LICENSE)
[![npm version](https://img.shields.io/npm/v/@autocodeflow/sdk.svg)](https://www.npmjs.com/package/@autocodeflow/sdk)
[![PyPI version](https://img.shields.io/pypi/v/autoflow-sdk.svg)](https://pypi.org/project/autoflow-sdk/)

[English](#english) | [中文](#chinese)

---

<a name="english"></a>

## 🚀 Overview

**AutoCodeFlow** is an enterprise-grade distributed task orchestration platform with built-in AI capabilities. Schedule, execute, and monitor JavaScript/Python tasks across multiple executors with real-time observability and intelligent failure analysis.

### ✨ Key Features

- **🎯 Smart Scheduling** — Cron expressions, fixed intervals, manual triggers, and dependency-based execution
- **🧩 Glue Scripts** — Write JavaScript/Python scripts in the browser, dynamically distributed to executors at runtime
- **⚡ Horizontal Scaling** — Auto-registering executors with health checks and load balancing
- **🖥️ Desktop Executor** — Electron-based executor runs as a system tray app on any device
- **📦 Private Registries** — Built-in npm (Verdaccio) and PyPI repositories for internal packages
- **🤖 AI-Powered** — OpenAI/Ollama integration for script generation and failure root-cause analysis
- **🔗 MCP Integration** — Model Context Protocol server for AI agent task management
- **📊 Full Observability** — Prometheus metrics, distributed tracing (OpenTelemetry), real-time logs
- **🔔 Multi-Channel Alerts** — WeCom, DingTalk, Slack webhooks, SMTP email
- **🛡️ Enterprise Security** — RBAC, API keys with scoped permissions, audit logs
- **🌐 Bilingual UI** — Chinese/English interface with i18n support

---

## 🏗️ Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        Control Plane                            │
│  ┌──────────────────┐          ┌─────────────────────┐         │
│  │   Admin Web UI   │ ◄──────► │   Admin API         │         │
│  │  (React + Vite)  │          │ (NestJS + TypeORM)  │         │
│  └──────────────────┘          └──────────┬──────────┘         │
│                                            │                     │
│         ┌──────────────────────────────────┼──────────────┐    │
│         │                                   │              │    │
│         ▼                                   ▼              ▼    │
│  ┌─────────────┐                  ┌─────────────┐  ┌──────────┐│
│  │ PostgreSQL  │                  │   Redis     │  │ BullMQ   ││
│  │  (Metadata) │                  │  (Cache)    │  │ (Queue)  ││
│  └─────────────┘                  └─────────────┘  └──────────┘│
└─────────────────────────────────────────────────────────────────┘
                                     │
                   ┌─────────────────┼─────────────────┐
                   │                 │                 │
                   ▼                 ▼                 ▼
          ┌─────────────┐   ┌─────────────┐   ┌─────────────┐
          │  Executor   │   │  Executor   │   │  Executor   │
          │   (Node)    │   │  (Python)   │   │  (Desktop)  │
          └─────────────┘   └─────────────┘   └─────────────┘
                   │                 │                 │
                   └─────────────────┼─────────────────┘
                                     │
                            ┌────────┴────────┐
                            │                 │
                     ┌──────▼──────┐   ┌──────▼──────┐
                     │ npm Registry│   │PyPI Registry│
                     │ (Verdaccio) │   │  (Private)  │
                     └─────────────┘   └─────────────┘
```

---

## 📦 Tech Stack

| Component | Technology |
|-----------|-----------|
| **Control Plane** | NestJS · TypeORM · PostgreSQL · Redis · BullMQ |
| **Web UI** | React 18 · Vite · Ant Design · TypeScript |
| **Executors** | Node.js (Express) · Python (FastAPI) · Electron |
| **Registries** | Verdaccio (npm) · Custom PyPI Server |
| **CLI** | TypeScript · Commander.js (`acf` command) |
| **SDKs** | `@autocodeflow/sdk` (Node) · `autoflow-sdk` (Python) |
| **MCP Server** | TypeScript · MCP SDK (AI agent integration) |
| **Deployment** | Docker Compose · Source Mode for production |

---

## 🚀 Quick Start

### Prerequisites

- **Docker** ≥ 24 & **Docker Compose** ≥ 2.20
- **(Local dev)** Node.js ≥ 20, Python ≥ 3.11

### One-Command Deployment

The `deploy.sh` script supports **dual-mode deployment**:

```bash
# Production (source mode, requires root, recommended)
sudo ./deploy.sh --mode source --env production --i-know-its-production

# Staging (Docker mode)
./deploy.sh --mode docker --env staging

# Pre-deployment health check
./deploy.sh doctor
```

**8-stage pipeline**: Pre-check → Config → Dependencies → Build → Infrastructure → Migration (with auto-backup) → Startup → Validation

See [Deployment Guide](docs/deployment.md) for details.

### Manual Docker Compose

```bash
# 1. Clone repository
git clone https://github.com/LuluDeer/AutoCodeFlow.git
cd AutoCodeFlow

# 2. Configure environment
cp .env.example .env
# Edit .env: set POSTGRES_PASSWORD, JWT_SECRET, JWT_REFRESH_SECRET, EXECUTOR_SECRET
vim .env

# 3. Start all services
docker compose up -d

# 4. Check status
docker compose ps
docker compose logs -f admin-api
```

**Access Points:**

| Service | URL |
|---------|-----|
| Admin Dashboard | http://localhost |
| API Documentation | http://localhost:3105/api/docs |
| Health Check | http://localhost:3105/api/health/live |
| Prometheus Metrics | http://localhost:3105/metrics |
| npm Registry | http://localhost/npm/ |
| PyPI Registry | http://localhost/pypi/ |

Default admin credentials are set via `INITIAL_ADMIN_PASSWORD` in `.env`.

---

## 📚 Documentation

| Document | Description |
|----------|-------------|
| [Quick Start](docs/quickstart.md) | Get running in 5 minutes |
| [Deployment Guide](docs/deployment.md) | System requirements, environment variables, upgrade guide |
| [Operations Manual](docs/operations.md) | Daily operations, backup/restore, scaling, troubleshooting |
| [Development Guide](docs/development.md) | Local setup, testing, code conventions |
| [SDK Guide](docs/sdk-guide.md) | Python/Node.js SDK usage and examples |
| [API Reference](docs/api-reference.md) | REST API endpoints, authentication, error codes |
| [Knowledge Atlas](docs/atlas/README.md) | Comprehensive architecture documentation |

---

## 🛠️ CLI Tool

```bash
# Install globally
npm install -g @autocodeflow/cli

# Login
acf login --url http://localhost:3105 --user admin

# Manage tasks
acf task list
acf task trigger <taskId>

# Manage executors
acf executor list

# Manage applications
acf app list
```

---

## 🤖 AI Integration

### MCP Server

Integrate with Claude Desktop, Cursor, and other AI agents:

```json
{
  "mcpServers": {
    "autocodeflow": {
      "command": "npx",
      "args": ["-y", "autocodeflow-mcp-server"],
      "env": {
        "ACF_API_URL": "http://localhost:3105",
        "ACF_TOKEN": "your-jwt-token"
      }
    }
  }
}
```

See [packages/mcp-server/README.md](packages/mcp-server/README.md) for details.

---

## 🔒 Security

- **RBAC** — Project-level roles (owner/developer/viewer)
- **API Keys** — Scoped tokens for CI/CD integration
- **Sandbox Execution** — Python tasks run in bubblewrap containers (Linux)
- **Audit Logs** — Complete operation history
- **Secret Management** — Encrypted storage for sensitive data

---

## 📈 Monitoring

- **Prometheus Metrics** — Task execution rates, durations, failure rates
- **Distributed Tracing** — OpenTelemetry integration
- **Real-time Logs** — WebSocket streaming
- **Alertmanager** — Rule-based alerts with HMAC webhook security

---

## 🌟 Use Cases

- **Data Pipelines** — ETL jobs, data synchronization
- **Scheduled Reports** — Daily/weekly report generation
- **System Maintenance** — Database backups, log rotation
- **API Polling** — Third-party service integration
- **Desktop Automation** — RPA-style UI automation (see [examples/desktop-automation](examples/desktop-automation))

---

## 🤝 Contributing

1. Fork the repository
2. Create a feature branch: `git checkout -b feat/your-feature`
3. Commit your changes (follow [Conventional Commits](https://www.conventionalcommits.org/))
4. Run tests: `npm run test`
5. Submit a Pull Request

---

## 📄 License

AutoCodeFlow uses **component-based licensing** (since v1.4.0):

| Component | License |
|-----------|---------|
| **Platform Core** (apps/* + docs-site) | [AGPL-3.0-only](LICENSE) |
| **Client SDKs & Tools** (CLI, SDKs, MCP server) | MIT |
| **Executor Protocol** (for third-party integrations) | MIT |

Versions ≤ v1.3.0 remain under MIT.

---

## 🙏 Acknowledgments

Built with ❤️ using:
- [NestJS](https://nestjs.com/) - Progressive Node.js framework
- [React](https://react.dev/) - UI library
- [Ant Design](https://ant.design/) - Component library
- [TypeORM](https://typeorm.io/) - ORM for TypeScript
- [BullMQ](https://docs.bullmq.io/) - Queue system
- [Electron](https://www.electronjs.org/) - Desktop framework

---

<a name="chinese"></a>

# AutoCodeFlow

[English](#english) | [中文](#chinese)

---

## 🚀 产品概述

**AutoCodeFlow** 是企业级分布式任务编排平台，内置 AI 能力。跨多执行器调度、执行和监控 JavaScript/Python 任务，提供实时可观测性和智能故障分析。

### ✨ 核心功能

- **🎯 智能调度** — Cron 表达式、固定频率、手动触发、依赖触发
- **🧩 Glue 脚本** — 浏览器内编写 JavaScript/Python 脚本，运行时动态分发到执行器
- **⚡ 横向扩展** — 执行器自动注册、健康检查、负载均衡
- **🖥️ 桌面执行器** — 基于 Electron 的系统托盘应用，可在任意设备运行
- **📦 私有仓库** — 内置 npm (Verdaccio) 和 PyPI 私有仓库，支持内部包依赖
- **🤖 AI 赋能** — OpenAI/Ollama 集成，辅助脚本生成和故障根因分析
- **🔗 MCP 集成** — Model Context Protocol 服务器，AI Agent 可直接管理任务
- **📊 全链路可观测** — Prometheus 指标、分布式追踪 (OpenTelemetry)、实时日志
- **🔔 多渠道告警** — 企业微信、钉钉、Slack Webhook、SMTP 邮件
- **🛡️ 企业安全** — RBAC 权限、作用域 API Key、审计日志
- **🌐 双语界面** — 中英文界面切换，完整 i18n 支持

---

## 🏗️ 系统架构

```
┌─────────────────────────────────────────────────────────────────┐
│                          控制面                                  │
│  ┌──────────────────┐          ┌─────────────────────┐         │
│  │   管理后台 UI    │ ◄──────► │   管理后台 API      │         │
│  │  (React + Vite)  │          │ (NestJS + TypeORM)  │         │
│  └──────────────────┘          └──────────┬──────────┘         │
│                                            │                     │
│         ┌──────────────────────────────────┼──────────────┐    │
│         │                                   │              │    │
│         ▼                                   ▼              ▼    │
│  ┌─────────────┐                  ┌─────────────┐  ┌──────────┐│
│  │ PostgreSQL  │                  │   Redis     │  │ BullMQ   ││
│  │  (元数据)   │                  │  (缓存)     │  │ (队列)   ││
│  └─────────────┘                  └─────────────┘  └──────────┘│
└─────────────────────────────────────────────────────────────────┘
                                     │
                   ┌─────────────────┼─────────────────┐
                   │                 │                 │
                   ▼                 ▼                 ▼
          ┌─────────────┐   ┌─────────────┐   ┌─────────────┐
          │   执行器    │   │   执行器    │   │   执行器    │
          │   (Node)    │   │  (Python)   │   │  (桌面端)   │
          └─────────────┘   └─────────────┘   └─────────────┘
                   │                 │                 │
                   └─────────────────┼─────────────────┘
                                     │
                            ┌────────┴────────┐
                            │                 │
                     ┌──────▼──────┐   ┌──────▼──────┐
                     │ npm 私有仓库│   │PyPI 私有仓库│
                     │ (Verdaccio) │   │  (自建)     │
                     └─────────────┘   └─────────────┘
```

---

## 📦 技术栈

| 组件 | 技术 |
|-----|------|
| **控制面** | NestJS · TypeORM · PostgreSQL · Redis · BullMQ |
| **管理界面** | React 18 · Vite · Ant Design · TypeScript |
| **执行器** | Node.js (Express) · Python (FastAPI) · Electron |
| **私有仓库** | Verdaccio (npm) · 自建 PyPI 服务 |
| **CLI 工具** | TypeScript · Commander.js (`acf` 命令) |
| **SDK** | `@autocodeflow/sdk` (Node) · `autoflow-sdk` (Python) |
| **MCP Server** | TypeScript · MCP SDK (AI Agent 集成) |
| **部署** | Docker Compose · 生产推荐源码模式 |

---

## 🚀 快速开始

### 前置条件

- **Docker** ≥ 24 & **Docker Compose** ≥ 2.20
- **(本地开发)** Node.js ≥ 20，Python ≥ 3.11

### 一键部署

`deploy.sh` 脚本支持**双模部署**：

```bash
# 生产环境（源码模式，需 root，推荐）
sudo ./deploy.sh --mode source --env production --i-know-its-production

# 测试环境（Docker 模式）
./deploy.sh --mode docker --env staging

# 部署前环境体检
./deploy.sh doctor
```

**8 阶段流水线**：预检 → 配置 → 依赖 → 构建 → 基础设施 → 迁移（自动备份）→ 启动 → 验证

详见 [部署指南](docs/deployment.md)。

### 手动 Docker Compose

```bash
# 1. 克隆仓库
git clone https://github.com/LuluDeer/AutoCodeFlow.git
cd AutoCodeFlow

# 2. 配置环境变量
cp .env.example .env
# 编辑 .env：设置 POSTGRES_PASSWORD、JWT_SECRET、JWT_REFRESH_SECRET、EXECUTOR_SECRET
vim .env

# 3. 启动所有服务
docker compose up -d

# 4. 查看状态
docker compose ps
docker compose logs -f admin-api
```

**服务访问地址：**

| 服务 | URL |
|-----|-----|
| 管理后台 | http://localhost |
| API 文档 | http://localhost:3105/api/docs |
| 健康检查 | http://localhost:3105/api/health/live |
| Prometheus 指标 | http://localhost:3105/metrics |
| npm 私有仓库 | http://localhost/npm/ |
| PyPI 私有仓库 | http://localhost/pypi/ |

默认管理员凭据通过 `.env` 中的 `INITIAL_ADMIN_PASSWORD` 设置。

---

## 📚 文档

| 文档 | 说明 |
|-----|------|
| [快速上手](docs/quickstart.md) | 5 分钟快速入门 |
| [部署指南](docs/deployment.md) | 系统要求、环境变量、升级指南 |
| [运维手册](docs/operations.md) | 日常运维、备份恢复、扩容、故障排查 |
| [开发指南](docs/development.md) | 本地开发、测试、代码规范 |
| [SDK 使用指南](docs/sdk-guide.md) | Python/Node.js SDK 使用示例 |
| [API 参考](docs/api-reference.md) | REST API 接口、认证、错误码 |
| [知识图谱](docs/atlas/README.md) | 完整架构文档 |

---

## 🛠️ CLI 工具

```bash
# 全局安装
npm install -g @autocodeflow/cli

# 登录
acf login --url http://localhost:3105 --user admin

# 管理任务
acf task list
acf task trigger <taskId>

# 管理执行器
acf executor list

# 管理应用
acf app list
```

---

## 🤖 AI 集成

### MCP Server

与 Claude Desktop、Cursor 等 AI Agent 集成：

```json
{
  "mcpServers": {
    "autocodeflow": {
      "command": "npx",
      "args": ["-y", "autocodeflow-mcp-server"],
      "env": {
        "ACF_API_URL": "http://localhost:3105",
        "ACF_TOKEN": "your-jwt-token"
      }
    }
  }
}
```

详见 [packages/mcp-server/README.md](packages/mcp-server/README.md)。

---

## 🔒 安全特性

- **RBAC** — 项目级角色（owner/developer/viewer）
- **API Keys** — 作用域 Token，支持 CI/CD 集成
- **沙箱执行** — Python 任务在 bubblewrap 容器中运行（Linux）
- **审计日志** — 完整操作历史记录
- **密钥管理** — 敏感数据加密存储

---

## 📈 监控告警

- **Prometheus 指标** — 任务执行速率、耗时、失败率
- **分布式追踪** — OpenTelemetry 集成
- **实时日志** — WebSocket 流式传输
- **Alertmanager** — 基于规则的告警，HMAC Webhook 安全校验

---

## 🌟 应用场景

- **数据管道** — ETL 作业、数据同步
- **定时报表** — 日报、周报自动生成
- **系统维护** — 数据库备份、日志轮转
- **API 轮询** — 第三方服务集成
- **桌面自动化** — RPA 风格的 UI 自动化（参见 [examples/desktop-automation](examples/desktop-automation)）

---

## 🤝 贡献指南

1. Fork 本仓库
2. 创建功能分支：`git checkout -b feat/your-feature`
3. 提交代码（遵循 [Conventional Commits](https://www.conventionalcommits.org/) 规范）
4. 运行测试：`npm run test`
5. 提交 Pull Request

---

## 📄 开源协议

AutoCodeFlow 采用**分组件许可**（自 v1.4.0 起）：

| 组件 | 许可证 |
|-----|--------|
| **平台核心**（apps/* + docs-site）| [AGPL-3.0-only](LICENSE) |
| **客户端 SDK 与工具**（CLI、SDK、MCP server）| MIT |
| **执行器协议**（三方执行器集成）| MIT |

v1.3.0 及更早版本继续按 MIT 供用。

---

## 🙏 致谢

基于以下优秀开源项目构建：
- [NestJS](https://nestjs.com/) - 渐进式 Node.js 框架
- [React](https://react.dev/) - UI 库
- [Ant Design](https://ant.design/) - 组件库
- [TypeORM](https://typeorm.io/) - TypeScript ORM
- [BullMQ](https://docs.bullmq.io/) - 队列系统
- [Electron](https://www.electronjs.org/) - 桌面应用框架

---

**© 2026 LuluDeer**
