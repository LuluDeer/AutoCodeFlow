# 技术栈与运行时要求

> 所属: docs/atlas/00-overview · 最后核对: 2026-11-22 · 对应代码: 根与各 app 的 package.json / pyproject.toml、docker-compose.yml

## 技术栈矩阵

| 组件 | 语言/框架 | 存储/中间件 | 测试 | 构建 |
|---|---|---|---|---|
| admin-api | TypeScript · NestJS · TypeORM | PostgreSQL 16 · Redis 7 · BullMQ | Jest | tsc |
| admin-web | TypeScript · React 19 · Vite 8 · Ant Design 6 · React Router 7 | — | Vitest | Vite |
| executor-node | Node.js · Express | — | Jest | tsc |
| executor-python | Python · FastAPI | — | pytest | — |
| executor-desktop | Electron · React · Node.js | — | selftest(main+renderer) | electron-builder |
| registry-pypi | Python · FastAPI | 本地包目录 | pytest | Docker |
| registry-npm | Verdaccio（现成软件） | 本地存储 | selftest | Docker |
| acf-cli | TypeScript · Commander.js | 用户配置目录 | Vitest | tsc |
| mcp-server | TypeScript · MCP SDK | — | Vitest | tsc |
| autoflow-sdk | Python · httpx | — | pytest | pyproject |
| autocodeflow-node-sdk | TypeScript · axios | — | Jest | tsc |
| autocodeflow-ai/db/http/notify | Python | 各自职责域 | pytest | pyproject |

## 运行时版本要求

- Docker >= 24，Docker Compose >= 2.20（一键部署）
- **Node.js >= 24**（根 `engines.node: ">=24"`），**npm 11.x**（`packageManager: npm@11.19.0`，**全仓禁用 `pnpm`**，由 `scripts/check-no-hoisting.mjs` 守卫），Python >= 3.11（本地开发）
- 各 app / package **独立** `npm ci` / `npm install`（monorepo 刻意不做 workspace hoisting，ARCH-20 / ARCH-28b）

## 关键依赖选型理由（速记）

| 选型 | 理由 |
|---|---|
| BullMQ + Redis | 分布式调度队列，支持多实例（ARCH-31 outbox/claim） |
| TypeORM migrations（`migrationsRun: false`） | 生产统一配置 `migrationsRun: false`（`apps/admin-api/src/config/configuration.ts`），由 `deploy.sh` / `npm run migration:run:prod` 或 `main.ts` `runBootstrapMigrations()` 经 `pg_advisory_lock` 加锁执行，避免多实例并发执行迁移 |
| 双 SDK 分包 | autoflow-sdk 轻量（任务内注入用）；node-sdk 完整版独立发布 |
| Verdaccio | 私有 npm 现成方案；PyPI 无合适轻量方案故自建 FastAPI 服务 |
| MCP SDK | 让 Claude/Cursor 等 Agent 原生集成任务管理（56 工具） |

## 命令入口约定

- 根 `package.json`：`test:*` / `typecheck:*` / `lint:*` / `build:*` / `check:*` 按组件命名，全部是 `cd <子目录> && ...` 转发。
- `Makefile`：`make dev / build / test / migration / logs / help`。
- 单元测试总入口：`npm run test:unit`（14 个组件串行）；仓库守卫总入口：`npm run test:guards:repo`。

## 相关文档

- 仓库布局: [03-repo-layout.md](03-repo-layout.md)
- 部署与环境变量: [../06-infra/README.md](../06-infra/README.md)
- 测试策略: [../07-testing/README.md](../07-testing/README.md)
