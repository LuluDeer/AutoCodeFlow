<a name="chinese"></a>

# AutoCodeFlow

<p align="center">
  <img src="docs/assets/banner-zh.png" alt="AutoCodeFlow — 开源的自动化执行运行时" width="100%">
</p>

<p align="center">
  <b>开源的自动化执行运行时</b><br/>
  <sub>The open-source automation runtime for scripts, desktops and AI agents</sub>
</p>

<p align="center">
  定时跑脚本 · 让 Agent 操作真实桌面 · 每一次运行可观测、可审计
</p>

## 🧭 这是什么

AutoCodeFlow 是一个**自托管的自动化执行运行时**，把「散落在各台机器上的定时脚本、桌面操作和 AI Agent」收进同一张调度台：

- **定时脚本** — Cron / 固定频率 / Webhook / DAG，JS / Python / Shell；日志、重试、超时、并发闸、告警。
- **桌面自动化** — Windows / Linux 桌面执行器，GUI + 浏览器操作；适合没有 API 的内网系统与员工 PC。
- **Agent 执行面** — MCP Server 让 Claude / Cursor 直接创建、触发、排查任务；SOP 把「目标 + 验收」交给真实机器上的 Agent 执行，并留下证据。
- **跑在你的网里** — 执行器主动拉取任务（Pull），不需要对公网暴露入站端口；私有 npm / PyPI 依赖也能装。

> 稳定的交给脚本，长尾的交给 Agent，所有动作可审计。

## ⚡ 一条命令跑起来

```bash
git clone https://github.com/LuluDeer/AutoCodeFlow.git
cd AutoCodeFlow
./scripts/demo.sh
```

脚本会生成随机口令、起一套**隔离的**本地栈（不碰你的 `.env`），seed 3 个 demo 任务 + 3 条 SOP，触发一次并等到 `SUCCESS`，最后打印 UI 地址与管理员口令。首次运行需要构建镜像（约 3–8 分钟，视网络），之后启动约 30 秒：

- UI：**http://localhost:8088**
- API 文档：http://127.0.0.1:3105/api/docs
- 停止：`./scripts/demo.sh --down`；重置：`./scripts/demo.sh --reset`

![demo dashboard](docs/assets/screenshots/zh/demo-dashboard.png)

从模板创建 → 触发 → 产物（无需写代码）：

![template run](docs/assets/screenshots/zh/demo-template-run.png)

## 🖥️ 桌面 Agent 演示（Linux X11）

```bash
./scripts/demo-desktop-agent.sh   # 无需 Docker / LLM / API key
```

它跑通 **SOP → plan → GUI 动作 → 沙箱试跑 → acceptance → delivered**：控制流、闸门、`X11GuiDriver`、workspace 沙箱与验收都是生产代码。默认用脚本化 plan（无需 key）；设置 `ACF_LLM_API_KEY` / `ACF_LLM_BASE_URL` / `ACF_LLM_MODEL` 可换真实 OpenAI-compatible provider（已用 `deepseek-v4.1-flash-1017` 跑通）。只想过一遍 GUI 驱动可用 `./scripts/demo-desktop-gui.sh`。

无 Electron 的 **headless 执行器**：`./scripts/demo-headless-agent.mjs` 会注册一个执行器、把真实 SOP 指派给它，走 `AgentHost` → 中台 LLM relay → 沙箱试跑 → 验收 → `completed`（需先配好 AI provider）。

多模态：`/agent-collab/llm` 已支持 `text + image_url`。执行器默认把 GUI 截图作为 **inline `data:image/png;base64`** 附到下一轮（实测 provider 可直接识别真实截图，无需公网媒体 host）；超大图（>1.5MB）才回落到 `ACF_MEDIA_BASE_URL`。

截图诊断闭环：`./scripts/demo-desktop-agent-diagnose.sh` 先故意输入 `wrong-token`，真实模型看截图后清空并改成正确 token，最终 `delivered`（需 `ACF_LLM_*`）。

中台 ops Agent：`node scripts/demo-ops-agent.mjs`——真实模型在 `ops_watch` 会话里调 `get_execution_stats`/`list_executions`/`get_execution_logs`，对 demo 任务给出可读结论（需 AI provider）。

