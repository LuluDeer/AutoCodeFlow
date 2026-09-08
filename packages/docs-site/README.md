# packages/docs-site — AutoCodeFlow SDK 文档站（ECO-05）

VitePress 构建的 SDK 文档站，**独立目录、独立 lockfile**，不进任何运行时
包（vitepress 仅为本项目 devDependency）。托管位置留后续决策——当前只做
本地/CI 构建验证，不部署。

## 内容来源（重组而非重写）

| 页面 | 来源 |
|------|------|
| `index.md` 首页 | 导航入口，摘要自各页 |
| `getting-started.md` 快速开始 | docs/sdk-guide.md + 双 SDK README 提炼 |
| `sdk-node.md` | packages/autocodeflow-node-sdk/README.md + SDK 源码 |
| `sdk-python.md` | packages/autoflow-sdk/README.md + SDK 源码 |
| `capability-matrix.md` | docs/sdk-guide.md「能力矩阵（ECO-01）」23 项 + 差异裁定 |
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

`.github/workflows/ci.yml` 尾部的 `docs-site-build` 轻量 job 在 push/PR
时执行 `npm ci && npm run build`（node 24），验证站点可构建、无死链、
无白屏级错误；**不做部署**（host 决策留后，见 release.md）。
