# 开发指南

## 环境要求

| 工具 | 版本要求 | 安装说明 |
|------|----------|----------|
| Node.js | 20.x LTS | https://nodejs.org 或 nvm |
| pnpm | 8.x | `npm install -g pnpm@8` |
| Python | 3.11+ | https://python.org 或 pyenv |
| Docker | 24.0+ | https://docs.docker.com/get-docker/ |
| Docker Compose | 2.20+ | 随 Docker Desktop 附带 |

## 本地启动步骤

### 1. 克隆仓库并安装依赖

```bash
git clone https://github.com/your-org/AutoCodeFlow.git
cd AutoCodeFlow

# 安装 Node.js 依赖（monorepo 根目录）
pnpm install
```

### 2. 配置本地环境变量

```bash
cp .env.example .env
cp apps/admin-api/.env.example apps/admin-api/.env
# 按需修改各 .env 文件中的配置
```

### 3. 启动依赖服务（数据库、Redis）

```bash
# 仅启动基础设施服务，不启动应用
docker compose up -d postgres redis
```

### 4. 执行数据库迁移

```bash
cd apps/admin-api
npm run migration:run
cd ../..
```

### 5. 启动各服务（各开一个终端）

```bash
# 终端 1：Admin API
cd apps/admin-api && npm run start:dev

# 终端 2：Admin Web
cd apps/admin-web && pnpm dev

# 终端 3：Python 执行器
cd apps/executor-python && pip install -r requirements.txt && python main.py

# 终端 4：Node.js 执行器
cd apps/executor-node && npm install && npm run dev

# 终端 5：桌面执行器（可选）
cd apps/executor-desktop && npm install && npm run build:executor && npm run dev
```

## 各服务端口说明

| 服务 | 端口 | 说明 |
|------|------|------|
| admin-api | 3105 | NestJS REST API，含 Swagger 文档 |
| admin-web | 80 (prod) / 5176 (dev) | React 管理后台 |
| executor-python | 8001 | FastAPI Python 执行器 |
| executor-node | 8002 | Express Node.js 执行器 |
| executor-desktop | 由用户配置 | Electron 桌面执行器 |
| PostgreSQL | 5432 | 主数据库 |
| Redis | 6379 | 缓存与消息队列 |

## 数据库迁移命令

```bash
# 进入 admin-api 目录
cd apps/admin-api

# 运行所有待执行迁移
npm run migration:run

# 生成新迁移文件（根据 Entity 变化自动生成）
npm run migration:generate -- src/migrations/YourMigrationName

# 回滚最后一次迁移
npm run migration:revert

# 查看迁移状态
npm run migration:show
```

迁移文件位于 `apps/admin-api/src/migrations/`，采用时间戳前缀命名，例如 `1717473142678-InitialSchema.ts`。

## 测试命令

```bash
# Admin API 单元测试
cd apps/admin-api
npm run test

# Admin API 单元测试（watch 模式）
npm run test:watch

# Admin API 覆盖率报告
npm run test:cov

# Admin API 端到端测试
npm run test:e2e

# Python 执行器测试
cd apps/executor-python
pytest

# Node.js 执行器测试
cd apps/executor-node
npm test

# 桌面执行器测试
cd apps/executor-desktop
npm test

# SDK 测试
cd packages/autoflow-sdk && pytest
cd packages/autocodeflow-node-sdk && npm test
```

## 扩展组件开发

### 桌面执行器 (executor-desktop)

基于 Electron + React 构建的桌面应用，将 Node.js 执行器打包为桌面常驻程序。

```bash
cd apps/executor-desktop
npm install

# 首次开发需先打包 executor-node
npm run build:executor

# 启动开发模式（Electron + Vite HMR）
npm run dev

# 构建全平台安装包
npm run dist        # 全平台
npm run dist:win    # Windows .exe
npm run dist:mac    # macOS .dmg
npm run dist:linux  # Linux .AppImage
```

目录结构：

```
src/
├── main/               # Electron 主进程
│   ├── index.ts             # 应用生命周期管理
│   ├── tray.ts              # 系统托盘图标与菜单
│   ├── executor-process.ts  # 子进程管理（启动/停止/日志）
│   ├── heartbeat.ts         # HTTP 心跳检测
│   ├── config-store.ts      # 配置持久化（electron-store）
│   ├── ipc-handlers.ts      # IPC 通道注册
│   ├── window-manager.ts    # 窗口管理
│   └── autolaunch.ts        # 开机自启
├── preload/            # contextBridge 安全桥接
├── renderer/           # React UI
│   ├── pages/Wizard.tsx      # 首次配置向导
│   ├── pages/StatusWindow.tsx # 状态/日志主窗口
│   └── pages/ConfigPage.tsx   # 配置编辑页
└── resources/
    └── executor-node/   # ncc 打包后的 executor-node 单文件
```

详见 [executor-desktop/README.md](../apps/executor-desktop/README.md)

### Packages 开发

#### CLI 工具 (acf-cli)

```bash
cd packages/acf-cli
npm install
npm run build
npm link                   # 全局安装到本地

# 使用
acf login --url http://localhost:3105 --username admin
acf task list
acf task trigger <taskId>
```

#### MCP Server

```bash
cd packages/mcp-server
npm install
npm run build

# 在 Claude Desktop config 中配置
# 详见 packages/mcp-server/README.md
```

#### Python SDK (autoflow-sdk)

```bash
cd packages/autoflow-sdk
pip install -e ".[dev]"
pytest
```

#### Node.js SDK (autocodeflow-node-sdk)

```bash
cd packages/autocodeflow-node-sdk
npm install
npm test
npm run build
```

## 代码规范

### 配置读取规约（ARCH-27，apps/admin-api）

