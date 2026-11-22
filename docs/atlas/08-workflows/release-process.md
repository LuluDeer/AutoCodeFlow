# 发版流程（lockstep 单版本线 + 桌面独立线 + 部署）

> 所属: docs/atlas/08-workflows · 最后核对: 2026-11-22 · 对应代码: .github/workflows/release.yml、.github/workflows/release-please.yml、.github/workflows/release-desktop.yml、release-please-config.json、release-please-manifest.json、version.txt、docs/release-checklist.md

本文按三个发版 workflow 与配置文件的真实内容撰写（2026-11-22 核对）。走平台 4 包 lockstep 单版本线（当前 `v2.x`）的是：

| 包 | 目录 | 版本落点 |
|---|---|---|
| `@autocodeflow/sdk` | `packages/autocodeflow-node-sdk/` | `package.json` + 其 `package-lock.json`（两个 version 槽位） |
| `@autocodeflow/cli` | `packages/acf-cli/` | `package.json` + 其 `package-lock.json` |
| `autocodeflow-mcp-server` | `packages/mcp-server/` | `package.json` + 其 `package-lock.json` |
| `autoflow-sdk` | `packages/autoflow-sdk/` | `pyproject.toml` + `autoflow_sdk/__init__.py` 的 `__version__` |

外加根 `package.json`/`package-lock.json`、文档面：`packages/docs-site/{release,sdk-node,sdk-python,getting-started,index}.md` 与 `docs/sdk-guide.md`。

**lockstep 规则**：四包走**单一版本线**。`release-please-config.json`
只有**一个 root 条目（`.`）**承担 `2.x` 平台版本线——`include-component-in-tag: false`
使 tag 形态为裸 `vX.Y.Z`，其余全部版本承载文件由该条目的 `extra-files` **广播**写入。
`release-please-manifest.json` 的 `"."` 即该线基线（`version.txt` 是其事实源，当前 `2.3.0`）。

> 此前用「每包一个条目 + `linked-versions` 插件」的形态在本仓**结构性失效**
> （顶层键被静默丢弃 → 写进 `plugins` 后又被 `include-component-in-tag: false`
> 导致的 `getComponent() === ''` 挡在 `preconfigure()` 之外 → 组员匹配为 0 →
> 版本统一永不执行 → 反复人工补齐）。详见
> `scripts/check-release-config.mjs` 头部与 `.github/workflows/release-please.yml`。

四个仓内 py-libs（`autocodeflow-http/ai/db/notify`，当前 `0.3.2`）是**独立的**
`linked-versions` 组，逐包开 `include-component-in-tag: true`，tag 形态为
`autocodeflow-http-v0.3.2`——**带 component 前缀，退出 `v*` 命名空间**，因此
不会误触发 `release.yml`（它们不在任何公共 publish job 内）。

**桌面端独立发布线**：`apps/executor-desktop` 不参与上述 4 包 lockstep，采用独立版本线（当前 `1.12.0`）与独立 tag `desktop-vX.Y.Z`，由 `.github/workflows/release-desktop.yml` 负责构建三平台安装包与 `latest*.yml` 并发布为 GitHub Release `latest`。

## 前置条件

- GitHub 侧已配置：Settings → Environments → 新建名为 `release` 的 environment → Required reviewers 指定审批人（未配置时 GitHub 会**隐式放行**审批闸，等于没有人工把关）。
- 仓库 secret：`NPM_TOKEN`（npmjs）、`RELEASE_PLEASE_TOKEN`（PAT，给 release-please 级联触发 tag 用）。
- **PyPI Trusted Publishing（OIDC）**：`autoflow-sdk` 已迁移至 OIDC（`permissions: id-token: write`），不再需要长期 `PYPI_API_TOKEN`；需确保 pypi.org 已为 `autoflow-sdk` 登记 Trusted Publisher（Owner=`LuluDeer`、Repo=`AutoCodeFlow`、Workflow=`release.yml`、Environment=`release`，详见 `docs/release-checklist.md` §4.2.1）。
- 已读：[../06-infra/deployment-and-ci.md](../06-infra/deployment-and-ci.md)、仓库根 `docs/sdk-guide.md`「版本与发布流程」。

## 步骤

### 1. 日常自动化线（release-please）

1. 往 `main` push（触发 `.github/workflows/release-please.yml` 的 `release-please` job，`googleapis/release-please-action` SHA 钉死）。
2. 若有可发布变更（中文 conventional commits：`feat:`/`fix:`…），release-please 开/更新 **Release PR**：bump 版本 + 生成/追加根级 `CHANGELOG.md`。
3. **无需人工核对版本对齐**：版本号只有一个来源（root 条目），全部落点在同一个 Release PR 内被写入。`npm run check:release-config` 会在 CI 里机检广播面完整性，漏配即红。
4. 合并后 release-please 打 tag `vX.Y.Z` 并建 GitHub Release；**tag push 恰好触发 release.yml**。
5. 关键依赖：`RELEASE_PLEASE_TOKEN` 必须是 PAT——GitHub 抑制 `GITHUB_TOKEN` 产生的 tag 事件，2026-09-11 v1.1.1 实测过"tag 已生成、release.yml 零 run"。secret 缺失/失效时的恢复 = **人工重推 tag**（见步骤 2）。

### 2. 发布线（release.yml，由 `v*` tag push 触发）

job 依赖链（真实 job 名）：`version-guard` → `publish-npm` / `publish-pypi`（两者均 `needs: version-guard`，互不依赖）→ `demote-sdk-release`。

