# packages/docs-site — AutoCodeFlow SDK 文档站（ECO-05）

VitePress 构建的 SDK 文档站，**独立目录、独立 lockfile**，不进任何运行时
包（vitepress 仅为本项目 devDependency）。

## host 决策（P0-3，ADR 简记）

**裁定：GitHub Pages（项目页）**，部署 workflow =
`.github/workflows/docs-site-deploy.yml`。

- **为何 Pages**：三候选（GitHub Pages / admin-web `/docs/` 独立容器 /
  静态托管）中，Pages 零服务器成本（容器方案要占部署资源 + 反代路由）；
  CI 已有 `docs-site-build` job 做构建与死链验证（`ignoreDeadLinks: false`），
  产物可信；仓库公开，文档站为纯静态 VitePress 产物，无鉴权需求。
- **base 路径**：Pages 项目页 = `https://<owner>.github.io/AutoCodeFlow/`
  子路径，`.vitepress/config.mts` 的 `base: '/AutoCodeFlow/'` 与之对齐
  （换 host 时两处需同步改）；站内链接全部用站点根相对路径，构建时自动拼 base。
- **触发条件**：仅 `main` push 或 `workflow_dispatch` 触发部署；`develop`
  push **不部署**（文档站非发布物，避免每次 push 都上 Pages 制造噪音）。
  PR/push 的构建验证仍由 ci.yml 的 `docs-site-build` 承担。
- **一次性前置**（仓库管理员）：Settings → Pages → Source 选
  「GitHub Actions」。
- **权限**：deploy workflow 声明 `permissions: pages: write, id-token: write`
  （Pages 部署 + OIDC 凭证换取的最小集）。

## 内容来源（重组而非重写）

| 页面 | 来源 |
|------|------|
| `index.md` 首页 | 导航入口，摘要自各页 |
| `getting-started.md` 快速开始 | docs/sdk-guide.md + 双 SDK README 提炼 |
| `sdk-node.md` | packages/autocodeflow-node-sdk/README.md + SDK 源码 |
| `sdk-python.md` | packages/autoflow-sdk/README.md + SDK 源码 |
| `capability-matrix.md` | docs/sdk-guide.md「能力矩阵（ECO-01）」22 项 + 差异裁定 |
| `examples.md` | examples/ 四示例 README 聚合 + 仓库路径跳转 |
| `contract.md` | packages/contract-fixtures/README.md + CallbackItemDto 字段表 |
| `release.md` | docs/sdk-guide.md「版本与发布流程」+ 双 SDK README 发布节 |

**内容纪律**：所有代码块与 API 名从 SDK 源码/既有文档搬运核对（ECO-01
时逐行核对过，ECO-05 重建页时再次核对），不臆造 API；版本号写当前实值
1.0.1。文档站是镜像视图——**内容修改请改源头文档**，再同步到本站。

## 本地运行

```bash
cd packages/docs-site
npm install        # 安装 vitepress（devDependency，仅本目录，独立 lockfile）
npm run dev        # http://localhost:5173 热更新预览
```

## 构建

```bash
npm run build      # 产物 .vitepress/dist/（已被根 .gitignore 的 dist/ 覆盖，不入库）
npm run preview    # 本地预览构建产物
```

构建即验收：VitePress 默认 `ignoreDeadLinks: false`，站内死链会使 build
失败——build 绿即无死链。

## CI

- `.github/workflows/ci.yml` 的 `docs-site-build` job 在 push/PR 时执行
  `sync-check + npm ci && npm run build`（node 24），验证站点可构建、无死链、
  无白屏级错误，并做 DOC-09 同步校验（见下）。
- `.github/workflows/docs-site-deploy.yml` 在 main push / 手动触发时执行
  `sync-check → build → 部署 GitHub Pages`（见上方 host 决策）。

## DOC-09：与仓库源头文档的 drift 同步校验

文档站是源头文档的镜像视图，纪律是「**先改源头，再同步到本站**」。为防
漂移，`scripts/sync-check.mjs`（零依赖 node 脚本）在构建/部署前机检七面
可机检面：

| 判据 | 源头 ↔ 站点 |
|------|------------|
| lockstep 版本号 | 双 SDK/mcp-server manifest + py `__version__` ↔ 站点各页「当前版本」 |
| 截断常量 | SDK 源码 `ERROR_MESSAGE_MAX_LENGTH`/`LOGS_MAX_LENGTH` ↔ 站点「4 KB/512 KB」表述 |
| failureReason 枚举 | admin `ExecutionFailureReason` ↔ py 白名单 ↔ 站点「九类」表述 |
| CallbackItemDto 字段 | admin DTO 源码 ↔ 站点 contract.md 字段表 |
| env 注入表 | docs/sdk-guide.md ↔ 站点 getting-started.md 变量清单 |
| 能力矩阵行 | docs/sdk-guide.md ↔ 站点 capability-matrix.md 逐行比对 +「N 项」表述 |
| 契约面 | contract-fixtures/README.md ↔ 站点 contract.md 四条信封/错误体表述 |

漂移时 exit 1 + 差异清单（CI 红），由人工按清单同步——**不做自动覆盖**
（会破坏站点侧的导航改写、仓库绝对链接等重组痕迹）。自检：
`node scripts/sync-check.selftest.mjs`（tmp 沙箱注入受控漂移，14 例断言）。

```bash
node scripts/sync-check.mjs           # 七面校验（构建/部署前置）
node scripts/sync-check.selftest.mjs  # 校验器自检
```