**痛点**：env 直读散布曾导致死配置（W-22：`@Throttle` 装饰器在模块求值期读
`process.env.LOGIN_THROTTLE_LIMIT`，早于 ConfigModule 载入 `.env`，配置静默失效）。

**规则**（ESLint `no-restricted-properties` 已封禁 `process.env` 直读，违规即 lint 失败）：

1. **新增配置必须先注册**：`apps/admin-api/src/app.module.ts` 的
   ConfigModule `validationSchema`（Joi）声明变量与默认值 →
   `src/config/configuration.ts` 映射为配置对象 → 消费方注入 `ConfigService`
   以 `configService.get("section.key")` 读取。
2. **直读豁免清单**（维护位置：`apps/admin-api/.eslintrc.js` 的
   `overrides`，每处必须带理由注释）：
   - `src/config/configuration.ts` —— 唯一合法的 env → 配置映射层；
   - `src/config/env.ts`（`getEnvVar()`）—— 模块求值期（装饰器参数、模块级
     常量）或无 DI 环境（如 TypeORM CLI）的唯一收口 util，调用点必须注释
     W-22 前科与豁免理由；
   - `**/*.spec.ts`、`test/**` —— 测试 fixture 需直接操纵 env。
3. **回归守卫**：`src/__tests__/main-env-preload.spec.ts` 钉住
   main.ts 在 import app.module 前预载 `.env` + 动态 import 的顺序 ——
   求值期读取依赖该顺序，请勿"整理"回静态 import。
4. 完整规约原文见 `src/config/configuration.ts` 头部注释。

### TypeScript / JavaScript

- 使用 ESLint + Prettier 进行代码检查和格式化
- 提交前自动运行 lint：`npm run lint`
- 格式化代码：`npm run format`
- 遵循 NestJS 官方最佳实践，模块化组织代码
- 所有公共 API 方法须添加 JSDoc 注释

### Python

- 使用 `black` 格式化代码：`black .`
- 使用 `flake8` 进行代码检查：`flake8 .`
- 类型注解：所有函数签名必须包含类型注解
- 遵循 PEP 8 规范

### Git 提交规范

遵循 [Conventional Commits](https://www.conventionalcommits.org/) 规范：

```
feat: 新增功能
fix: 修复 Bug
docs: 文档变更
refactor: 代码重构（不影响功能）
test: 新增或修改测试
chore: 构建流程或辅助工具变更
```

示例：
```
feat: 新增任务批量执行接口
fix: 修复执行器心跳超时导致的误下线问题
docs: 更新 SDK 使用示例
```

### 分支策略

- `main`：主分支，仅接受经过 Review 的 PR
- `feat/xxx`：功能开发分支
- `fix/xxx`：Bug 修复分支
- `release/x.x.x`：发布分支

## PR 前检查清单（DOC-01）

提交 PR 时 `.github/PULL_REQUEST_TEMPLATE.md` 会自带「API 变更？」检查项，
发起 PR 前先逐项自查（模板不适用的小节勾「否」保留，不要删除）：

1. **新增/修改端点** → 同一 PR 内更新 `docs/api-reference.md`（列明方法 + 路径与
   请求/响应契约），不留「文档后补」——历轮多次出现端点已合入、文档滞后数轮的补漏。
2. **Breaking 变更**（删字段/改语义/改状态码/收紧鉴权）→ 列明影响面，四个客户端包
   （`acf-cli` / `mcp-server` / `autocodeflow-node-sdk` / `autoflow-sdk`）是否需要
   同批适配；鉴权类收紧参考「前后端同批发布」先例（W2 RBAC）。
3. **新增环境变量** → 三处同批登记：`configuration.ts`（+ app.module Joi 校验）、
   `.env.example`、`docs/` 对应环境变量表——规约详见上文「配置读取规约（ARCH-27）」。
4. **新增数据库迁移** → 时间戳先查 `docs/PLAN-CLAIMS.md` 认领板确认未被并行会话
   占用，并在 PR 模板中填写。
5. **平台影响** → `executor-node` 源码改动必须与重打的 `bundle` 同 commit 提交；
   涉及执行器/调度行为变更对照 `docs/VERIFY-MATRIX.md` 补真机验证项。

## 项目结构

```
AutoCodeFlow/
├── apps/
│   ├── admin-api/          # NestJS 后端 API
│   │   ├── src/
│   │   │   ├── modules/    # 业务模块（auth/task/executor/application/notification/...）
│   │   │   ├── common/     # 公共工具、守卫、过滤器、拦截器、DTO
│   │   │   ├── config/     # 配置管理
│   │   │   └── migrations/ # 数据库迁移文件
│   ├── admin-web/          # React 管理前端
│   ├── executor-python/    # Python 执行器 (FastAPI)
│   ├── executor-node/      # Node.js 执行器 (Express)
│   └── executor-desktop/   # Electron 桌面执行器
├── packages/
│   ├── acf-cli/               # 命令行工具
│   ├── mcp-server/            # MCP Server
│   ├── autoflow-sdk/          # Python 任务 SDK
│   ├── autocodeflow-node-sdk/ # Node.js 完整 SDK
│   ├── autocodeflow-ai/       # AI 分析引擎
│   ├── autocodeflow-db/       # 数据库连接工具
│   ├── autocodeflow-http/     # HTTP 客户端
│   └── autocodeflow-notify/   # 通知发送工具
├── examples/
│   └── desktop-automation/    # 桌面自动化（RPA）示例
├── design-system/             # 设计系统规范
├── docs/                      # 项目文档
├── docker-compose.yml         # 容器编排配置
├── .env.example               # 环境变量模板
└── Makefile                   # 常用命令快捷方式
```
