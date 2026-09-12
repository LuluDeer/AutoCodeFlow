# 仓库目录结构逐层拆解

> 所属: docs/atlas/00-overview · 最后核对: 2026-09-13 · 对应代码: 仓库根目录

```
AutoCodeFlow/
├── apps/                        ← 可独立部署的应用（7 个）
│   ├── admin-api/               NestJS 后端控制面（核心）
│   │   └── src/
│   │       ├── modules/         19 个业务模块（auth/task/scheduler/executor/...）
│   │       ├── common/          守卫/拦截器/过滤器/装饰器
│   │       ├── config/          配置加载与校验
│   │       ├── migrations/      TypeORM 迁移（7 个）
│   │       ├── data-source.ts   TypeORM 数据源定义
│   │       └── main.ts          启动入口
│   ├── admin-web/               React 管理台
│   │   └── src/
│   │       ├── pages/           20+ 页面（含 audit/settings 等子目录）
│   │       ├── components/      通用组件
│   │       ├── api/             后端 API 封装层
│   │       ├── store/ hooks/    状态与 hooks
│   │       ├── i18n/ locales/   国际化
│   │       └── theme/ styles/   设计系统落地
│   ├── executor-node/           Node.js 执行器（Express，:8002）
│   ├── executor-python/         Python 执行器（FastAPI，:8001）
│   ├── executor-desktop/        Electron 桌面执行器（main/renderer）
│   ├── registry-npm/            Verdaccio 配置（config.yaml）
│   └── registry-pypi/           自建 PyPI 服务（FastAPI）
├── packages/                    ← 可复用包（10 个）
│   ├── acf-cli/                 `acf` 命令行工具（Commander.js）
│   ├── mcp-server/              MCP Server：AI Agent 管理任务（12+ 工具）
│   ├── autoflow-sdk/            Python 任务 SDK（httpx）
│   ├── autocodeflow-node-sdk/   Node.js 任务 SDK（axios，已发布 npm）
│   ├── autocodeflow-ai/         AI 分析引擎（Python）
│   ├── autocodeflow-db/         数据库连接工具（Python）
│   ├── autocodeflow-http/       HTTP 客户端封装（Python）
│   ├── autocodeflow-notify/     多通道通知发送（Python）
│   ├── contract-fixtures/       跨端契约夹具（contract.json）
│   └── docs-site/               文档站
├── examples/
│   └── desktop-automation/      RPA 示例任务（浏览器/GUI/文件/系统集成）
├── design-system/               设计系统规范
├── infra/                       本地开发基础设施 compose
├── config/                      共享配置
├── scripts/                     自测脚本 / 种子数据 / 压测（demo-seed、load-test、
│                                bug18-registry、arch31-*、qa05-callback-tier 等）
├── docs/                        项目文档（本 atlas 目录也在其下）
├── .github/                     CI workflows
├── docker-compose.yml           生产/staging 全量部署
├── deploy.sh · dev.sh · start-dev.sh · init-db.sh
├── Makefile                     常用命令快捷入口
├── e2e-full.spec.js             Playwright 全链路 E2E（根目录）
├── e2e-ui09-mobile.spec.js      移动端 UI E2E
├── .env.example                 环境变量模板（根级，compose 用）
├── AGENT_HANDOFF.md             多会话代理交接快照（148KB，历史沉淀）
└── pytest.ini · playwright.e2e.config.js · release-please-config.json
```

## 目录分类心法

| 类别 | 位置 | 特点 |
|---|---|---|
| 部署单元 | `apps/*` | 各自独立安装依赖、独立测试/构建命令，互不 hoisting（ARCH-20） |
| 复用单元 | `packages/*` | CLI/MCP/SDK/Python 工具库，供任务脚本与外部集成使用 |
| 集成测试 | 根目录 `e2e-*.spec.js` + `scripts/*.selftest.mjs` | 跨服务验证，用 `npm run test:*` 入口 |
| 文档 | `docs/` | 既有专题文档（quickstart/deployment/...）+ 本 atlas 图谱 |

## 注意事项

- 根 `package.json` 不装依赖，只做**命令转发**（`cd <app> && npx ...`），依赖在各 app/package 内独立安装。
- `node_modules` 同时出现在根目录和各子包目录，根目录的多为自测脚本依赖。
- `AGENT_HANDOFF.md` 是多会话协作的交接快照，体量大，**不要**当作代码文档阅读入口；找历史结论用 git log + docs/。
- uploads/ 目录是运行时上传产物（本地开发），不入库。

## 相关文档

- 各应用细节: [../01-apps/](../01-apps/)
- 包生态: [../02-packages/README.md](../02-packages/README.md)
