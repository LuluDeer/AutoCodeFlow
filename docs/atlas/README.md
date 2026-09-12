# AutoCodeFlow 项目图谱（Atlas）

> 定位：本目录是对 AutoCodeFlow 全项目的**结构 / 功能 / 关系**彻底拆解，采用"一棵树、多个小文件"的组织方式，服务于四个场景：
> 1. **功能开发** — 改某个模块前先读对应文档，知道上下游影响面
> 2. **后续拓展** — 每篇文档都有"常见改动场景"，照着做即可
> 3. **问题记录** — `08-workflows/troubleshooting/` 提供规范与模板，按模板沉淀问题
> 4. **任务分配** — `08-workflows/task-board/` 提供任务卡模板；本文档树本身即可作为分工边界

## 文档树总览

```
docs/atlas/
├── README.md                          ← 本文件：索引与使用说明
├── 00-overview/                       ← 全局总览（先读这里）
│   ├── 01-product-overview.md         产品定位、能力地图、术语表
│   ├── 02-system-architecture.md      总体架构、组件关系、数据流
│   ├── 03-repo-layout.md              仓库目录树逐目录职责
│   ├── 04-tech-stack.md               技术栈与运行时要求
│   └── 05-core-concepts.md            领域核心概念（Task/Execution/Executor/...）
├── 01-apps/                           ← 7 个应用逐一拆解
│   ├── admin-api/                     NestJS 后端（含 modules/ 每模块一篇）
│   ├── admin-web/                     React 管理前端（含 pages/ 分组拆解）
│   ├── executor-node/                 Node.js 执行器
│   ├── executor-python/               Python 执行器
│   ├── executor-desktop/              Electron 桌面执行器
│   ├── registry-npm.md                Verdaccio 私有 npm 仓库
│   └── registry-pypi/README.md        自建 PyPI 私有仓库
├── 02-packages/                       ← packages/ 下全部可复用包
│   ├── README.md                      包生态总览与依赖关系
│   ├── acf-cli.md · mcp-server.md · autoflow-sdk.md · autocodeflow-node-sdk.md
│   ├── python-libs/                   ai / db / http / notify 四个 Python 库
│   ├── contract-fixtures.md · docs-site.md
├── 03-data/                           ← 数据层：实体逐一拆解 + 迁移机制
├── 04-flows/                          ← 跨服务关键流程（时序图）
│   ├── task-lifecycle.md              任务从创建到执行完成的全链路
│   ├── executor-registration.md       执行器注册 / 心跳 / 身份
│   ├── execution-callback.md          回调 / 日志 / 产物上报
│   ├── approval-flow.md               MCP 审批流（DEP-04）
│   ├── notification-flow.md           通知链路
│   └── security-model.md              认证与信任链
├── 05-interfaces/                     ← 对外接口地图（REST/MCP/CLI/SDK）
├── 06-infra/                          ← 部署、compose、CI、环境变量
├── 07-testing/                        ← 测试策略、各应用测试、E2E 与自测脚本
└── 08-workflows/                      ← 面向"人"的工作流
    ├── add-new-api-module.md          如何新增一个后端模块
    ├── add-new-web-page.md            如何新增一个前端页面
    ├── add-new-sdk-capability.md      如何扩展 SDK
    ├── release-process.md             发版流程
    ├── troubleshooting/               问题记录：README（规范）+ TEMPLATE + known-issues
    └── task-board/                    任务分配：README（规范）+ TEMPLATE
```

## 推荐阅读路线

| 你是谁 | 路线 |
|---|---|
| 新人第一次接触 | `00-overview/01` → `00-overview/02` → `00-overview/05` → `04-flows/task-lifecycle` |
| 要改后端某模块 | `00-overview/05` → `03-data/entities/对应实体` → `01-apps/admin-api/modules/对应模块` → `04-flows/相关流程` |
| 要加前端页面 | `01-apps/admin-web/README` → `08-workflows/add-new-web-page` |
| 要排查线上问题 | `07-testing` → `08-workflows/troubleshooting/README`（按模板记录） |
| 要发新版本 | `08-workflows/release-process` → `06-infra/deployment-and-ci` |
| AI Agent / 子代理接任务 | 从 `08-workflows/task-board/` 领任务卡 → 按卡内"涉及文档"链接先读后做 |

## 维护规则（重要）

1. **小文件原则**：单篇文档建议 80–200 行。超过 200 行就按子主题拆新文件，并在父文档里挂链接。
2. **谁改动谁更新**：改动某模块代码时，同步更新 `docs/atlas` 下对应文档的"最后核对"日期；发现文档与代码不符，以代码为准并立即修文档。
3. **禁止编造**：所有路径、命令、接口必须与仓库实际内容一致；暂时没核实的写 `> ⚠️ 待核实`，不要猜。
4. **关系必须双向**：A 文档说"依赖 B"，B 文档应有对应的"被依赖"说明。新增文档后检查双向链接。
5. **问题记录入 `08-workflows/troubleshooting/`**：按 TEMPLATE 建独立文件，命名 `YYYY-MM-DD-<简短 slug>.md`，解决后回填"结论"。
6. **任务分配入 `08-workflows/task-board/`**：每张任务卡一个文件，状态写在卡内（backlog / in-progress / done）。

## 生成与核对记录

- 2026-09-13：首次生成整棵文档树（123 篇）。由主控拆批、**11 个批次子代理串行生成**（atlas-01～11，每批一次一个子代理），全部经源码逐篇核实；主控收口时全树 1065 个相对链接 0 死链。各篇文档头部均标注"最后核对"日期与对应代码路径。
- 规划之外按实际需要增设：`01-apps/executor-contract.md`（执行器协议契约）、`01-apps/executors-comparison.md`（三执行器对比）、`03-data/er-core.md`（核心域 ER）、`08-workflows/onboarding.md`（新人上手路径）。
