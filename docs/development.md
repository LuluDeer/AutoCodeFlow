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

> 根级统一入口（`npm run test:all` / `typecheck:all` 等，ARCH-20）见根 `package.json`；
> monorepo 依赖安装形态与 workspace/turbo 二期评估（ARCH-28）见
> [docs/arch-28-workspace-evaluation.md](./arch-28-workspace-evaluation.md)。

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

### 任务 runtime 注册表（ARCH-25）

runtime 的能力描述（glue 语言、依赖安装器、entrypoint 扩展名、承载执行器等）
由单一事实源 `apps/admin-api/src/modules/runtime/` 提供，内置 `python` /
`node` / `shell` 三项，`RuntimeModule` 为 `@Global`（任意模块可直接注入）：

```ts
import { TaskRuntimeRegistry } from "../runtime/task-runtime-registry.service";

constructor(private readonly runtimes: TaskRuntimeRegistry) {}

const shell = this.runtimes.get(TaskRuntime.SHELL); // → TaskRuntimeDefinition | null
const all = this.runtimes.list();                   // → 副本快照
```

注册一个自定义 runtime（示例：deno，仅演示协议，未内置进生产）：

```ts
this.runtimes.register({
  runtime: "deno" as TaskRuntime,
  label: "Deno",
  glueLanguage: "node",
  dependencyInstaller: "none",
  defaultEntrypointExtension: "ts",
  defaultRuntimeVersion: null,
  executorKind: "any",
  description: "示例 runtime：演示第三方 runtime 的注册协议。",
});
// 同名已存在时需显式声明覆盖，否则抛错（防插件静默改写内置语义）：
this.runtimes.register(definition, { override: true });
```

纪律（本阶段红线）：

- 注册表是**描述层**：未知 runtime `get()` 返回 `null`（fail-open），任何消费方
  都不得因注册表缺项而拒绝既有任务——避免把描述层变成新的准入闸门。
- `TaskRuntime` 枚举与 DTO `@IsEnum` 校验**保持不变**，因此零迁移、零 openapi
  变更；新增枚举值必须同步注册（spec 用「枚举值 ↔ 注册表键」一致性断言守住）。
- executor 侧（executor-node/python）本阶段零触碰：runtime 的实际执行语义仍由
  各执行器分支实现，注册表只描述能力。

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
4. **新增数据库迁移** → 时间戳先在 `docs/PLAN-CLAIMS.md`「迁移时间戳分配表」登记
   （分配规则=在盘最大时间戳 +1，先登记再建文件），CI `check-migrations` job 会拦截
   撞号与漏登（scripts/check-migrations.mjs，可本地预跑；配套自检
   scripts/check-migrations.selftest.mjs）。
5. **平台影响** → `executor-node` 源码改动必须与重打的 `bundle` 同 commit 提交；
   涉及执行器/调度行为变更对照 `docs/VERIFY-MATRIX.md` 补真机验证项。

## 版本与发布流程·CHANGELOG 自动化（DOC-05）

发版手工链路（三包 version 同批 bump → 手写 CHANGELOG → 打 tag）自本轮起由
[release-please](https://github.com/googleapis/release-please) 自动化。**选型裁定
（vs changesets）**：

1. 本仓 commit 纪律是中文 conventional commits（见上文「Git 提交规范」）——
   release-please 对 conventional commits 原生解析、零迁移成本；changesets
   需要 PR 手写 `.changeset/*.md` 增量文件，与既有纪律并行多一套仪式。
2. 三包走 **lockstep 单版本线**（`@autocodeflow/sdk` / `autocodeflow-mcp-server` /
   `autoflow-sdk` 当前均 1.0.1，`release.yml` 的 version-guard 强制四处 version
   一致），不需要 changesets 的按包独立版本管理。
3. release-please 对 node（package.json）+ python（pyproject.toml）混合仓原生
   支持；changesets 只管 npm 包。

### 接入形态（最小正确）

| 文件 | 作用 |
|------|------|
| `.github/workflows/release-please.yml` | push 到 `main` 时汇总 conventional commits：有可发布变更 → 创建/更新 **Release PR**（bump 三包 version + 生成/追加根级 `CHANGELOG.md`）；Release PR 合并 → 打 tag `vX.Y.Z` + 创建 GitHub Release |
| `release-please-config.json` | 三包路径 → release-type（node/node/python）；`include-component-in-tag: false` 使 tag 为裸 `vX.Y.Z`（非 `pkg-vX.Y.Z`） |
| `release-please-manifest.json` | 记录已发布版本基线（当前 1.0.1） |

### 与 release.yml 的衔接（release.yml 本体零改动）

```
push main ──→ release-please.yml：开/更新 Release PR（version bump + CHANGELOG）
Release PR 合并 ──→ release-please 打 tag v(X.Y.Z)
tag v* push ──→ 既有 release.yml：version-guard → environment 审批闸 → npm + PyPI 发布
```

即 release-please 产出的 tag **恰好触发**既有 tag 触发的 `release.yml`——发布管道、
审批闸、幂等语义全部复用既有实现（见 `docs/sdk-guide.md`「版本与发布流程」）。

### 首次启用观察点

- **版本漂移兜底**：三包独立提议版本时可能漂移，但 tag 一旦 push 会被
  version-guard 拦截（fail 安全，不会发出不一致的包）；首次 Release PR 合并前
  **人工核对三包 version 已收敛为同一值**。
- `autoflow_sdk.__version__`（`packages/autoflow-sdk/autoflow_sdk/__init__.py`）
  由 python release-type 的 extra-files 机制同步，首次 Release PR 里核对四处
  version 是否齐全。
- **真跑验证不可行**（需 main push 权限 + 实际 PR 流程），已以 actionlint 语法
  校验 + 本节干跑说明代替；首次发布时观察：① Release PR 是否正确汇总
  conventional commits；② 合并后 tag 是否触发 release.yml；③ 根级
  `CHANGELOG.md` 是否生成（当前仓库无根级 CHANGELOG.md，追加式生成不覆盖历史）。
- **GITHUB_TOKEN 的 tag 不级联（2026-09-11 v1.1.1 实测确认，原假设已证伪）**：
  GitHub 会抑制所有由 `GITHUB_TOKEN` 产生的事件（含 `on: push: tags`）以防递归，
  故 release-please（默认 GITHUB_TOKEN）打出的 tag **不会触发** `release.yml`——实测
  表现为「tag 已生成、Release 流水线零 run」。**必须**配置仓库 secret
  `RELEASE_PLEASE_TOKEN`（fine-grained PAT：Contents read/write + Pull requests
  read/write）后级联才成立；未配置时的恢复路径是人工重推同名 tag（内容不变且
  尚未发布任何产物时安全），详见 `docs/sdk-guide.md`「版本与发布流程」。
- **lockstep 需人工兜底**：`linked-versions` 插件只联动「本轮有候选发布的组件」，
  无路径内提交的包会被跳过（v1.1.1 首跑即 node-sdk 被跳过）→ 合并 Release PR 前
  人工核对该包 version/manifest 已对齐同值（本仓已在发布 PR 内补齐，见 §版本与
  发布流程）。

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
