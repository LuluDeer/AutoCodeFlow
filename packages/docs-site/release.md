# 版本与发布流程

> 重组自 [docs/sdk-guide.md「版本与发布流程」](https://github.com/LuluDeer/AutoCodeFlow/blob/develop/docs/sdk-guide.md)
> 与双 SDK README「版本与发布」节。

## 版本矩阵（当前 1.2.0）

三包走 **lockstep 单版本线**（版本号一致、同批发布）：

| 包 | 注册表 | 当前版本 | 版本元数据单一来源 |
|----|--------|---------|-------------------|
| `@autocodeflow/sdk` | npm（scoped 公开包） | **1.2.0** | `packages/autocodeflow-node-sdk/package.json` |
| `autoflow-sdk` | PyPI | **1.2.0** | `packages/autoflow-sdk/pyproject.toml`（+ `autoflow_sdk.__version__`） |
| `autocodeflow-mcp-server` | npm | **1.2.0** | `packages/mcp-server/package.json` |

> `acf-cli` 暂不发布：npm 上 `acf-cli` 名称已被第三方占用，需先改名
> （如 `@autocodeflow/cli`——勿用 `@autoflow/*`，该 org 已被抢注）再加入
> 发布矩阵（当前包内 version `1.0.0`，不参与 lockstep 校验）。

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
git tag v1.2.0 && git push origin v1.2.0
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
