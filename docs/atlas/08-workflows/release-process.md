# 发版流程（lockstep 单版本线 + 部署）

> 所属: docs/atlas/08-workflows · 最后核对: 2026-10-08 · 对应代码: .github/workflows/release.yml、.github/workflows/release-please.yml、release-please-config.json、release-please-manifest.json、version.txt、docs/release-checklist.md

本文按两个 workflow 与配置文件的真实内容撰写（2026-10-08 根治轮核对）。走 lockstep 单版本线的包是：

| 包 | 目录 | 版本落点 |
|---|---|---|
| `@autocodeflow/sdk` | `packages/autocodeflow-node-sdk/` | `package.json` + 其 `package-lock.json`（两个 version 槽位） |
| `autocodeflow-mcp-server` | `packages/mcp-server/` | `package.json` + 其 `package-lock.json` |
| `@autocodeflow/cli` | `packages/acf-cli/` | `package.json` + 其 `package-lock.json` |
| `autoflow-sdk` | `packages/autoflow-sdk/` | `pyproject.toml` + `autoflow_sdk/__init__.py` 的 `__version__` |

外加文档面：`packages/docs-site/{release,sdk-node,sdk-python,getting-started,index}.md` 与 `docs/sdk-guide.md`。

**lockstep 规则（2026-10 根治后）**：四包走**单一版本线**。`release-please-config.json`
只有**一个 root 条目（`.`）**承担 1.x 版本线——`include-component-in-tag: false`
使 tag 形态为裸 `vX.Y.Z`，其余全部版本承载文件由该条目的 `extra-files` **广播**写入。
`release-please-manifest.json` 的 `"."` 即该线基线（`version.txt` 是其事实源）。

> 此前用「每包一个条目 + `linked-versions` 插件」的形态在本仓**结构性失效**
> （顶层键被静默丢弃 → 写进 `plugins` 后又被 `include-component-in-tag: false`
> 导致的 `getComponent() === ''` 挡在 `preconfigure()` 之外 → 组员匹配为 0 →
> 版本统一永不执行 → 反复人工补齐）。详见
> `scripts/check-release-config.mjs` 头部与 `.github/workflows/release-please.yml`。

四个 py-libs（`autocodeflow-http/ai/db/notify`，当前 0.2.2）是**独立的**
`linked-versions` 组，逐包开 `include-component-in-tag: true`，tag 形态为
`autocodeflow-http-v0.2.2`——**带 component 前缀，退出 `v*` 命名空间**，因此
不会误触发 `release.yml`（历史实证：PR #29 同批产出 `v1.7.0` 与 `v0.2.2`，
后者触发 release.yml 并在 version-guard 上失败）。它们不在任何 publish job 内。

## 前置条件

- GitHub 侧已配置：Settings → Environments → 新建名为 `release` 的 environment → Required reviewers 指定审批人（未配置时 GitHub 会**隐式放行**审批闸，等于没有人工把关）。
- 仓库 secret：`NPM_TOKEN`（npmjs）、`PYPI_API_TOKEN`（pypi.org）、`RELEASE_PLEASE_TOKEN`（PAT，给 release-please 用）。
- 已读：[../06-infra/deployment-and-ci.md](../06-infra/deployment-and-ci.md)、仓库根 `docs/sdk-guide.md`「版本与发布流程」。

## 步骤

### 1. 日常自动化线（release-please）

1. 往 `main` push（触发 `.github/workflows/release-please.yml` 的 `release-please` job，`googleapis/release-please-action@v5.0.0`（SHA 钉死））。
2. 若有可发布变更（中文 conventional commits：`feat:`/`fix:`…），release-please 开/更新 **Release PR**：bump 版本 + 生成/追加 `CHANGELOG.md`。
3. **无需人工核对版本对齐**（2026-10 起）：版本号只有一个来源（root 条目），全部落点在同一个 Release PR 内被写入。`scripts/check-release-config.mjs` 会在 CI 里机检广播面完整性，漏配即红。
4. 合并后 release-please 打 tag `vX.Y.Z` 并建 GitHub Release；**tag push 恰好触发 release.yml**。
5. 关键依赖：`RELEASE_PLEASE_TOKEN` 必须是 PAT——GitHub 抑制 `GITHUB_TOKEN` 产生的 tag 事件，2026-09-11 v1.1.1 实测过"tag 已生成、release.yml 零 run"。secret 缺失/失效时的恢复 = **人工重推 tag**（见步骤 2）。

