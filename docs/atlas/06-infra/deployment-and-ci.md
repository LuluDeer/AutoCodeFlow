# 部署与 CI
> 所属: docs/atlas/06-infra · 最后核对: 2026-11-22 · 对应代码: deploy.sh、.github/workflows/（共 10 个：ci.yml / release.yml / release-desktop.yml / release-please.yml / docs-site-deploy.yml / auto-label.yml / cost-monitor.yml / desktop-e2e.yml / readme-sync.yml / release-hygiene.yml）

## 怎么部署（deploy.sh，2231 行）

```bash
# 生产推荐（源码模式，需 root）
sudo ./deploy.sh --mode source --env production --i-know-its-production --build

# Docker 试跑模式（缺省 --mode docker，向后兼容）
./deploy.sh --mode docker --env staging --build

# 运维子命令（均支持 --mode source|docker；doctor 支持 --json）
./deploy.sh doctor [--json]
./deploy.sh status | health | logs [component] | restart | rollback
```

流程（8 阶段幂等可重入流水线，双模共读根 `.env`）：参数解析与生产确认闸（`--i-know-its-production`）→ preflight 依赖与配置校验（无 `.env` 则拒绝上线）→ 迁移前强制数据库备份（`scripts/pg-backup.sh`，生产备份失败即中止）→ 数据库迁移（带 `pg_advisory_lock`）→ 组件构建（source 模式逐组件 `npm ci` + `build` / docker 模式按 `--build` 决定重建，代码变更未带 `--build` 时默认 fail-closed 拦下）→ 启动/重启（source 模式重写 systemd unit + `nginx -t && systemctl reload nginx`；docker 模式 `docker compose up -d`）→ 健康门校验（`/api/health/ready` 非 200 默认 fail-closed）→ **验证失败自动回滚**（`auto_rollback_on_verify_failure` 写入 `.deploy-manifest.failed.json` 并按同一 `MODE` 调 `cmd_rollback` 回滚至 `.deploy-manifest.prev.json` 后再验健康，由 `scripts/deploy-rollback.selftest.sh` 守护）。

## Workflow 文件总览（.github/workflows/，10 个）

| Workflow | 触发 | 作用 |
|---|---|---|
| `ci.yml` | push/PR（main、develop）、手动、cron | 42 个 job 的全量质量门禁（下表） |
| `release.yml` | `push tags v*` | `version-guard`（6 处核对）→ npm 3 包（`@autocodeflow/sdk`、`@autocodeflow/cli`、`autocodeflow-mcp-server`）+ PyPI（`autoflow-sdk`，OIDC）发布 → `demote-sdk-release` |
| `release-desktop.yml` | `push tags desktop-v*` | 桌面端安装包（NSIS/dmg/AppImage/deb + `latest*.yml` + `SHA256SUMS.txt`）三平台构建与 GitHub Release `latest` 发布，与平台 4 包发布解耦 |
| `release-please.yml` | push main | 汇总 conventional commits → 单一 root 条目（`.`）开/更新 Release PR（自动广播 4 包 + 文档版本 + 根 `CHANGELOG.md`），合并后自动打 `v*` tag |
| `docs-site-deploy.yml` | push main、手动 | 双 job（`build` + `deploy`）构建并发布 VitePress 文档站至 GitHub Pages（base `/AutoCodeFlow/`） |
| `readme-sync.yml` | `push main`（限 `README.md` 与本 workflow 自身路径）、手动 | 从 `README.md` 的 `<a name="english">` / `<a name="chinese">` 切片**生成** `README.en.md` / `README.zh.md`（改 README 必须重跑，否则英文/中文产物落后） |
| `auto-label.yml` | `pull_request`（opened / synchronize / reopened） | `actions/labeler` 按 `.github/labeler.yml` 给 PR 自动打标签（`sync-labels: true`） |
| `cost-monitor.yml` | 每周一 02:00 UTC cron、手动 | 统计近 7 天主要 workflows 的运行数 / 计费分钟（`/timing` 的 `billable_ms`）/ 成功率，滚动更新周报 issue 并输出 `$GITHUB_STEP_SUMMARY`（需 `issues: write` + `actions: read`） |
| `desktop-e2e.yml` | 周日 19:00 UTC（= 周一 03:00 UTC+8）cron、手动 | Linux 显示环境下 executor-desktop 的 Playwright `_electron` **3 例**（xvfb + dbus + openbox）；**刻意不挂 PR 门**，Windows 侧硬断言由 `ci.yml` 的 `desktop-e2e-smoke` 承担 |
| `release-hygiene.yml` | 每周一 21:23 UTC（= 周二 05:23 UTC+8）cron、手动 | `scripts/check-release-hygiene.mjs` 三条判据巡检：Draft 遗留 / 同 tag 重复 / Latest 竞争，违规即红 |

## CI 面板（.github/workflows/ci.yml）

- 触发：push/PR 到 `main`、`develop`；`workflow_dispatch`；定时 `schedule`（nightly 迁移漂移/长程演练——schedule 触发时常规 push/PR 套件按 `if: github.event_name != 'schedule'` 旁路，仅跑 schedule 专项检查）。
- 并发组：`ci-${{ github.ref }}`，同分支旧跑自动取消。共 **42 个 job**：