![desktop agent demo](docs/assets/screenshots/zh/desktop-agent-sop.png)

## 🎯 三种用法

| 你想做的事 | 用什么 | 从哪里开始 |
|---|---|---|
| 把散落的 crontab 收成可观测的任务 | 定时脚本 + 执行器 | 任务 → 新建（或任务模板） |
| 操作没有 API 的内网/桌面系统 | 桌面执行器 + GUI/浏览器 | 执行器 → 安装向导 |
| 让 AI Agent 真正“动手” | MCP Server + SOP | `acf` CLI / MCP / SOP 页面 |

## 🆚 为什么不是……

| 方案 | 它擅长 | 它不覆盖 |
|---|---|---|
| crontab / systemd timer | 单机定时 | 多机、日志、重试、审计、桌面 |
| XXL-JOB / Kestra | 服务端脚本编排 | 桌面 GUI、浏览器、AI Agent |
| n8n / Dify | SaaS / API 工作流 | 自托管执行器、桌面、私服依赖 |
| UiPath / 影刀 | 商业 RPA | 开源、自托管、代码优先、脚本调度 |
| **AutoCodeFlow** | 脚本 + 桌面 + Agent 同一张调度台 | 不是大数据引擎，也不是托管 SaaS |

## 🧑‍💻 适合谁 / 不适合谁

**适合**：能自己跑 Docker、有内网机器或员工桌面、需要日志/审计/自托管的开发者与运维。
**不适合**：想要开箱即用的托管 SaaS、需要 Spark/Flink 级数据编排、完全不想碰命令行的团队。

> 桌面 GUI 能力现状：Linux X11/XWayland 已真机验收；Windows GUI 为 beta（focus/click/type/screenshot + 应用白名单）；macOS 仅侦察。详见 [执行器 Agent 路线图](docs/design/agent-and-deployment/06-roadmap.md)。

> **Status**：early-stage / self-hosted first。2.0 之前 API 仍可能变化，生产使用请钉 release tag。

## 🖼️ 界面一览

### 中台（admin-web）

**控制台** — 任务总量、成功率、执行趋势、调度延迟与执行器资源。

![控制台](docs/assets/screenshots/zh/dashboard.png)

**任务调度** — Cron / 固定频率 / 手动任务，状态、下次执行与运行时一目了然。

![任务调度](docs/assets/screenshots/zh/tasks.png)

**执行记录** — 全量执行历史，可按状态、执行器与时间窗口过滤。

![执行记录](docs/assets/screenshots/zh/executions.png)

**执行详情** — 执行日志、时间线、重试链、参数与产物。

![执行详情](docs/assets/screenshots/zh/execution-detail.png)

**执行器** — 在线状态、CPU / 内存 / 磁盘、心跳与任务并发。

![执行器](docs/assets/screenshots/zh/executors.png)

**执行器详情** — 资源趋势、成功率、解释器池与令牌轮换。

![执行器详情](docs/assets/screenshots/zh/executor-detail.png)

**任务详情** — Glue 脚本、依赖 DAG、执行记录、版本历史与回滚。

![任务详情](docs/assets/screenshots/zh/task-detail.png)

**应用管理** — 应用版本、部署状态、批量升级与灰度。

![应用管理](docs/assets/screenshots/zh/applications.png)

### 执行器（executor-desktop）

Electron 桌面执行器：装在任何一台机器上，常驻系统托盘，自动注册上线并接收调度任务。

**连接向导** — 5 步完成连接、本机信息、下载源与确认。

![桌面执行器连接向导](docs/assets/screenshots/zh/executor-desktop/wizard.png)

**状态监控** — 在线状态、心跳、实时运行日志与最近失败。

![桌面执行器状态监控](docs/assets/screenshots/zh/executor-desktop/status-live.png)

**执行历史** — 按任务分组的运行记录，失败原因直接可见。

![桌面执行器执行历史](docs/assets/screenshots/zh/executor-desktop/history.png)

**本地应用** — 已部署应用、多版本并存、卸载与版本回退。

![桌面执行器本地应用](docs/assets/screenshots/zh/executor-desktop/apps-detail.png)