### 2. 发布线（release.yml，由 `v*` tag push 触发）

job 依赖链（真实 job 名）：`version-guard` → `publish-npm` / `publish-pypi`（两者均 `needs: version-guard`，互不依赖）。

1. **version-guard**：Python 脚本校验 tag `v(X.Y.Z[-pre])` 与四处版本逐一相等——两个 `package.json`、`pyproject.toml`、`autoflow_sdk/__init__.py`。任一不等 → fail，拒绝发布。
2. **environment: release 审批闸**：`publish-npm` 与 `publish-pypi` 都挂 `environment: release`，停在 waiting 直到审批人 Approve。
3. **publish-npm**（matrix 两项：node-sdk、mcp-server）：`npm ci` → `npm run build` → `npm publish --access public --dry-run` 结构校验 → `npm publish --access public`（node 24 + `secrets.NPM_TOKEN`）。
4. **publish-pypi**：`python -m build`（sdist+wheel）→ `pypa/gh-action-pypi-publish` 用 `secrets.PYPI_API_TOKEN` 发布 `packages/autoflow-sdk/dist/`。

**人工 tag 路径**（release-please 不可用/需紧急发布时，release.yml 头注给出的官方流程）：

```bash
# 同步 bump 四处版本并提交 develop/main 后：
git tag v<version> && git push origin v<version>
```

release.yml 故意不配 `workflow_dispatch`（防误触发真发布）；本地演练用 `npm publish --dry-run` / `python -m build`。

### 3. 幂等与恢复（N44 语义，读一遍能省一次事故）

- 版本号一经发布**不可复用**：同版本重发 npm 报 `EP409`、PyPI 回 400（File already exists）。
- 失败恢复的标准路径：**修复后 `gh run rerun <run-id> --failed`**——只重跑失败的 publish job，environment 审批需重新 Approve。
- 仅当需要更换 tag 指向内容时才删 tag 重打，且已发布成功的一侧必须 bump 版本换新 tag；此时该侧重跑报红是**幂等保护，不是回归**。

### 4. 部署与发版后核对

仓库根 `docs/release-checklist.md` 是部署侧权威清单（Phase 1 发版前全量检查/备份 → Phase 2 `./deploy.sh -e production -b` + `docker compose exec admin-api npm run migration:run` → Phase 3 健康验证 → Phase 4 `git tag -a v1.x.x` 打部署 tag）。Docker 镜像发布未启用，multi-arch 以 CI `docker-multiarch-build` job 构建校验为准。

## 验收清单

- [ ] Release PR 合并前四处版本一致（node-sdk/mcp-server `package.json`、`pyproject.toml`、`__init__.py`）
- [ ] tag 为裸 `vX.Y.Z`（`include-component-in-tag: false` 保证；version-guard 用 `re.fullmatch(r"v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)")` 校验，其他形态直接拒）
- [ ] `release` environment 已配置 Required reviewers，且审批通过
- [ ] npmjs / PyPI 上能查到新版本；`packages/*/CHANGELOG.md` 已更新
- [ ] 部署侧按 `docs/release-checklist.md` Phase 3 验证通过（`curl http://localhost:3105/api/health/live`）

## 常见坑

- **手动 bump 三包版本但漏 `__init__.py`**：version-guard 四处检查直接红。
- **`RELEASE_PLEASE_TOKEN` 未配**：Release PR/tag 能建但不级联触发发布，表现为"tag 有了、Actions 没 run"——人工 `git push origin v<version>` 重推即可触发。
- **同版本重发**：先读上面第 3 节再动手，不要删包强推。
- **改了 API 契约就发版**：先确认 `openapi.json` / `api-types.ts` 已重新导出（CI `api-types-drift` 闸），SDK 契约变更还要过 [add-new-sdk-capability.md](add-new-sdk-capability.md) 第 4 步的 contract-fixtures 评估。

## 相关文档

- [../06-infra/deployment-and-ci.md](../06-infra/deployment-and-ci.md) · [../02-packages/autoflow-sdk.md](../02-packages/autoflow-sdk.md) · [../02-packages/mcp-server.md](../02-packages/mcp-server.md)
- [add-new-sdk-capability.md](add-new-sdk-capability.md) · 仓库根 `docs/release-checklist.md`、`docs/sdk-guide.md`