| 分组 | Job（要点） |
|---|---|
| 分支拓扑 | `branch-topology-guard`（PR/schedule 事件下验远端 develop 存在 + ci.yml `push.branches` 含 develop，防 auto-delete 误删 develop 导致 push 触发器与 coverage 门静默失效；2026-11-24） |
| 镜像闸 | `docker-multiarch-build`：admin-api / executor-node / executor-python 三镜像 matrix，`linux/amd64+arm64` **只 build 不 push**（BUG-20） |
| admin-api | `admin-api-test`（PG16+Redis7 services；typecheck+lint+jest coverage+迁移+e2e `--runInBand`）；`admin-api-migrations`（空库全链 155 个迁移 + 二跑幂等守卫 + 每次触发均执行 revert drill 与副作用断言；schedule 轮追加实体/迁移漂移检查） |
| Node 包 | `executor-node-test`、`acf-cli-test`、`mcp-server-test`、`autocodeflow-node-sdk-test`（coverage）、`admin-web-build`（lint+build） |
| 安全 | `npm-audit`（5 项目 matrix，moderate 红灯，GHSA 豁免清单 fail-closed）；`lockfile-integrity`（8 项目含 `packages/docs-site` 执行 `npm ci --dry-run --ignore-scripts` 防锁文件漂移）；`secret-scan`（gitleaks 全量历史） |
| Python | `executor-python-test`、`autoflow-sdk-python-test`、`python-packages-test`（autocodeflow-http/notify/db/ai matrix）、`registry-pypi-test`（均 py3.12） |
| 桌面端 | `desktop-bundle-drift`（ncc 重打 bundle 与入库产物 diff，W-18）；`desktop-linux-bundle`（AppImage+deb，PR/手动）；`desktop-e2e-smoke`（Playwright _electron 8 例，windows，**每次 develop push**） |
| Windows 基线 | `windows-node-tests`（executor-node/acf-cli/mcp-server matrix）、`windows-admin-web` |
| E2E 全链 | `e2e-full`（ubuntu，入口口径 **51 例** Playwright = `e2e-full.spec.js` 48 + `e2e-python-executor.spec.js` 1 + `e2e-ui09-mobile.spec.js` 2，PG 15432/Redis 16379，`SKIP_DOCKER=1` 走 `scripts/e2e-full.sh`；逐文件点数见 [07-testing/e2e-testing.md](../07-testing/e2e-testing.md)）；`north-star-real-e2e`（真后端 + 真 PG + Playwright 校验北极星看板与生产启用路径）；`e2e-full-windows`（windows，PR/手动/schedule，预装 PG 服务 + portable Redis） |
| 契约/杂项 | `check-migrations`（时间戳分配表校验 ARCH-29）；`private-registry-contract`（bug18 selftest `--dry-run`）；`docs-site-build`（DOC-09 sync-check 9 面 + VitePress build 死链 fail）；`api-types-drift`（重导 openapi.json / api-types.ts 并 git diff，见 [README 生成链](../05-interfaces/README.md)） |

## 发版链（release.yml + release-please.yml + release-desktop.yml）

```text
push main ─► release-please.yml：汇总 conventional commits → 开/更新 Release PR
            （单一 root 条目 `.` 广播 4 包与文档版本 + 追加根 CHANGELOG.md；tag 形态 vX.Y.Z）
Release PR merge ─► release-please 自动打 GitHub Release/tag v* ─► 触发 release.yml：
  ① version-guard：校验 tag 逐字等于 6 处版本（version.txt、@autocodeflow/sdk、@autocodeflow/cli、
     autocodeflow-mcp-server、autoflow-sdk pyproject.toml + __init__.py）——lockstep 不一致即 fail
  ② publish-npm（matrix 3 包：@autocodeflow/sdk、@autocodeflow/cli、autocodeflow-mcp-server）：
     node 24 + npm ci + build + `npm publish --access public --dry-run` + publish（secrets.NPM_TOKEN）
  ③ publish-pypi（autoflow-sdk）：python -m build sdist+wheel → pypa/gh-action-pypi-publish
     走 **PyPI Trusted Publishing（OIDC）**（`permissions: id-token: write`，免长期 PYPI_API_TOKEN）
  ④ demote-sdk-release：将 `v*` Release 标为 prerelease，保护桌面端 `/releases/latest` 更新源
  ②③ 均挂 `environment: release` **人工审批闸**（N42）；需先在仓库 Settings→Environments 建 `release`
```

- 幂等（N44）：同版本重发 npm 必 EP409、PyPI 必 400，无覆盖逻辑；恢复用 `gh run rerun <run-id> --failed`。
- CLI 以 `@autocodeflow/cli`（保留 `bin: acf`）纳入 4 包 lockstep 发布矩阵，不再存在「暂不发 npmjs」限制。
- 桌面端走独立 `desktop-v*` tag + `release-desktop.yml`（`desktop-version-guard` → 三平台构建 → 上传安装包与 `latest*.yml` 为 GitHub Release `latest`），不与平台 4 包互相阻塞。
- `release.yml` 触发仅 `push: tags: v*`，故意不配 `workflow_dispatch`。

## 文档站（docs-site-deploy.yml）

- 触发：仅 `main` push / 手动（develop 不部署）；并发组互斥（`docs-site-deploy-${{ github.ref }}`）。
- **双 job 最小权限拆分**：
  - `build` job（`permissions: contents: read`，`timeout-minutes: 15`）：checkout → setup-node 24 → sync-check（DOC-09 9 面 + selftest）→ `npm ci && npm run build` → `configure-pages` → `upload-pages-artifact`（所有 action 均 40 位 SHA 钉死）；
  - `deploy` job（`needs: build`，`timeout-minutes: 10`，`permissions: pages: write + id-token: write + actions: read`，`environment: github-pages`）：`deploy-pages` 完成上线（`actions: read` 为 `deploy-pages` 读取本次 run artifact metadata 所需）。
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