1. **version-guard**：Python 脚本校验 tag `v(X.Y.Z[-pre])` 与 **6 处版本**逐一相等——`version.txt`、三个 npm `package.json`（`@autocodeflow/sdk`、`@autocodeflow/cli`、`autocodeflow-mcp-server`）、`pyproject.toml`、`autoflow_sdk/__init__.py`。任一不等 → fail，拒绝发布。
2. **environment: release 审批闸**：`publish-npm` 与 `publish-pypi` 都挂 `environment: release`，停在 waiting 直到审批人 Approve。
3. **publish-npm**（matrix **3 项**：`@autocodeflow/sdk`、`@autocodeflow/cli`、`autocodeflow-mcp-server`）：`npm ci` → `npm run build` → `npm publish --access public --dry-run` 结构校验 → `npm publish --access public`（node 24 + `secrets.NPM_TOKEN`）。
4. **publish-pypi**：`python -m build`（sdist+wheel）→ `pypa/gh-action-pypi-publish` 经 **OIDC Trusted Publishing**（`permissions: id-token: write`）发布 `packages/autoflow-sdk/dist/`。
5. **demote-sdk-release**：将 `v*` 对应的 GitHub Release 标为 `prerelease`，防止抢占 GitHub `/releases/latest` 导致桌面端 `electron-updater` 报 404。

**紧急人工重推 tag 路径**（仅在 `RELEASE_PLEASE_TOKEN` 失效导致 tag 未级联触发时）：

```bash
# 确认 6 处版本已通过 Release PR 对齐后：
git tag v<version> && git push origin v<version>
```

release.yml 故意不配 `workflow_dispatch`（防误触发真发布）；本地演练用 `npm publish --dry-run` / `python -m build`。

### 3. 桌面端独立发布线（release-desktop.yml，由 `desktop-v*` tag 触发）

```bash
# 更新 apps/executor-desktop/package.json（及 lockfile）并合入 main 后：
git tag desktop-v<version> && git push origin desktop-v<version>
```

- `desktop-version-guard` 校验 tag 与 `apps/executor-desktop/package.json` 版本逐字相等；
- 三平台原生 runner 构建 Windows (`.exe` + `latest.yml`)、macOS (`x64`/`arm64` `.dmg` + `latest-mac.yml`)、Linux (`.AppImage` / `.deb` + `latest-linux.yml`) 与 `SHA256SUMS.txt`，自动发布至 GitHub Release 并作为 `/releases/latest`。

### 4. 幂等与恢复（N44 语义，读一遍能省一次事故）

- 版本号一经发布**不可复用**：同版本重发 npm 报 `EP409`、PyPI 回 400（File already exists）。
- 失败恢复的标准路径：**修复后 `gh run rerun <run-id> --failed`**——只重跑失败的 publish job，environment 审批需重新 Approve。
- 仅当需要更换 tag 指向内容时才删 tag 重打，且已发布成功的一侧必须 bump 版本换新 tag；此时该侧重跑报红是**幂等保护，不是回归**。

### 5. 部署与发版后核对

仓库根 `docs/release-checklist.md` 是部署与发版权威清单（Phase 1 发版前 `typecheck:all` / `lint:all` / 备份 → Phase 2 `./deploy.sh --mode source|docker --env production --build` + `docker compose exec admin-api npm run migration:run:prod` → Phase 3 健康验证 → Phase 4 核对 4 包上架、OIDC 发布与桌面 `/releases/latest` 未被抢占）。Docker 镜像发布未启用，multi-arch 以 CI `docker-multiarch-build` job 构建校验为准。

## 验收清单

- [ ] Release PR 合并前 6 处版本一致（`version.txt`、3 个 npm `package.json`、`pyproject.toml`、`__init__.py`），`npm run check:release-config` 全绿
- [ ] tag 为裸 `vX.Y.Z`（`include-component-in-tag: false` 保证；version-guard 用 `re.fullmatch(r"v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)")` 校验，其他形态直接拒）
- [ ] `release` environment 已配置 Required reviewers，且审批通过
- [ ] npmjs（3 包）与 PyPI（`autoflow-sdk`）上能查到新版本；根 `CHANGELOG.md` 已自动更新
- [ ] `gh api repos/LuluDeer/AutoCodeFlow/releases/latest --jq .tag_name` 仍指向 `desktop-v*`（未被 `v*` 抢占）
- [ ] 部署侧按 `docs/release-checklist.md` Phase 3 验证通过（`curl http://localhost:3105/api/health/live` 与 `migration:run:prod`）

## 常见坑

- **手动改了部分包版本但漏同步**：`version-guard` 6 处检查与 `check:release-config` 会直接红；应走 `release-please` 单一 root 条目广播。
- **`RELEASE_PLEASE_TOKEN` 未配**：Release PR/tag 能建但不级联触发发布，表现为"tag 有了、Actions 没 run"——人工 `git push origin v<version>` 重推即可触发。
- **取消 `v*` Release 的 `prerelease` 标记**：会立即抢占 `/releases/latest` 导致全量桌面端自动更新 404，必须保持 `v*` 为 `prerelease`。
- **同版本重发**：先读上面第 4 节再动手，不要删包强推。
- **改了 API 契约就发版**：先确认 `openapi.json` / `api-types.ts` 已重新导出（CI `api-types-drift` 闸），SDK 契约变更还要过 [add-new-sdk-capability.md](add-new-sdk-capability.md) 第 4 步的 contract-fixtures 评估。

## 相关文档

- [../06-infra/deployment-and-ci.md](../06-infra/deployment-and-ci.md) · [../02-packages/autoflow-sdk.md](../02-packages/autoflow-sdk.md) · [../02-packages/mcp-server.md](../02-packages/mcp-server.md)
- [add-new-sdk-capability.md](add-new-sdk-capability.md) · 仓库根 `docs/release-checklist.md`、`docs/sdk-guide.md`
