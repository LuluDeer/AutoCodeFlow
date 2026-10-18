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
| [**Documentation Hub**](docs/README.md) | **Start here** — every doc indexed by role |
| [Tutorials](docs/tutorials/index.md) | Five step-by-step tutorials in production order |
| [Architecture Decisions](docs/adr/README.md) | ADRs — read before changing architecture |
| [Support](SUPPORT.md) · [Security](SECURITY.md) | Where to ask, how to report a vulnerability |

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


---

📖 **[查看中文版](README.md#chinese) | View Chinese Version**
