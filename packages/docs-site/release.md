# 版本与发布流程

> 重组自 [docs/sdk-guide.md「版本与发布流程」](https://github.com/LuluDeer/AutoCodeFlow/blob/develop/docs/sdk-guide.md)
> 与双 SDK README「版本与发布」节。

## 版本矩阵

<!-- x-release-please-version -->
当前 lockstep 版本 **1.5.1**，三包版本号一致、同批发布：<!-- x-release-please-version -->

| 包 | 注册表 | 当前版本 | 版本元数据单一来源 |
|----|--------|---------|-------------------|
| `@autocodeflow/sdk` | npm（scoped 公开包） | **1.5.1**<!-- x-release-please-version --> | `packages/autocodeflow-node-sdk/package.json` |
| `autoflow-sdk` | PyPI | **1.5.1**<!-- x-release-please-version --> | `packages/autoflow-sdk/pyproject.toml`（+ `autoflow_sdk.__version__`） |
| `autocodeflow-mcp-server` | npm | **1.5.1**<!-- x-release-please-version --> | `packages/mcp-server/package.json` |

> `@autocodeflow/cli` 已改名并接入发布链路（原 `acf-cli` 包名被 npm 第三方
> 占用；勿用 `@autoflow/*`，该 org 已被抢注）。它与另三包同处 lockstep 组，
> 当前包内 version `1.4.3`。

## 发布管道

发布**只由 push tag `vX.Y.Z` 触发**
[.github/workflows/release.yml](https://github.com/LuluDeer/AutoCodeFlow/blob/develop/.github/workflows/release.yml)：

1. **version-guard**：校验 tag 与各包 `package.json` / `pyproject.toml` /
   `__init__.py` 的 version 完全一致，不一致即 fail（无
   `workflow_dispatch`，杜绝手动误触发真发布）；
2. **publish-npm / publish-pypi** 并行发布（各自先跑 `npm publish
   --dry-run` / `python -m build` 结构校验），并经 GitHub
   `environment: release` 人工审批闸门。

凭证：GitHub secret `NPM_TOKEN`（node 24）/ `PYPI_API_TOKEN`（python 3.12）。

## 标准发布步骤

```bash
# 1) 三包 version 同批 bump（package.json ×2 + pyproject.toml + __init__.py）
# 2) 提交后打 tag
git tag v1.4.4 && git push origin v1.4.4
# 3) GitHub Actions → release.yml → version-guard → 人工 Approve → publish
```

## tag 级联前提（2026-09-11 实测修正）

release-please 打 tag 使用 `secrets.RELEASE_PLEASE_TOKEN || github.token`。GitHub
抑制所有由 `GITHUB_TOKEN` 产生的事件（含 `on: push: tags`）以防递归，故**未配置
`RELEASE_PLEASE_TOKEN` 时 tag 不会触发 release.yml**（实测：tag 已生成、Release
流水线零 run）。因此需一次性配置仓库 secret `RELEASE_PLEASE_TOKEN`
（fine-grained PAT：Contents read/write + Pull requests read/write）；未配置时的
恢复路径是以人工凭据重推同名 tag（内容不变且尚未发布任何产物时安全）。

## 幂等与恢复

- 版本号**一经发布即不可复用**：同版本重发 npm 必报 EP409、PyPI 必回
  400（File already exists），发布链无覆盖逻辑。
- 发布部分失败后的标准恢复路径：修复后
  `gh run rerun <run-id> --failed`——只重跑失败的 publish job，已成功的
  job 与 version-guard 不重跑（审批门需重新 Approve）。
- 仅当需要更换 tag 指向的内容时才删 tag 重打，且**已发布成功的一侧必须
  bump 版本换新 tag**（详见 release.yml 头注释）。

## 桌面端独立发布（N47 解耦，round-14 起）

桌面端安装包（`apps/executor-desktop`）**不参与上面 SDK 的 lockstep**，独立发布：

- **独立 workflow**：`.github/workflows/release-desktop.yml`
- **独立 trigger**：push tag `desktop-vX.Y.Z`（区别于 SDK 的 `vX.Y.Z`）
- **守卫**：`desktop-version-guard` 校验 `desktop-v<ver>` 里的 `<ver>` 与
  `apps/executor-desktop/package.json` 的 `version` 一致
- 三平台出包并上传到 `desktop-v<ver>` 命名的 GitHub Release（electron-updater
  通过 `latest*.yml` 的 version 决定可更新性，不依赖 tag 名形态）

```bash
# 桌面版 hotfix / 小版本发布（不会连带 bump / 重发 npm/PyPI SDK）
cd apps/executor-desktop
# 1) bump apps/executor-desktop/package.json 到新版本
# 2) 提交后打独立 tag
git tag desktop-v1.4.4 && git push origin desktop-v1.4.4
# 3) GitHub Actions → release-desktop.yml → 守卫 + 三平台出包 + 上传
```

> 解耦动机（round-14）：此前桌面与 SDK 共用 lockstep + 单一 `v*` tag，任何
> **纯桌面 hotfix**（如 v1.4.3 的窗口不可见）都会连带 bump 并重发未变动的
> npm/PyPI SDK。解耦后桌面独立 tag 只发安装包，SDK 版本线不受影响。

## 本地演练（不真发布）

```bash
# node 包
cd packages/autocodeflow-node-sdk
npm run build && npm publish --access public --dry-run

# python 包（产物 dist/ 已 gitignore）
cd packages/autoflow-sdk
python -m pip install build && python -m build --wheel
```

## 本文档站的构建与发布

文档站（`packages/docs-site`）为独立 VitePress 站点，与 SDK 包版本解耦
（本包 version 跟随 lockstep 但不发布）。

- **host（P0-3 裁定）**：GitHub Pages 项目页
  （`https://<owner>.github.io/AutoCodeFlow/`），`base: '/AutoCodeFlow/'`
  已在 `.vitepress/config.mts` 对齐；ADR 简记见本目录 README.md。
- **部署**：`.github/workflows/docs-site-deploy.yml`——仅 main push /
  workflow_dispatch 触发（develop push 不部署），官方三件套
  configure-pages / upload-pages-artifact / deploy-pages，前置跑
  DOC-09 sync-check（源头文档漂移时拦截部署）。
- **CI 验证**：ci.yml `docs-site-build` 在 push/PR 时跑
  sync-check + build（死链会 fail build）。

```bash
cd packages/docs-site
npm install        # vitepress 为 devDependency，仅本目录
npm run build      # 产物 .vitepress/dist/（已 gitignore）
npm run preview    # 本地预览构建产物
```
