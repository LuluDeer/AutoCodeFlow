# AutoCodeFlow

AutoCodeFlow 是一个分布式任务调度与执行平台，支持动态脚本任务（JavaScript / Python）的定时调度、多执行器管理、实时监控与通知。

## 功能概览

- **任务管理** — 创建、编辑、启停定时任务；支持 Cron 表达式调度
- **Glue 脚本** — 在线编写 JavaScript / Python 胶水脚本，任务执行时动态下发给执行器
- **多执行器** — 横向扩展；Node.js 与 Python 执行器自动注册、心跳保活
- **桌面执行器** — Electron 桌面应用，常驻系统托盘，可在任意设备上安装运行
- **私有包仓库** — 内置 npm (Verdaccio) 与 PyPI 私有仓库，任务可安装内部依赖
- **应用分组** — 将任务归属到应用（Application），支持批量操作与权限隔离
- **通知渠道** — 企业微信、钉钉、Slack Webhook、邮件（SMTP）
- **AI 辅助** — 可选接入 OpenAI / Ollama，辅助编写脚本与失败分析
- **MCP 集成** — 提供 MCP Server，AI Agent 可直接管理任务与执行
- **CLI 工具** — `acf` 命令行工具，支持任务/执行器/应用的脚本化管理
- **SDK 生态** — Python / Node.js SDK，提供任务上下文、HTTP 客户端、日志等能力
- **监控告警** — Prometheus 指标端点；健康检查接口
- **审计日志** — 所有执行记录可追溯，支持执行详情对比

## 技术栈

| 组件 | 技术 |
|---|---|
| admin-api | NestJS · TypeORM · PostgreSQL · Redis · BullMQ |
| admin-web | React · Vite · Ant Design |
| executor-node | Node.js (Express) |
| executor-python | Python (FastAPI) |
| executor-desktop | Electron · React · Node.js |
| registry-npm | Verdaccio |
| registry-pypi | 自建 FastAPI PyPI 服务 |
| acf-cli | TypeScript · Commander.js |
| mcp-server | TypeScript · MCP SDK |
| autoflow-sdk | Python (httpx) |
| @autocodeflow/sdk | Node.js (axios)，独立 npm 包（已发布） |
| 部署 | Docker Compose |

## 快速启动

### 前置条件

- Docker >= 24 & Docker Compose >= 2.20
- （本地开发）Node.js >= 20，Python >= 3.11，pnpm >= 8

### 一键 Docker Compose 启动

```bash
# 1. 克隆仓库
git clone https://github.com/your-org/AutoCodeFlow.git
cd AutoCodeFlow

# 2. 配置环境变量
cp .env.example .env
# 编辑 .env，至少设置以下必填项：
#   POSTGRES_PASSWORD  DB_PASSWORD  JWT_SECRET  JWT_REFRESH_SECRET  EXECUTOR_SECRET
vim .env

# 3. 启动所有服务
docker compose up -d

# 4. 查看启动状态
docker compose ps
docker compose logs -f admin-api
```

服务启动后访问：

| 服务 | 地址 |
|---|---|
| 管理后台 | http://localhost |
| API 文档 (Swagger) | http://localhost:3105/api/docs |
| API 健康检查 | http://localhost:3105/health |
| Prometheus 指标 | http://localhost:3105/metrics |
| executor-node | http://localhost:8002/health |
| executor-python | http://localhost:8001/health |
| executor-desktop | 桌面应用托盘启动 |
| npm registry | http://localhost:4873 |
| PyPI registry | http://localhost:8003 |

默认管理员账号由 `INITIAL_ADMIN_PASSWORD` 环境变量设置，首次登录后请立即修改密码。

### 本地开发启动

```bash
# 启动基础设施（PostgreSQL + Redis）
docker compose up -d postgres redis

# 安装依赖
pnpm install

# 配置各服务环境变量
cp apps/admin-api/.env.example apps/admin-api/.env
cp apps/admin-web/.env.example apps/admin-web/.env
cp apps/executor-node/.env.example apps/executor-node/.env
cp apps/executor-python/.env.example apps/executor-python/.env

# 运行数据库迁移
cd apps/admin-api && pnpm run migration:run && cd ../..

# 并行启动所有服务（根目录）
pnpm run dev
# 或分别启动：
# cd apps/admin-api && pnpm run start:dev
# cd apps/admin-web && pnpm run dev
# cd apps/executor-node && pnpm run dev
```