> 英文界面截图见 [English](#english) 章节（`docs/assets/screenshots/en/`）。

## 🏗️ 系统架构

<p align="center">
  <img src="docs/assets/architecture-zh.png" alt="AutoCodeFlow 系统架构图" width="100%">
</p>

**控制面**（admin-api + admin-web + PostgreSQL + Redis）持有全部调度决策、状态与审计；
**执行面**（executor-node / executor-python / executor-desktop）无状态，主动注册、心跳、领任务、回调。

```
浏览器 / CLI / MCP / SDK
        │  REST + SSE
        ▼
┌──────────────────────────────────────────────┐
│ admin-api (NestJS, :3105)                    │
│  · 调度器：Cron / fixed-rate / DAG / 手动     │
│  · 回调接收 → 执行记录 / 日志分片 / 产物       │
│  · RBAC / API Key / 审计 / 通知分发           │
└───────┬──────────────────┬───────────────────┘
        │                  │
   PostgreSQL 16       Redis 7 + BullMQ
   （元数据/审计）      （队列/缓存/多实例协调）
        ▲
        │ 注册 / 心跳 / 领任务 / 回调（Pull）
        │
┌───────┴────────────┬───────────────────┬──────────────────┐
│ executor-node      │ executor-python   │ executor-desktop │
│ JS / Shell 任务    │ Python 任务       │ 桌面 / 本地自动化 │
│ :8002              │ :8001 · uv 多版本 │ Electron 托盘常驻 │
└────────────────────┴───────────────────┴──────────────────┘
        │ 按需拉取依赖
        ▼
 私有仓库：npm (Verdaccio) · PyPI
```

一次任务执行的完整链路：**创建任务 → 调度入队 → 执行器领取 → 拉取脚本/依赖 → 执行 → 回调状态/日志/产物 → 通知与 AI 分析**。
细化到每个模块的拆解见 [架构图谱（Atlas）](docs/atlas/README.md) 与 [ADR](docs/adr/README.md)。

## ✨ 核心能力

| 能力 | 说明 |
|---|---|
| **调度** | Cron（5 段表达式 + 时区）、固定频率、手动触发、Webhook 入站、任务依赖 DAG、维护窗口 |
| **执行策略** | 超时与超时预警、最大重试与可重试错误白名单、并发闸/互斥组、阻塞策略、misfire 策略、执行器亲和/反亲和标签 |
| **多执行器** | Node.js / Python / Electron 桌面三类执行器；自动注册、心跳保活、负载感知分发、多实例一致性（outbox + claim） |
| **脚本形态** | 内置 Glue 脚本（在线编辑、语法检查、AI 生成）、Git 仓库、应用 zip 包；私有 npm/PyPI 依赖安装 |
| **可观测** | SSE 实时日志、执行趋势与成功率、调度延迟、Prometheus 指标、OpenTelemetry 追踪、Loki 日志聚合 |
| **告警通知** | 企业微信、钉钉、Slack Webhook、SMTP 邮件；规则、静默期、HMAC 签名校验 |
| **安全** | RBAC（项目级角色）、作用域 API Key、TOTP 双因子、OIDC SSO、审计日志、部署第二人审批、Python 任务可选 bubblewrap 沙箱（secure overlay） |
| **AI** | OpenAI / Ollama / Qwen：脚本生成、失败根因分析、调度建议、应用健康分析；MCP Server 让 Agent 直接管理任务 |
| **交付** | `acf` CLI（67 个子命令）、Node/Python 双 SDK、MCP Server（56 个工具）、VitePress 文档站 |

## 🚀 快速开始

> 想先看效果？`./scripts/demo.sh` 会在隔离端口起一套带 seed 的本地栈（不碰 `.env`），约 1–3 分钟；下面是自定义配置的路径。

### 方式一：Docker Compose（推荐试跑）

```bash
git clone https://github.com/LuluDeer/AutoCodeFlow.git
cd AutoCodeFlow

cp .env.example .env
# 必改：INITIAL_ADMIN_PASSWORD（>= 8 位，弱口令会被启动校验拒绝）
#      POSTGRES_PASSWORD / JWT_SECRET / JWT_REFRESH_SECRET / EXECUTOR_SECRET
vim .env

docker compose up -d
docker compose ps          # 全部 healthy 即启动完成
```

打开 **http://localhost**，用 `.env` 中的管理员账号登录。首次登录后请立即修改密码。

### 方式二：一键部署脚本（生产）

`deploy.sh` 支持**源码模式**与 **Docker 模式**，8 阶段流水线：
预检 → 配置 → 依赖 → 构建 → 基础设施 → 迁移（自动备份）→ 启动 → 验证。

```bash
sudo ./deploy.sh --mode source --env production --i-know-its-production   # 生产源码部署
./deploy.sh --mode docker --env staging --build                          # 试跑环境
./deploy.sh doctor                                                       # 部署前体检
./deploy.sh doctor --json                                                # 结构化体检（Agent 可用）
```

### 方式三：本地开发

```bash
make infra-up                                  # 仅启动 PostgreSQL + Redis
make install                                   # 安装全部依赖
cd apps/admin-api && npm run migration:run && cd ../..
make dev                                       # admin-api + admin-web + 两个执行器
```

### 造一套演示数据

```bash
make demo-seed    # 注入 demo- 前缀的任务、执行记录与 SOP（需 admin-api 已启动）
```

### 访问地址

| 服务 | 地址 | 说明 |
|---|---|---|
| 管理后台 | http://localhost | admin-web（生产由 nginx 托管） |
| API 文档 | http://localhost:3105/api/docs | Swagger / OpenAPI |
| 健康检查 | http://localhost:3105/api/health/live · `/api/health/ready` | 存活 / 就绪 |
| Prometheus 指标 | http://localhost:3105/api/metrics | 需 JWT；可用 `METRICS_PROMETHEUS_ENABLED=false` 关闭 |
| npm 私有仓库 | http://localhost/npm/ | Verdaccio |
| PyPI 私有仓库 | http://localhost/pypi/ | 自建 FastAPI 私服 |
| 执行器 | :8001（python）· :8002（node） | 默认仅绑定 127.0.0.1 |

> 监控栈为可选 profile：`docker compose --profile monitoring up -d`
> （Prometheus :9090 · Grafana :3000 · Alertmanager :9093 · Loki :3100）；追踪 `--profile jaeger`（Jaeger UI :16686）；
> 备份 `--profile backup`；对象存储 `--profile minio`；数据库副本 `--profile replica`。

## 🛠️ 客户端与集成

### CLI（`acf`）

```bash
npm install -g @autocodeflow/cli

acf login --url http://localhost:3105 --user admin        # 交互式登录（支持 TOTP）
acf task list                                             # 任务列表
acf task trigger <taskId> --wait                          # 触发并等待终态（失败退出码 1）
acf task logs <execId> --tail 200                         # 拉取执行日志
acf executor list                                         # 执行器列表
acf app deploy <appId> --executor <id>                    # 部署应用到执行器
```

CI 场景推荐用环境变量注入凭证（不落盘）：`ACF_API_URL` / `ACF_TOKEN`。

**API Key 也能直接给 `acf` 用**——同一套 `Bearer` 通道，无需先登录：

```bash
ACF_API_URL=http://localhost:3105 ACF_TOKEN=acf_... acf task list
```

scope 决定能跑哪些子命令（`readonly` 只读 / `trigger` +单任务触发 / `manage` +其余写面）。两条边界：`/api-keys`、`auth`、`users`、`config` 是 **JWT-only 面**，所以 `acf login` / `acf apikey …` 用 API Key 会 401；且纯 API Key 没有 refresh token，401 时 CLI 会清掉**本地已保存**的登录态（env 注入的 `ACF_TOKEN` 不受影响）。

完整命令地图见 [CLI 命令地图](docs/atlas/05-interfaces/cli.md)。

### SDK

```bash
npm install @autocodeflow/sdk     # Node.js
pip install autoflow-sdk          # Python
```

在 **SDK 任务**里显式引入 `ctx`（Glue 脚本走系统运行时、不安装 requirements；需要 SDK 时用应用包或依赖渠道）：

```js
// Node.js —— 需在任务依赖里声明 @autocodeflow/sdk
const { TaskContext } = require('@autocodeflow/sdk');
const ctx = TaskContext.fromEnv();
async function main() {
  const res = await ctx.http.get('/api/tasks?pageSize=5');
  ctx.logger.info('tasks fetched', { meta: { count: res.list.length } });
  return ctx.success('done', { count: res.list.length });
}
main().catch((err) => { ctx.logger.error(err.message); process.exitCode = 1; });
```

```python
# Python —— 需安装 autoflow-sdk
from autoflow_sdk import TaskContext
ctx = TaskContext.from_env()
rows = load_rows()                      # 你的业务代码
ctx.log.info("rows=%d", len(rows))
ctx.report_success(summary="etl done", duration_ms=412)
```

能力对照与差异裁定见 [SDK 指南](docs/sdk-guide.md)，可运行示例见 [examples/](examples/README.md)。

### MCP Server（AI Agent 集成）

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

`AUTOCODEFLOW_API_TOKEN` **既接受 API Key，也接受用户 JWT**：

- **API Key（常驻 MCP 推荐）**——中台「系统 → 系统设置 → API Keys → 新建」，选 `readonly` / `trigger` / `manage`，弹窗里的 `acf_…` 明文**只显示一次**（服务端只存哈希）。可设有效期或永不过期，吊销下一次调用即生效。它是 JWT 的真子集，但 MCP 的 56 个工具都不碰凭证/用户/系统配置端点，所以够用。
- **用户 JWT（只有它能用 ADMIN-only 工具）**——中台前端没有「复制我的 token」入口，用 `acf login` 后从 `~/.config/acf-cli/config.json` 取 `token`（15 分钟）；再配 `AUTOCODEFLOW_API_REFRESH_TOKEN`（同文件的 `refreshToken`，30 天）才能在 401 时自动续期，否则每 15 分钟要重启进程换新 token。

56 个工具覆盖任务、执行、执行器、应用部署、SOP、审计与审批；权限由 **API Key scope 或 JWT 角色**在服务端强制。
详见 [packages/mcp-server/README.md](packages/mcp-server/README.md) 与 [MCP 工具地图](docs/atlas/05-interfaces/mcp-tools.md)。

## 📦 技术栈

| 层 | 技术 |
|---|---|
| **控制面** | NestJS · TypeORM · PostgreSQL 16 · Redis 7 · BullMQ |
| **管理台** | React 19 · Vite · Ant Design · TypeScript · Recharts |
| **执行器** | Node.js 24（Express）· Python 3.12（FastAPI）· Electron |
| **私有仓库** | Verdaccio（npm）· 自建 FastAPI（PyPI） |
| **CLI / SDK / MCP** | Commander.js · axios / httpx · MCP SDK |
| **可观测** | Prometheus · Grafana · Loki · OpenTelemetry · Alertmanager |
| **部署** | Docker Compose · 源码模式（systemd + nginx）· 多实例 HA |

## 🗂️ 仓库结构

```
AutoCodeFlow/
├── apps/
│   ├── admin-api/         控制面后端（REST + SSE + 调度 + 审计）
│   ├── admin-web/         管理台 SPA
│   ├── executor-node/     Node.js 执行器（:8002）
│   ├── executor-python/   Python 执行器（:8001，uv 多版本）
│   ├── executor-desktop/  Electron 桌面执行器（托盘常驻）
│   ├── registry-npm/      私有 npm 仓库（Verdaccio 配置）
│   └── registry-pypi/     私有 PyPI 仓库（FastAPI）
├── packages/
│   ├── acf-cli/           acf 命令行工具
│   ├── mcp-server/        MCP Server（AI Agent 集成）
│   ├── autocodeflow-node-sdk/  Node.js SDK
│   ├── autoflow-sdk/      Python SDK
│   ├── executor-protocol/ 执行器协议契约
│   └── docs-site/         VitePress 文档站
├── docs/                  文档（入口：docs/README.md）· 展示图：docs/assets/
├── examples/              可运行的官方示例
├── infra/                 反向代理、监控、基础设施 compose
├── scripts/               构建、校验、自检与守卫脚本
└── deploy.sh              一键部署（源码 / Docker 双模）
```

根目录只放仓库级文件（README / LICENSE / CHANGELOG / CONTRIBUTING / SECURITY / 部署脚本与 compose），
其余文档一律进 [`docs/`](docs/README.md)，一次性报告进 [`docs/archive/`](docs/archive/README.md)——
由 CI 的 `DOC-GOV` 守卫（`scripts/docs/check-docs.mjs`：死链 / 孤儿文档 / 根目录洁癖）强制执行。

## 📚 文档

| 文档 | 说明 |
|---|---|
| [**文档中心**](docs/README.md) | **从这里开始**——按角色索引全部文档 |
| [快速上手](docs/quickstart.md) | 5 分钟跑通第一条定时任务 |
| [部署指南](docs/deployment.md) | 系统要求、环境变量、升级与回滚 |
| [运维手册](docs/operations.md) | 日常运维、备份恢复、扩容、故障排查 |
| [开发指南](docs/development.md) | 本地开发、测试、代码规范 |
| [SDK 指南](docs/sdk-guide.md) | Node / Python 双 SDK 能力矩阵与用法 |
| [API 参考](docs/api-reference.md) | REST 端点契约、认证、错误码 |
| [架构图谱](docs/atlas/README.md) | 全项目结构 / 功能 / 关系彻底拆解 |
| [教程](docs/tutorials/index.md) | 按真实上线顺序编排的五篇教程 |
| [架构决策记录](docs/adr/README.md) | 改架构前必读的 ADR |
| [可观测性](docs/observability/README.md) | 指标、日志、追踪与告警配置 |
| [获取帮助](SUPPORT.md) · [安全策略](SECURITY.md) | 去哪提问、如何报告漏洞 |

## 🔒 安全

- **RBAC** — 项目级角色（owner / developer / viewer），路由级门控与 CI 守卫（`check-route-authz-matrix`）。
- **凭证** — 作用域 API Key、per-execution 回调令牌、执行器共享令牌轮换、TOTP 双因子、OIDC SSO。
- **隔离** — Python 任务可选 bubblewrap 沙箱（用户命名空间 + 只读根 + PrivateTmp）；子进程环境变量白名单。
- **网络** — 出站请求统一 SSRF 守卫 + DNS pin（私网默认拒绝，按集成按需开启）。
- **审计** — 全量操作审计日志、部署第二人审批、可回溯的配置历史。
- **供应链** — 依赖审计日志、密钥扫描（gitleaks）、镜像多架构构建闸、发布卫生审计。

安全漏洞请按 [SECURITY.md](SECURITY.md) 私下报告，不要开公开 issue。

## 🤝 贡献

1. Fork 本仓库并创建分支：`git checkout -b feat/your-feature`
2. 遵循 [Conventional Commits](https://www.conventionalcommits.org/) 提交
3. 跑对应测试（`npm run test:api` / `test:web` / `test:python` …）
4. 提交 PR 并填写检查清单（见 [CONTRIBUTING.md](CONTRIBUTING.md)）

CI 覆盖 admin-api、admin-web、三类执行器、双 SDK、CLI、MCP Server、部署脚本与文档守卫。

## 📄 许可证

AutoCodeFlow 自 v1.4.0 起采用**分组件许可**：

| 组件 | 许可证 |
|---|---|
| **平台核心**（`apps/*` + `packages/docs-site`） | [AGPL-3.0-only](LICENSE) |
| **客户端 SDK 与工具**（CLI、Node/Python SDK、MCP Server） | MIT |
| **执行器协议**（第三方执行器集成） | MIT |

v1.3.0 及更早版本继续以 MIT 提供。

## 🙏 致谢

[NestJS](https://nestjs.com/) · [React](https://react.dev/) · [Ant Design](https://ant.design/) ·
[TypeORM](https://typeorm.io/) · [BullMQ](https://docs.bullmq.io/) · [Electron](https://www.electronjs.org/) ·
[Vite](https://vite.dev/) · [FastAPI](https://fastapi.tiangolo.com/) · [Verdaccio](https://verdaccio.org/)

---

<p align="center"><sub>© 2026 LuluDeer · 用 ❤️ 与 TypeScript / Python 构建</sub></p>

---

📖 **[View English Version](README.md#english) | 查看英文版**
