# docs-site — SDK 文档站

> 所属: docs/atlas/02-packages · 最后核对: 2026-09-13 · 对应代码: packages/docs-site

## 职责

npm 包 `autocodeflow-docs-site`（v1.0.1，**private**，不发布）：面向 SDK 用户的 **VitePress 文档站**（ECO-05/P0-3），覆盖双 SDK（Node/Python）快速开始、教程、能力矩阵、示例库、回调契约与发布流程。部署在 **GitHub Pages 项目页**：`https://<owner>.github.io/AutoCodeFlow/`。

技术栈（package.json 核实）：`vitepress ^1.6.4`（唯一 devDependency），站点语言 `zh-CN`。

## 目录结构与关键文件

```
packages/docs-site/
├── package.json             scripts: dev / build / preview（vitepress 三件套）
├── .vitepress/config.mts    base: '/AutoCodeFlow/'、nav/sidebar、ignoreDeadLinks: false
├── index.md … release.md    站点源页面（共 14 个 .md）
│   ├── getting-started.md   快速开始（5 分钟）
│   ├── tutorial-01..04*.md  教程：第一个任务 / 私服依赖 / 多执行器扩容 / 告警接入（DOC-06）
│   ├── sdk-node.md / sdk-python.md        双 SDK 参考
│   ├── capability-matrix.md 能力矩阵（ECO-01）
│   ├── examples.md          官方示例库（重组自 examples/*/README.md）
│   ├── contract.md          回调与信封契约（重组自 packages/contract-fixtures/README.md）
│   └── release.md           版本与发布流程
├── scripts/
│   ├── sync-check.mjs       DOC-09 漂移校验：站点内容 vs 仓库源头文档（版本号/端点/契约面）
│   └── sync-check.selftest.mjs
└── .vitepress/dist/         构建产物（已提交在库内）
```

**内容纪律**（config.mts 头部声明）：所有页面为既有文档的**重组而非重写**——源头是 `docs/sdk-guide.md`、双 SDK README、`examples/` 与 `packages/contract-fixtures/README.md`；仓库相对链接（`../` 前缀）指向 GitHub 仓库路径，站内互链用站点根相对路径。`README.md` 被 `srcExclude`（仅入库说明，不作为站点路由）。

## 构建命令

```
cd packages/docs-site
npm ci
npm run dev        # 本地开发（同 /AutoCodeFlow/ 子路径服务）
npm run build      # 构建（ignoreDeadLinks:false，死链即构建失败）
npm run preview    # 本地预览构建产物
```

根目录快捷方式：`npm run build:docs-site`。CI 构建与死链验证由 ci.yml 的 `docs-site-build` job 承担（先跑 `scripts/sync-check.mjs` + selftest 再构建，DOC-09：站点内容与仓库源头文档漂移时**拦截构建/部署**）。

## 部署方式（.github/workflows/docs-site-deploy.yml 核实）

- **宿主裁定**：GitHub Pages（ADR 简记）——零服务器成本、CI 已验证构建、仓库公开无鉴权需求。
- **触发**：仅 `push main` 或手动 `workflow_dispatch`；develop push 不部署（文档站非发布物，避免噪音）。
- **流程**：checkout → setup-node 24（缓存 packages/docs-site/package-lock.json）→ **DOC-09 sync-check**（漂移即拦）→ `npm ci` → `npm run build` → `configure-pages`/`upload-pages-artifact`/`deploy-pages`（Pages 官方三件套，权限 `pages: write` + `id-token: write`，environment `github-pages`）。
- **一次性前置**：仓库 Settings → Pages → Source 选 "GitHub Actions"。
- **base 一致性**：项目页部署在 `/AutoCodeFlow/` 子路径，`.vitepress/config.mts` 的 `base: '/AutoCodeFlow/'` 必须与之对齐（两处之一改动即白屏 404）；并发组互斥防产物交错覆盖。

## 与其他组件的关系

- **内容来源**：[autoflow-sdk](autoflow-sdk.md)、[autocodeflow-node-sdk](autocodeflow-node-sdk.md) 的 README 与能力矩阵、[contract-fixtures](contract-fixtures.md) 的 README、`examples/`、`docs/sdk-guide.md`——改这些源头时**必须**过 `sync-check`（版本号/端点/契约面漂移会被 CI 拦下）。
- **独立性**：纯静态构建产物，不进任何运行时包、不被其他包依赖；版本 1.0.1 与三包 lockstep 无关。
- **发布链路**：与 [release.yml](../08-workflows/release-process.md) 无耦合；只跟 main 分支走。

## 站点页面清单与信息源对照

| 页面 | 内容来源（重组自） |
|---|---|
| index.md | 站点首页，链接各板块 |
| getting-started.md | docs/sdk-guide.md 快速开始部分 |
| tutorials.md + tutorial-01..04*.md | DOC-06 教程系列（第一个任务 / 私服依赖 / 多执行器扩容 / 告警值班） |
| sdk-node.md / sdk-python.md | packages/autocodeflow-node-sdk、packages/autoflow-sdk 各自 README |
| capability-matrix.md | ECO-01 双 SDK 能力矩阵（docs/sdk-guide.md） |
| examples.md | examples/*/README.md 官方示例库索引 |
| contract.md | packages/contract-fixtures/README.md（回调与信封契约） |
| release.md | docs/sdk-guide.md「版本与发布流程」（lockstep 三包） |

侧边栏分组（config.mts）：上手 / 教程 / SDK 参考 / 对照与示例 / 契约与发布。

## 常见改动场景

- **加一个页面**：根目录新增 `.md` → `config.mts` 的 nav/sidebar 挂链接 → 本地 `npm run dev` 验证 → 若页面引用仓库内数字（版本、端点），在 `scripts/sync-check.mjs` 登记判据（DOC-09 才能守护它）。
- **改 base/站点元信息**：只动 `config.mts`；改 `BASE_PATH` 必须同步 Pages 项目页路径认知（两处强绑定）。
- **源头文档更新后站点报漂移**：跑 `node packages/docs-site/scripts/sync-check.mjs` 看判据输出，按提示更新站点页面对应数字/段落——**先改源头文档，再同步镜像页面**。

## 相关文档

- [包生态总览](README.md) · [契约夹具](contract-fixtures.md) · [发版流程](../08-workflows/release-process.md)
- [部署与 CI](../06-infra/deployment-and-ci.md) · [仓库目录树](../00-overview/03-repo-layout.md)