## 项目结构

```
AutoCodeFlow/
├── apps/
│   ├── admin-api/          # NestJS 后端 API
│   ├── admin-web/          # React 管理前端
│   ├── executor-node/      # Node.js 任务执行器
│   ├── executor-python/    # Python 任务执行器
│   ├── executor-desktop/   # Electron 桌面执行器
│   ├── registry-npm/       # Verdaccio 私有 npm 仓库配置
│   └── registry-pypi/      # 私有 PyPI 仓库服务
├── packages/
│   ├── acf-cli/               # 命令行工具 (acf)
│   ├── mcp-server/            # MCP Server（AI Agent 集成）
│   ├── autoflow-sdk/          # Python 任务 SDK
│   ├── autocodeflow-node-sdk/ # Node.js 任务 SDK
│   ├── autocodeflow-ai/       # AI 分析引擎
│   ├── autocodeflow-db/       # 数据库连接工具
│   ├── autocodeflow-http/     # HTTP 客户端工具
│   └── autocodeflow-notify/   # 通知发送工具
├── examples/
│   └── desktop-automation/    # 桌面自动化（RPA）示例任务
├── design-system/             # 设计系统规范（UI/UX）
├── infra/                     # 本地开发基础设施 docker-compose
├── docs/                      # 项目文档
├── docker-compose.yml         # 生产/staging 完整部署
├── .env.example               # 环境变量模板
└── Makefile                   # 常用命令快捷方式
```

## 配置说明

所有配置通过环境变量注入。各服务的完整变量列表见对应的 `.env.example`：

| 文件 | 说明 |
|---|---|
| `.env.example` | Docker Compose 根配置（生产部署用） |
| `apps/admin-api/.env.example` | API 服务完整配置 |
| `apps/admin-web/.env.example` | 前端 Vite 配置 |
| `apps/executor-node/.env.example` | Node.js 执行器配置 |
| `apps/executor-python/.env.example` | Python 执行器配置 |

### 生产环境必填项

| 变量 | 要求 | 说明 |
|---|---|---|
| `DB_PASSWORD` | >= 16 字符，非弱密码 | PostgreSQL 密码 |
| `JWT_SECRET` | >= 32 字符随机串 | JWT 签名密钥 |
| `JWT_REFRESH_SECRET` | >= 32 字符随机串 | JWT 刷新令牌密钥 |
| `EXECUTOR_SECRET` | >= 16 字符随机串 | 执行器注册共享密钥 |
| `CORS_ORIGINS` | 实际域名，不含 localhost | 跨域允许来源 |

生成强随机值示例：
```bash
openssl rand -hex 32   # JWT_SECRET / JWT_REFRESH_SECRET
openssl rand -hex 16   # EXECUTOR_SECRET
```

## 扩展组件

### 桌面执行器 (executor-desktop)

基于 Electron 的桌面执行器应用，可在 Windows / macOS / Linux 上安装运行。常驻系统托盘，支持开机自启，无需手动维护。

详见 [executor-desktop/README.md](apps/executor-desktop/README.md)

### CLI 工具 (acf)

```bash
# 安装
cd packages/acf-cli && npm install && npm run build && npm link

# 使用
acf login --url http://localhost:3105 --username admin
acf task list
acf task trigger <taskId>
acf executor list
acf app list
```

### MCP Server

让 Claude Desktop、Cursor 等 AI Agent 直接管理 AutoCodeFlow 任务与执行。暴露 12 个工具，支持任务 CRUD、手动触发、执行分析、调度建议等。

详见 [packages/mcp-server/README.md](packages/mcp-server/README.md)

### SDK 生态

| 包名 | 语言 | 说明 |
|------|------|------|
| `autoflow-sdk` | Python | 任务上下文、HTTP 客户端、日志、结果上报 |
| `autocodeflow-node-sdk` | Node.js | 完整版任务 SDK（含更多工具） |
| `autocodeflow-ai` | Python | AI 执行分析引擎 |
| `autocodeflow-db` | Python | 数据库连接工具 |
| `autocodeflow-http` | Python | HTTP 客户端封装 |
| `autocodeflow-notify` | Python | 多通道通知发送 |

详见 [SDK 使用指南](docs/sdk-guide.md)

### 示例任务

`examples/desktop-automation/` 提供桌面自动化（RPA 风格）示例任务：

