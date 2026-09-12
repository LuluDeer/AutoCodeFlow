# 部署与 CI
> 所属: docs/atlas/06-infra · 最后核对: 2026-09-13 · 对应代码: deploy.sh、.github/workflows/（ci.yml / release.yml / docs-site-deploy.yml / release-please.yml）

## 怎么部署（deploy.sh，129 行）

```bash
./deploy.sh -e production -b        # -e development|staging|production（默认 development）
                                    # -b 重建镜像（build --no-cache）；-d 后台（默认），--no-detach 前台
```

流程：参数解析 → **无 `.env` 则复制 `.env.example` 并 exit 1**（防裸配置上线）→ 校验 docker 与 docker-compose 存在 → `export NODE_ENV=<env>` → `docker-compose down` → （`-b` 时 `build --no-cache`）→ `up [-d]` → sleep 30 → `docker-compose ps` → `curl http://localhost:3105/api/health` 断言响应含 `healthy`（S2：全局前缀 api，非 `/health`）→ 失败时打印 admin-api 日志并退出 1。

## Workflow 文件总览（.github/workflows/，4 个）

| Workflow | 触发 | 作用 |
|---|---|---|
| `ci.yml` | push/PR（main、develop）、手动、月度 cron | 26 个 job 的全量质量门禁（下表） |
| `release.yml` | `push tags v*` | version-guard → npm（@autocodeflow/sdk、autocodeflow-mcp-server）+ PyPI（autoflow-sdk）发布 |
| `release-please.yml` | push main | 汇总 conventional commits → Release PR（bump 三包 + CHANGELOG） |
| `docs-site-deploy.yml` | push main、手动 | VitePress 文档站发布 GitHub Pages（base `/AutoCodeFlow/`） |

## CI 面板（.github/workflows/ci.yml）

- 触发：push/PR 到 `main`、`develop`；`workflow_dispatch`；**月度** `cron: 20 3 1 * *`（QA-08 跨版本迁移演练——schedule 触发时主套件全部 `if: github.event_name != 'schedule'` 旁路，只跑迁移演练相关步骤）。
- 并发组：`ci-${{ github.ref }}`，同分支旧跑自动取消。共 **26 个 job**：

| 分组 | Job（要点） |
|---|---|
| 镜像闸 | `docker-multiarch-build`：admin-api / executor-node / executor-python 三镜像 matrix，`linux/amd64+arm64` **只 build 不 push**（BUG-20） |
| admin-api | `admin-api-test`（PG16+Redis7 services；typecheck+lint+jest coverage+迁移+e2e `--runInBand`）；`admin-api-migrations`（空库全链 25 个迁移 + 二跑幂等守卫；schedule 轮加实体/迁移漂移检查与单步 revert 重跑） |
| Node 包 | `executor-node-test`、`acf-cli-test`、`mcp-server-test`、`autocodeflow-node-sdk-test`（coverage）、`admin-web-build`（lint+build，基线 0 error/5 warning） |
| 安全 | `npm-audit`（5 项目 matrix，moderate 红灯，GHSA 豁免清单 fail-closed）；`lockfile-integrity`（7 项目 `npm ci --dry-run --ignore-scripts` 防锁文件漂移）；`secret-scan`（gitleaks 全量历史） |
| Python | `executor-python-test`、`autoflow-sdk-python-test`、`python-packages-test`（autocodeflow-http/notify/db/ai matrix）、`registry-pypi-test`（均 py3.12） |
| 桌面端 | `desktop-bundle-drift`（ncc 重打 bundle 与入库产物 diff，W-18）；`desktop-linux-bundle`（AppImage+deb，PR/手动）；`desktop-e2e-smoke`（Playwright _electron 3 例，windows，PR/手动） |
| Windows 基线 | `windows-node-tests`（executor-node/acf-cli/mcp-server matrix）、`windows-admin-web` |
| E2E 全链 | `e2e-full`（ubuntu，43 例 Playwright，PG 15432/Redis 16379，`SKIP_DOCKER=1` 走 `scripts/e2e-full.sh`）；`e2e-full-windows`（windows，PR/手动/schedule，预装 PG 服务 + portable Redis） |
| 契约/杂项 | `check-migrations`（时间戳分配表校验 ARCH-29）；`private-registry-contract`（bug18 selftest `--dry-run`）；`docs-site-build`（DOC-09 sync-check + VitePress build 死链 fail）；`api-types-drift`（重导 openapi.json / api-types.ts 并 git diff，见 [README 生成链](../05-interfaces/README.md)） |

