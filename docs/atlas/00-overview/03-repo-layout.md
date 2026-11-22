# 仓库目录结构逐层拆解

> 所属: docs/atlas/00-overview · 最后核对: 2026-11-22 · 对应代码: 仓库根目录

```text
AutoCodeFlow/
├── apps/                        ← 可独立部署的应用（7 个）
│   ├── admin-api/               NestJS 后端控制面（核心）
│   │   └── src/
│   │       ├── modules/         22 个业务模块（auth/task/scheduler/executor/sop/agent/...）
│   │       ├── common/          守卫/拦截器/过滤器/装饰器
│   │       ├── config/          配置加载与校验（ARCH-27）
│   │       ├── migrations/      TypeORM 迁移（146 个）
│   │       ├── data-source.ts   TypeORM 数据源定义
│   │       └── main.ts          启动入口
│   ├── admin-web/               React 19 管理台（Vite 8 / Ant Design 6）
│   │   └── src/
│   │       ├── pages/           20+ 页面（含 audit/settings/sops/agent-sessions 等）
│   │       ├── components/      通用组件
│   │       ├── api/             后端 API 封装层
│   │       ├── store/ hooks/    状态与 hooks
│   │       ├── i18n/ locales/   国际化
│   │       └── theme/ styles/   设计系统落地
│   ├── executor-node/           Node.js 执行器（Express，:8002）
│   ├── executor-python/         Python 执行器（FastAPI，:8001）
│   ├── executor-desktop/        Electron 桌面执行器（main/renderer，独立版本线 desktop-v*）
│   ├── registry-npm/            Verdaccio 私有 npm 服务（:4873）
│   └── registry-pypi/           自建 PyPI 私有服务（FastAPI，:8003）
├── packages/                    ← 可复用包（11 个）
│   ├── acf-cli/                 `@autocodeflow/cli` 命令行工具（bin: `acf`，Commander.js，已发布 npm）
│   ├── mcp-server/              `autocodeflow-mcp-server` MCP Server（56 工具，已发布 npm）
│   ├── autoflow-sdk/            `autoflow-sdk` Python 任务 SDK（httpx，已发布 PyPI）
│   ├── autocodeflow-node-sdk/   `@autocodeflow/sdk` Node.js 任务 SDK（axios，已发布 npm）
│   ├── autocodeflow-ai/         AI 分析引擎（Python，仓内）
│   ├── autocodeflow-db/         数据库连接工具（Python，仓内）
│   ├── autocodeflow-http/       HTTP 客户端封装（Python，仓内）
│   ├── autocodeflow-notify/     多通道通知发送（Python，仓内）
│   ├── executor-protocol/       跨端执行器协议与网络策略契约（protocol.json）
│   ├── contract-fixtures/       跨端响应信封与失败分类契约夹具（contract.json）
│   └── docs-site/               VitePress SDK 文档站（GitHub Pages）
├── examples/                    ← 官方示例库（8 个示例）
│   ├── daily-report/            每日报表导出（场景示例）
│   ├── intranet-inspection/     内网巡检（场景示例）
│   ├── desktop-data-entry/      桌面数据填报（场景示例）
│   ├── desktop-automation/      桌面自动化（RPA）示例
│   ├── callback-report/         Python 回调上报示例
│   ├── callback-report-node/    Node.js 回调上报示例
│   ├── private-registry-deps/      Python 私服依赖示例
│   └── private-registry-deps-node/ Node.js 私服依赖示例
├── deploy/                      内网穿透与本地部署辅助（frp / gost / local）
├── design-system/               设计系统规范与品牌视觉源资产
├── infra/                       nginx 反代与本地基础设施 compose
├── config/                      共享配置
├── scripts/                     部署 / demo / 压测 / 100+ 静态与真机守卫脚本
├── docs/                        项目文档（含 AGENT_HANDOFF.md、adr/、plan/、archive/ 与本 atlas 图谱）
├── .github/                     CI/发版/治理 workflows 与社区模板
├── docker-compose.yml           生产/staging 全量部署（含 .ha/.secure/.staging/.demo overlay）
├── deploy.sh · dev.sh · start-dev.sh · init-db.sh
├── Makefile                     常用命令快捷入口
├── e2e-full.spec.js             Playwright 全链路 E2E（根目录）
├── e2e-ui09-mobile.spec.js      移动端 UI E2E
├── .env.example                 环境变量模板（根级，compose 用）
└── pytest.ini · playwright.e2e.config.js · release-please-config.json · version.txt
```

## 目录分类心法

| 类别 | 位置 | 特点 |
|---|---|---|
| 部署单元 | `apps/*` | 各自独立安装依赖、独立测试/构建命令，互不 hoisting（ARCH-20） |
| 复用单元 | `packages/*` | CLI/MCP/SDK/协议契约/文档站与仓内 Python 工具库，供任务脚本与外部集成使用 |
| 集成测试 | 根目录 `e2e-*.spec.js` + `scripts/*.selftest.mjs` | 跨服务验证，用 `npm run test:*` / `npm run test:guards:repo` 入口 |
| 文档 | `docs/` | 主文档（quickstart/deployment/...）、`docs/AGENT_HANDOFF.md`、ADR 与本 atlas 图谱 |

## 注意事项

- 根 `package.json` 不装依赖，只做**命令转发**（`cd <app> && ...`），依赖在各 app/package 内独立安装（npm-only，禁 pnpm）。
- `node_modules` 不应承载根级业务依赖，依赖分散在各独立子项目的 `node_modules` 内（`check:no-hoisting` 守护）。
- `docs/AGENT_HANDOFF.md` 是多会话协作的交接快照，体量大，**不要**当作代码文档阅读入口；找历史结论用 git log + `docs/README.md`。
- `uploads/` 目录是运行时上传产物（本地开发），不入库。

## 相关文档

- 各应用细节: [../01-apps/](../01-apps)
- 包生态: [../02-packages/README.md](../02-packages/README.md)