- 浏览器自动化（网页操作、截图）
- 桌面 GUI 自动化（鼠标/键盘操作、图像识别）
- 文件系统自动化（批量操作、目录同步）
- 系统集成自动化（进程管理、系统监控）

详见 [examples/desktop-automation/README.md](examples/desktop-automation/README.md)

## API 文档

启动服务后，Swagger UI 可在以下地址访问：

```
http://localhost:3105/api/docs
```

主要 API 模块：

| 模块 | 路径前缀 | 说明 |
|---|---|---|
| 认证 | `/api/auth` | 登录、刷新 Token |
| 任务 | `/api/tasks` | 任务 CRUD、启停、手动触发 |
| 应用 | `/api/applications` | 应用分组管理 |
| 执行记录 | `/api/executions` | 执行历史、日志查看 |
| 执行器 | `/api/executors` | 执行器注册与状态 |
| 通知配置 | `/api/notification` | 通知渠道管理 |
| 用户管理 | `/api/users` | 用户 CRUD、密码修改 |
| 系统配置 | `/api/config` | 系统参数读写 |
| 执行器包 | `/api/executor-packages` | 应用包上传与管理 |
| 注册表 | `/api/registry` | 私有 npm/PyPI 仓库信息 |
| 健康检查 | `/health` | 服务健康状态 |
| 指标 | `/metrics` | Prometheus 格式指标 |

## 文档

| 文档 | 说明 |
|------|------|
| [快速上手](docs/quickstart.md) | 5 分钟跑起来，完成第一个定时任务，常见问题解答 |
| [部署指南](docs/deployment.md) | 系统要求、环境变量、快速部署、运维命令、升级指南 |
| [运维手册](docs/operations.md) | 日常运维、备份恢复、多执行器扩容、故障排查、安全加固 |
| [开发指南](docs/development.md) | 本地启动、端口说明、迁移命令、测试命令、代码规范 |
| [SDK 使用指南](docs/sdk-guide.md) | manifest 格式、注入变量、Python/Node SDK 示例 |
| [API 参考](docs/api-reference.md) | 所有接口端点、认证说明、响应格式、错误码 |
| [优化建议](docs/optimization-notes.md) | E2E 测试发现的 Bug、各组件优化建议、跨平台路线图 |

## 常用 Make 命令

```bash
make help          # 查看所有可用命令
make dev           # 启动开发环境
make build         # 构建所有服务镜像
make test          # 运行所有测试
make migration     # 运行数据库迁移
make logs          # 查看服务日志
```

## 数据库迁移

迁移文件位于 `apps/admin-api/src/migrations/`，共 7 个迁移，覆盖完整 schema。

**自动行为：**
- `NODE_ENV=development`：`synchronize: true`，schema 随实体自动同步，无需手动迁移
- 其他环境：`migrationsRun: true`，服务启动时自动执行所有待执行迁移

**手动操作（CLI）：**

```bash
cd apps/admin-api

# 查看迁移状态
npm run migration:show

# 手动运行所有待执行迁移
npm run migration:run

# 回滚最后一次迁移
npm run migration:revert

# 从实体变更生成新迁移
npm run migration:generate -- src/migrations/<MigrationName>
```

在容器内执行：

```bash
docker compose exec admin-api npm run migration:show
docker compose exec admin-api npm run migration:run
```

## 常见问题

**启动时报 JWT_SECRET 错误**

生产环境（`NODE_ENV=production`）要求 `JWT_SECRET` 长度 >= 32 字符且不能是已知弱值。请执行 `openssl rand -hex 32` 生成后填入 `.env`。

**执行器无法连接 admin-api**

检查 `EXECUTOR_SHARED_TOKEN` 是否与 admin-api 配置一致，并确认 `ADMIN_API_URL` 指向正确的地址（Docker 内部使用服务名 `http://admin-api:3105`）。

**数据库迁移失败**

```bash
# 查看迁移状态
docker compose exec admin-api pnpm run migration:show
# 手动运行迁移
docker compose exec admin-api pnpm run migration:run
```

## 贡献指南

1. Fork 本仓库并创建功能分支：`git checkout -b feat/your-feature`
2. 提交代码并确保测试通过：`pnpm run test`
3. 提交 Pull Request，描述变更内容

## License

[MIT](LICENSE) © 2026 LuluDeer