## 发版链（release.yml + release-please.yml）

```
push main ─► release-please.yml：汇总 conventional commits → 开/更新 Release PR
            （bump 三包 version + CHANGELOG；tag 形态 vX.Y.Z，include-component-in-tag:false）
Release PR merge ─► release-please 打 GitHub Release/tag v* ─► 触发 release.yml：
  ① version-guard：tag 必须等于四处 version（node-sdk package.json、mcp-server package.json、
     autoflow-sdk pyproject.toml + __init__.py）——lockstep 不一致即 fail
  ② publish-npm（matrix：@autocodeflow/sdk、autocodeflow-mcp-server）：
     node 24 + npm ci + build + `npm publish --dry-run` + publish（secrets.NPM_TOKEN）
  ③ publish-pypi（autoflow-sdk）：python -m build sdist+wheel → gh-action-pypi-publish
     （secrets.PYPI_API_TOKEN；Trusted Publishing 为待迁移项）
  ②③ 均挂 `environment: release` **人工审批闸**（N42）；需先在仓库 Settings→Environments 建 `release`
```

- 幂等（N44）：同版本重发 npm 必 EP409、PyPI 必 400，无覆盖逻辑；恢复用 `gh run rerun <run-id> --failed`。
- **acf-cli 暂不发 npmjs**（名字被第三方占用 403），入矩阵前须先改名。
- 触发仅 `push: tags: v*`，故意不配 workflow_dispatch。

## 文档站（docs-site-deploy.yml）

- 触发：仅 `main` push / 手动（develop 不部署）；权限 `pages: write + id-token: write`；并发组互斥。
- 步骤：checkout → setup-node 24 → sync-check（DOC-09）→ `npm ci && npm run build` → `configure-pages@v5` → `upload-pages-artifact@v3` → Pages 部署。
- 前置：Settings→Pages→Source 选「GitHub Actions」；base 路径 `/AutoCodeFlow/`（与 `.vitepress/config.mts` 必须同步）。

## 镜像构建（multi-arch）

- CI 闸只验证 `linux/amd64,linux/arm64` 可构建（setup-qemu + buildx，push:false）。
- 正式发布仍走 `docker-compose build` / `deploy.sh -b`（单架构、本机构建）；三镜像 Dockerfile 均在各自 `apps/<app>/Dockerfile`（执行器镜像已 non-root，见 compose SEC-07 注）。
- `> ⚠️ 待核实`：仓库内没有独立的 buildx 多架构发布流水线（release.yml 只发 npm/PyPI 包，不推镜像），生产如需 arm64 镜像需自行扩展 release.yml。

## 常见坑

1. 改 API 契约忘记重跑 `npm run openapi:export && npm run gen:api-types` → `api-types-drift` 红。
2. 月度 schedule 轮只有迁移演练 job 在跑——看到"CI 大面积 skip"不是故障。
3. `e2e-full-windows` 仅 PR/手动触发；windows 侧 PG 是 runner 预装服务、Redis 是 portable zip。
4. 发版前确认 `environment: release` 已配置审批人，否则 GitHub 隐式放行、闸门形同虚设。
5. 本地复刻全部 CI job：`bash scripts/ci-local.sh`（见 [scripts.md](scripts.md)）。

## 相关文档

- [docker-compose.md](docker-compose.md)（deploy.sh 操作的拓扑）· [scripts.md](scripts.md)（e2e-full.sh / ci-local.sh）
- [../08-workflows/release-process.md](../08-workflows/release-process.md)（发版操作手册）
