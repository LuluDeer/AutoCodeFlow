# CI/CD 与发布工程 审计（2026-10-29 · 第 3 轮）

## 1 范围与方法

**范围（只读）**：`.github/workflows/*.yml`（10 个）、`Makefile`、`scripts/ci-local.sh`、
`deploy.sh`、`release-please-config.json` / `release-please-manifest.json`、
`docker-compose*.yml`（5 个）、各 app 的 `Dockerfile`（仅 FROM 面）。

**方法**

1. `codegraph status` 确认索引新鲜（1,972 文件 / 38,004 节点）后，先用 CodeGraph 定位
   `deploy.sh` 的函数边界与调用顺序（`migration_phase` / `build_phase` / `cmd_rollback` /
   `write_manifest`），再按域内需要逐段读 YAML 与 shell —— workflow/ compose/ Dockerfile
   是配置而非代码，CodeGraph 不覆盖，这部分按纪律用 grep/read。
2. 行号全部用当前工作区文件核对（`git status` 显示 `ci.yml` 有并发 agent 的未提交改动，
   本报告所有 `ci.yml` 行号以**当前工作区**为准）。
3. **实跑取证 1 项**（不超 90s、只读、无写入）：`apps/admin-api` 下
   `npm audit --omit=dev --audit-level=moderate --json` → **exit 1**，命中
   `GHSA-528h-pc64-c93x / GHSA-hqr4-qq8f-hg3x / GHSA-mjw6-4jj6-33hc`（正是 CI 豁免清单
   里的三条）。这条实测是 CIR-03 的直接证据。
4. 并发纪律遵守情况：全程无 git 写操作、无源码修改、未跑全量套件、未 `npm install`。

**去重**：先读 `docs/AGENT-SWARM-PLAYBOOK.md` §7（data-3 / desktop-budget / TOOLS-04 /
TOOLS-06 / desktop-resend / doc-guard 等正在被另一 agent 修，本轮**零重叠**）、
`docs/archive/audits/*.md`（含 `deep-audit-2026-09-22.md` 的「证伪记录：CI 泄密」段、
`eng-audit-2026-09-21.md`、`audit-ledger-2026-10.md`）、`docs/audit-playbook.md`、
`docs/PLAN-CLAIMS.md`、`docs/OPEN-DECISIONS.md`、`docs/archive/incidents/pre-existing-ci-gaps-2026-10-08.md`。
逐条比对后，本报告 **11 条均为未登记项**；与既有条目相邻的（如 `deep-audit` 的
「无 continue-on-error」结论已被现状推翻、`PLAN-CLAIMS` 的 N-10「PR 门控属 CI 成本决策」）
在对应条目里写明关系。

---

## 2 未覆盖 / 未实测（如实写）

| 项 | 状态 | 原因 / 验证方式 |
|---|---|---|
| GitHub 托管 runner 上的真实墙钟耗时分位 | **未实测** | 无 GitHub 凭证，`.github` 的历史 run 数据在本地不可得。报告里的「最慢 job」结论来自 `timeout-minutes` + 步骤清单 + 仓库自己记录的数字（`PLAN-CLAIMS`/`AGENT_HANDOFF` 的 run 记录），不是 runner 实测。验证方式：`gh run view <id> --json jobs` 拉 job 级 `startedAt/completedAt`。 |
| runner 抖动导致的 flaky 比例 | **未实测** | 需要跨 run 的失败归因数据。本报告只按**机制**判断哪些形态会在高负载 runner 上假红（无分片无重试的全量套件、`sleep`-free 轮询、浮动 Python 测试依赖），不给比例。 |
| `npm audit` 的**真实 CI 行为**（能否走到豁免分支） | **半实测** | 本地实测 audit exit 1 且命中 3 条已知豁免（见 §1.3）。CI 侧走豁免清单后 `exit 0` 是**读码结论**，未在 runner 上复跑。 |
| 三个 `docker-compose` overlay 的实际联调 | **未实测** | 本机无 docker（`docker compose version` 不可用），`ha/secure/staging/demo` 四份 overlay 只做静态读。 |
| `deploy.sh` 的 rollback 真机演练 | **未实测** | 需要生产/ staging 主机与 `.deploy-manifest.prev.json` 现场。结论基于代码路径，标注为「未验证：需在 staging 造 `appliedMigrations` 差集后跑 `./deploy.sh rollback`」。 |
| `release-desktop.yml` 的三平台打包 | 未跑 | 需要 macOS/Windows runner。只静态核对 `ACF_UV_REQUIRED` / `SHA256SUMS` 的接线。 |
| 本报告**不覆盖** | — | Windows runner 特有行为、`cost-monitor.yml` 的口径正确性（已由 2026-10-19 生产故障复盘修过，见文件头注）、`packages/docs-site/scripts/sync-check.mjs` 的判据正确性、`scripts/*.selftest.mjs` 的判据质量（另有域在审）。 |

---

## 3 发现总表

| id | 优先级 | 一句话 | 落点 file:line |
|---|---|---|---|
| CIR-01 | P2 | 覆盖率地板在 PR 路径**永不执行**，且唯一的覆盖率 job 是唯一「无分片无重试」的全量跑——门既拦不住合并、又无法把 flake 与真回归分开 | `.github/workflows/ci.yml:172`、`:165-166` |
| CIR-02 | P2 | 桌面端 48 个 main selftest + renderer selftest 只挂在 **PR / 手动**门控的 job 上，而本仓常规路径不经过 PR → develop push 上零覆盖（与已修的 desktop-e2e-smoke 同病史、未同批修）；`check-guards-wired` 判据只看「名字出现在某个 yml 里」，对此发假绿 | `ci.yml:1742`、`:1767`、`:1777`、`:1897`、`:1920`；`scripts/check-guards-wired.mjs:10` |
| CIR-03 | P2 | `ci-local.sh` 的 npm-audit **没有 GHSA 豁免清单** → 干净树上本地必红、CI 绿（实测 exit 1） | `scripts/ci-local.sh:190` ↔ `ci.yml:490-491` |
| CIR-04 | P2 | `ci-local.sh` 缺三处 CI 实跑的步骤：`typecheck:specs`、`build` 先于 test、`--coverage` → 本地全绿、CI 红 | `scripts/ci-local.sh:130-135`、`:195-198`、`:202-210`、`:220-227` ↔ `ci.yml:150`、`:560`、`:615`、`:631`、`:686` |
| CIR-05 | P2 | 供应链：132 处 action 引用只有 2 处 pin 到 SHA；审计器自身（`pip install pip-audit`）未 pin | 全 workflow 的 `uses:`；`ci.yml:524` |
| CIR-06 | P2 | `deploy.sh` 的 manifest 记了 `appliedMigrations`（注释称「被 rollback 消费」），但 `cmd_rollback` **从不读它** → 回滚后旧代码跑新 schema，只有一句文字警告 | `deploy.sh:1457`、`:1398` ↔ `:1463-1510` |
| CIR-07 | P2 | 部署产物不可复现：manifest 不记镜像 ID/digest，四个 app Dockerfile 的 base 全是浮动 tag → 同一 commit 两次部署不是同一份字节，回滚也不是 | `deploy.sh:1448-1458`；`apps/*/Dockerfile:4/12/2/8`、`:3/11` |
| CIR-08 | P2 | npm 发布无 provenance、长期 `NPM_TOKEN`；PyPI 侧已迁 OIDC，两侧凭证姿态不一致 | `.github/workflows/release.yml:165-171` ↔ `:197-201` |
| CIR-09 | P3 | Lighthouse job 注释称「复用构建产物」，实际重新 `npm ci` + `npm run build`，且 `continue-on-error` 永不 gate | `ci.yml:689-691`、`:697`、`:700-712` |
| CIR-10 | P3 | `release.yml` 全部 job **无 `timeout-minutes`** → 默认 360min；publish 卡住即锁住 `release` environment 6 小时 | `release.yml:40-260`（全文件 0 处） |
| CIR-11 | P3 | `packages/docs-site` 有入库 lockfile，但不在 `lockfile-integrity` 矩阵，而注释声称「已补 docs-site」 | `ci.yml:498` ↔ `:740-750` |

---

## 4 逐条证据

### CIR-01 · 覆盖率门在 PR 上永不执行，且唯一覆盖率 job 无重试

**现象**：`admin-api-coverage` 是唯一执行 `--coverage`（`coverageThreshold` 只在 `--coverage` 下生效）的 job，
它的触发条件是「schedule 或 develop 分支的 push」。**`pull_request` 事件下 `github.ref` 是
`refs/pull/<N>/merge`，永远不等于 `refs/heads/develop`**，因此任何 PR 都不会跑覆盖率门。

**逐字代码**（`ci.yml:169-172`）：

```yaml
  admin-api-coverage:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    if: github.event_name == 'schedule' || github.ref == 'refs/heads/develop'
```

配套自述（`ci.yml:165-166`）：

```yaml
  # 覆盖率门：全量跑一遍 + coverageThreshold（这是分片化之后唯一不变的全局口径）。
  # NETOPT-1⑪: 该 job 无分片无重试，是 CI 最长尾且唯一 flake 暴露点——每次 push
```

阈值本体（`apps/admin-api/package.json` → `jest.coverageThreshold.global`）：
`{"branches":76,"functions":81,"lines":88,"statements":87}`。

**触发路径**：

- 有人改了 50 行业务代码、一条测试没加 → 提 PR 到 `develop`/`main` → CI 全绿（覆盖率 job skipped，
  `admin-api-test` 的 4 个分片跑的是 `jest --shard=N/4 --retryTimes=2`，**不带 `--coverage`**，
  见 `ci.yml:162`）→ 合并。
- 合并进 develop 后 `push` 才跑覆盖率 → 红了。此时代码已经在 develop 上，且这次红**无法区分**
  「覆盖率真的掉了」和「4567 例里某一例在共享 runner 上抖了一次」（该 job 无 `--retryTimes`，
  是全文件唯一没有重试的 jest 运行）。

**影响与量级**：地板（87/76/81/88）从「合并门」降级为「事后告警」，而且是**唯一一条**没有重试的
全量套件——两条后果叠加正是「假红的闸等于没有闸」（本仓自己的用词，见 `ci.yml:2159-2161`）：
一次 flake 就把 develop 染红，下次真掉覆盖率时人们会先怀疑是抖。

**最小修法**（约 5 分钟，风险低）：
① 覆盖率 job 补 `--retryTimes=2`（与 `:162` 同款，`coverage` 与 `retryTimes` 兼容）；
② 让门在 PR 上也生效，但不必跑第 5 遍全量：给 `admin-api-test` 的分片加
`--coverage --coverageReporters=json`，`actions/upload-artifact` 收 4 份，再用一步
`npx nyc merge`（或 `--coverageThreshold` 关掉后由新 step 判阈值）合并——
分片合并在 jest 侧是标准做法，可把「4 遍 + 1 遍」压成「4 遍」。

**可借鉴的 OSS 做法**：NestJS 本体与 `jest` 官方文档的 shard + `--coverage` 合并；
`nyc merge`（istanbul）就是为此设计的。

---

### CIR-02 · 桌面 selftest 只挂在 PR 门控 job 上（守卫从不运行）

**现象**：`npm run test:main`（48 个 selftest 文件）与 `npm run test:renderer` 在 CI 里只出现在
两个 job：`desktop-linux-bundle`、`desktop-macos-bundle`——两者都 `if: pull_request || workflow_dispatch`。
develop push 上跑的三个桌面 job（`desktop-bundle-drift` / `desktop-e2e-smoke` / `windows-*`）
**都不跑 `test:main`**。

**逐字代码**：

`ci.yml:1741-1743`（desktop-linux-bundle）：
```yaml
  desktop-linux-bundle:
    if: github.event_name == 'pull_request' || github.event_name == 'workflow_dispatch'
    runs-on: ubuntu-latest
```
`ci.yml:1766-1767` 与 `:1776-1777`：
```yaml
        run: npm run test:main
...
        run: npm run test:renderer
```
`ci.yml:1896-1897`（desktop-macos-bundle）：同样的 `if`；`:1920` 又一个 `npm run test:main`。

而同文件对 `desktop-e2e-smoke` 的自述（`ci.yml:1947`、`:1951`）：

```yaml
  #   · 本仓常规路径是 push develop → develop→main，几乎不经过 PR；
  #     见 b5568188 / 0e315453）。一个从不运行的守卫等于没有守卫。
```

**触发路径**：常规路径是「本地 commit → push develop」（`on.push.branches: [develop]`，`ci.yml:4-5`），
不产生 `pull_request` 事件 → 两个 bundle job 恒 skipped → `test:main` / `test:renderer`
**在本仓的真实工作流里一次都不跑**。`docs/AGENT_HANDOFF.md:396` 的 run 记录已经把这个现象
写下来过（「4 个 skipped 为 push 事件下的既有门控」），但当时只把 `desktop-e2e-smoke` 收紧了，
另外两个没有同批处理。`docs/PLAN-CLAIMS.md` N-10 行把同类判断登记为「属 CI 成本决策」——
本条是**同一决策下尚未处理的剩余面**，不是重复登记。

**为什么这是真缺陷而不是纯成本选择**：`test:main` 里的 selftest 正是本轮其他域在改的
`agent-host` / `assignment-journal` / `loop` 的判据载体；它们不进 push 门禁，等价于这些改动
只有「本地手跑」这一道防线。仓库已经吃过一次同型事故：`ci.yml:885-886` 注释记录
「48 个文件里曾有 2 个从未在 CI 跑过，而它们的头注都写着 Run via: npm run test:main」。

**连带**：`scripts/check-guards-wired.mjs:10` 的判据是

```js
 *   ① 文件名出现在任一 `.github/workflows/*.yml` 里；**或**
```

即「只要名字在某个 yml 里出现过」就发绿灯，**不看该 job 的触发面**。所以「守卫已被 CI 执行」
这道元守卫对本形态**结构性看不见**——它恰好在回答「有没有人跑」时给出假绿。

**影响与量级**：48 个 selftest + 一批 renderer 守卫（设计令牌/无障碍/IPC 白名单/安全姿态）
在主干上零执行。修一次的成本是每 run +2~3 分钟（`desktop-e2e-smoke` 已是 push 触发，
可参照它的耗时）。

**最小修法**：拆一个轻量 job（`desktop-selftests`，`if: github.event_name != 'schedule'`）：
`npm ci --ignore-scripts`（跳过 electron 下载）+ `npm run test:main` + `npm run test:renderer`。
不做打包即不需要 electron 二进制，与 `desktop-bundle-drift` 的既有姿态一致（`ci.yml:1353`
注释已写明 `--ignore-scripts` 可省掉 electron 下载）。
顺手把 `check-guards-wired.mjs` 的判据①加一句「该 job 的 `if` 不得把 develop push 排除在外，
或在 README/allowlist 里显式登记成本决策」（约 15 行）。

**可借鉴的 OSS 做法**：`actions/labeler` 式的 `paths:` 过滤——Electron 项目常见做法是
「重打包只在 tag/PR 跑，selftest 每次 push 跑」的分层，例如 `electron/electron` 的
`build.yml` 把单元测试与 dist 打包拆成两条触发面。

---

### CIR-03 · `ci-local.sh` 的 npm-audit 没有豁免清单 → 本地必红、CI 绿（实测）

**现象**：CI 的 npm-audit 允许 `npm audit` **失败**，只要命中的是登记过的 GHSA 就 `exit 0`；
`ci-local.sh` 直接跑裸 `npm audit`，把非零当 FAIL。

**逐字代码**（`scripts/ci-local.sh:186-193`）：

```bash
job_npm_audit() {
  local p
  for p in apps/admin-api apps/executor-node apps/executor-desktop packages/acf-cli packages/mcp-server; do
    echo "── npm audit（CI matrix: ${p}）"
    ( cd "$p" && npm audit --registry=https://registry.npmjs.org --omit=dev --audit-level=moderate )
  done
}
```

CI 侧的对应实现（`ci.yml:490-491`）：

```yaml
          echo "::notice::All findings are known exemptions (SEC-06). Next review date: 2026-12-30."
          exit 0
```
（上面还有 `known='GHSA-528h-pc64-c93x … GHSA-jmr9-qjv8-65gv'` 五条与 `comm -23` 差集判定。）

**实测**（本机，`apps/admin-api`）：

```
$ npm audit --registry=https://registry.npmjs.org --omit=dev --audit-level=moderate --json
EXIT=1
GHSA found: GHSA-528h-pc64-c93x,GHSA-hqr4-qq8f-hg3x,GHSA-mjw6-4jj6-33hc
```

三条**全部**在 CI 的 `known` 列表里 → CI 绿、`ci-local.sh` 红。脚本头注还把这条差异写成
「E-32 对齐 CI 阈值」——阈值确实对齐了，**豁免面没对齐**。

**触发路径**：任何人在干净树上跑 `bash scripts/ci-local.sh`（不带 `--skip-audit`）→
`npm-audit` job FAIL → 汇总表 `存在 FAIL job`、退出码 1。而这次「失败」与代码无关，
是仓库自己已裁决接受的豁免。

**影响与量级**：本脚本的存在理由写在头注里——「GitHub push 暂无凭证，远端 CI 无法真跑；
本脚本保证 push 解锁前主干质量门禁不失效」。它一旦在干净树上恒红，正确的行为就变成
**永远加 `--skip-audit`**，于是整条 audit 面从本地消失（比没有脚本更糟：有一个绿/红信号
但没人信它）。历史验证记录（`docs/archive/verifies/verify-round8-e2e.md:21`）里 11 job 全绿
是因为都带了 `--skip-audit`。

**最小修法**（约 20 分钟）：把豁免判定从 YAML 里提出来，做成
`scripts/check-npm-audit-exemptions.mjs`（与 `check-dependency-review.mjs` 同居一个注册表），
CI 与 `ci-local.sh` 都调用它——这样豁免清单只存在一处，也顺带解决「CI 的 known 清单写在
shell heredoc 里、任何工具都读不到」的问题。
**可借鉴的 OSS 做法**：`better-npm-audit` 的 `--level` + allowlist 配置；
Renovate 的 `vulnerabilityAlerts` + `osv-scanner --config` 也是同一形态（清单单一事实源）。

---

### CIR-04 · `ci-local.sh` 缺三处 CI 实跑步骤 → 本地全绿、CI 红

**现象**：CI 与本地脚本在三个具体点上不等价，且三处都是**本地更松**。

**逐字代码**（`scripts/ci-local.sh`）：

```bash
130:  echo "── typecheck（CI: npm run typecheck）"
131:  ( cd apps/admin-api && npm run typecheck )
...
134:  echo "── unit + coverage（CI: npm test -- --coverage；阈值地板 stmts68/branch58/funcs56/lines69）"
135:  ( cd apps/admin-api && npm test -- --coverage )
```
```bash
198:  ( cd apps/executor-node && npm test )
205:  ( cd packages/acf-cli && npm test )
210:  ( cd packages/mcp-server && npm test )
227:  ( cd apps/admin-web && npm test )
```

CI 对应处：

```yaml
150:      - run: npm run typecheck:specs          # admin-api-test，本地无
560:      - run: npm test -- --coverage          # executor-node-test，本地无 --coverage
615:      - run: node scripts/mcp-tools-probe.cjs --check   # 本地无
631:      - run: npm test -- --coverage          # node-sdk，本地有对齐
686:      - run: npm test -- --coverage          # admin-web-build，本地无 --coverage
```

四处缺口逐条：

| 缺口 | 后果 | CI 自己的理由（注释原文） |
|---|---|---|
| 缺 `typecheck:specs` | spec 里的类型错误本地不可见 | `ci.yml:146-149`：「根 tsconfig 排除了 `**/*.spec.ts` ⇒ spec 里的类型错误对 `npm run typecheck` 不可见，只在 ts-jest 运行时炸成 Test suite failed to run……一个套件『没运行』和『通过了』在日志里长得几乎一样」 |
| `executor-node` / `admin-web` 的 `npm test` 不带 `--coverage` | 两个包的 `coverageThreshold`（executor-node `78/62/80/80`；admin-web `72/68/62/74`）本地不生效 | `ci.yml:557-561`：「jest coverageThreshold 只在 `--coverage` 下生效，CI 必须显式传」；`ci.yml:682-685` 同义 |
| `acf-cli` / `mcp-server` 不 `npm run build` | acf-cli 的 `release-metadata.test.ts` 执行 `dist/index.js`（实测该测试文件第 103 行注释写明缺产物会 `MODULE_NOT_FOUND: dist/index.js` 变红）；mcp 的 `mcp-tools-probe.cjs --check` 未跑 | `ci.yml:579-583`：「该守卫在产物缺失时会显式失败而非静默跳过；故这里必须先 build，否则守卫在 CI 里等于不存在」 |

**触发路径**：改 `packages/acf-cli` 的版本号或 `mcp-server` 的工具 schema → 跑
`ci-local.sh`（`dist/` 是上次构建的旧产物时**假绿**，无 `dist/` 时**假红**）→ 推上去 CI 在
`mcp-tools-probe` 或版本守卫上红。第二条：改 `apps/admin-web` 加功能不加测试 →
`npm test`（即 `vitest run`，无 coverage）全绿 → CI 的 `npm test -- --coverage` 触发
threshold 红。

**影响与量级**：「本地跑过一遍」是提交前唯一自检手段；这三处让它系统性地低估风险。
`scripts/ci-local.sh:23-24` 与 `:38-40` 的头注还把 `admin-web` 的 vitest 写成「仅本地跑
——CI 的 admin-web-build job 只有 lint+build」，而 CI 早在 L-1 就加了 `--coverage`
——**头注与 CI 现状相反**，会让人以为本地比 CI 严。

**最小修法**（约 15 分钟，纯脚本）：
① `job_admin_api` 加 `npm run typecheck:specs`；
② `job_executor_node` / `job_admin_web` 的 `npm test` 改 `npm test -- --coverage`；
③ `job_acf_cli` / `job_mcp_server` 在 test 前加 `npm run build`，mcp 末尾加
`node scripts/mcp-tools-probe.cjs --check`；
④ 修 `:134` 的过期阈值注释（现为 `87/76/81/88`）与 `:23-24`/`:38-40` 的「CI 只有 lint+build」。

**可借鉴的 OSS 做法**：`act`（nektos/act）的思路——与其维护一份手抄的等价脚本，
不如让 CI 的 step 序列成为唯一事实源（`ci-local.sh` 可以直接从 `ci.yml` 里抽 `run:`
列表执行）。短期不必上 `act`，但那三行改动必须做。

---

### CIR-05 · 供应链：132 处 action 只有 2 处 pin SHA；审计器自身未 pin

**现象**：全仓 `uses:` 统计（`grep -ohE 'uses: [^ ]+' .github/workflows/*.yml | sort | uniq -c`）：

```
     46 uses: actions/checkout@v7
     34 uses: actions/setup-node@v7
      9 uses: actions/setup-python@v7
      7 uses: actions/upload-artifact@v7
      1 uses: gitleaks/gitleaks-action@v3
      1 uses: docker/build-push-action@v7
      1 uses: actions/upload-pages-artifact@v5
      1 uses: actions/deploy-pages@v5
      1 uses: actions/configure-pages@v6
      1 uses: actions/labeler@v7
      1 uses: pypa/gh-action-pypi-publish@7245906fb61fa33a13554f9d5fb856fe61758086
      1 uses: googleapis/release-please-action@45996ed1f6d02564a971a2fa1b5860e934307cf7
```

**134 处 tag 引用 vs 2 处 SHA**。仓库自己在 `release.yml:236-240` 写了为什么该 pin：

```yaml
        # NETOPT-4：SHA 钉死（release/v1 分支头 = dc37677）。本 action 以
        # PyPI Trusted Publishing 的 OIDC（id-token: write）发布，tag 漂移
        # 即发布凭据面漂移；升级走 dependabot（github-actions 生态，weekly…
```

但同样的推理没有推广到**持写权限 token 的三个 job**：`secret-scan`（`permissions:
security-events: write`，`ci.yml:779-781`）、`ensure-release` 与 `demote-sdk-release`
（`permissions: contents: write`，`release.yml:261`、`:281`）。这三个 job 里跑的
`actions/checkout@v7` / `gitleaks/gitleaks-action@v3` 一旦 tag 被移动，拿到的是
`contents:write` + 仓库 secrets 上下文。

第二处：`ci.yml:524` —— 审计器自身不可复现：

```yaml
      - name: Install pip-audit
        run: pip install pip-audit
```

**触发路径**：上游 action 仓库被接管 / tag 被强制移动（供应链攻击的标准形态：`tj-actions/
changed-files` 2025-03 事件就是这个形态，攻击者改了 tag 指向）→ 下一次 CI 运行即执行
攻击者代码，持 `security-events: write` 或 `contents: write`。第二处：`pip-audit` 新版本
改了默认 `--audit-level` 或 JSON 结构 → `node -e` 的解析器（`ci.yml:469-480`）拿到空集
→ `found` 为空 → `unmatched` 为空 → **`exit 0` 假绿**（`echo "::notice::All findings are
known exemptions"`）。这是「审计器坏了但报绿」的经典形态。

**影响与量级**：P2 而非 P1 的理由是没有已知入侵；但这是**唯一**「一次上游变异即可拿到写权限」
的面。`pip-audit` 那处的假绿面已经与仓库自己的原则（「改结构 → 空集 → 零发现 → 绿 是最坏的假绿」，
`ci.yml:824-825` DOC-GUARD 注释原文）直接冲突。

**最小修法**：
① 先只 pin 三个持写权限 job 的 action（4 处，约 10 分钟）：`secret-scan` 的 checkout 与
gitleaks、`ensure-release`/`demote-sdk-release` 的 checkout（后两者其实不用 checkout，
`gh release` 只需 `GH_TOKEN`，可整步删掉——**更小的改动面**）；
② `pip install pip-audit==<version>`（`ci.yml:524`），并把「解析结果为空」从放行改成红：
`if [ -z "$found" ] && [ "$status" -ne 0 ]; then echo "::error::audit 失败但解析不到任何 GHSA
——解析器或 pip/npm 输出格式已变"; exit 1; fi`。

**可借鉴的 OSS 做法**：`step-security/harden-runner` + `pin-github-action`（
`ryankurte/pin-github-action` 一键把 tag 换成 SHA）；OpenSSF Scorecard 的
`PinnedDependencies` 检查项就是这条。

---

### CIR-06 · rollback 记了 `appliedMigrations` 却从不消费 → 旧代码跑新 schema

**现象**：`write_manifest` 把已执行迁移列表写进 `.deploy-manifest.json`，注释明确说这个字段
「被 rollback 消费」；但 `cmd_rollback` 里**没有任何一处读它**——它对迁移只有一段硬编码的文字警告。

**逐字代码**（`deploy.sh:1396-1398` 注释、`:1455-1458` 写入）：

```bash
# components / deployedAt 里，语义完整且被 rollback 消费。
...
  "imageState": "${IMAGE_STATE:-unknown}",
  "readiness": "${READINESS:-unknown}",
  "appliedMigrations": ${migrations_json}
```

`cmd_rollback` 的全部迁移处理（`deploy.sh:1496-1512`）：

```bash
    # 迁移不可逆——与 docs/rollback-semantics.md 的既有姿态一致
    cat <<'EOF'

  ⚠ 默认只回滚代码，不回滚数据库迁移。

  项目既有语义（docs/rollback-semantics.md）：迁移是单向的，
  回滚代码而保留迁移后的 schema 通常安全；反向回滚迁移会丢数据。
```

`grep -n "appliedMigrations" deploy.sh` 只返回 3 处：注释（1403）、查询（1411）、写入（1457）
——**零处读取**。

**触发路径**：v1.11.0 部署完成（manifest 记 `[..., M_a]`）→ 发 v1.12.0，其中含一条
`schema_break` 型迁移（如 `DROP COLUMN tasks.legacy_field` 或 `RENAME`）→ deploy 成功
（manifest.prev 记 `[..., M_a]`，当前记 `[..., M_a, M_b]`）→ v1.12.0 出问题，运维跑
`./deploy.sh rollback` → 脚本 `git checkout` 回 v1.11.0 的 commit 并重建（`deploy.sh:1542-1544`），
v1.11.0 的实体仍声明 `legacy_field` → 启动后第一次查询该表即 `column does not exist`。
脚本给运维的信息是「回滚代码而保留迁移后的 schema **通常安全**」——在破坏性迁移上恰好相反。

**影响与量级**：**未验证**（需 staging 真机演练；验证方式：造一条 `DROP COLUMN` 迁移，
deploy → rollback，观察 admin-api 启动日志）。逻辑面上这是「回滚能力被文档高估」的
可回滚性缺陷：脚本有能力判断（`prev.appliedMigrations` 与当前 manifest 的差集非空即意味着
schema 前进过），却放弃了判断。

**最小修法**（约 25 行 bash，零新依赖）：`cmd_rollback` 里算差集

```bash
cur=$(grep -o '"appliedMigrations": *\[[^]]*\]' "$MANIFEST_FILE" | sed 's/.*\[//;s/\]//' | tr ',' '\n')
prev=$(grep -o '"appliedMigrations": *\[[^]]*\]' "$MANIFEST_PREV" | sed 's/.*\[//;s/\]//' | tr ',' '\n')
extra=$(comm -23 <(echo "$cur" | sort) <(echo "$prev" | sort))
```
非空则打印「回滚目标版本之后新增了 N 条迁移，旧代码可能不兼容新 schema」，并要求显式
`--allow-schema-ahead` 才继续（与既有的 `--allow-stale-image` 同款分级姿态）。
把「通常安全」改成按差集动态渲染的判定。

**可借鉴的 OSS 做法**：`gitlab-org` 的「迁移必须向后兼容两个版本」纪律（expand/contract）；
`strong_migrations`（Rails）在应用层拦破坏性 DDL——本仓的等价物就是这里的前置检查。

---

### CIR-07 · 部署产物不可复现：manifest 无镜像 digest，base image 浮动

**现象**：生产部署是 `compose build`（宿主构建），产物身份只记 `gitCommit` + `imageState`，
不记镜像 ID/digest；四个 app Dockerfile 的 base 全是浮动 tag。

**逐字代码**（`deploy.sh:1448-1458`）：

```bash
    cat > "$MANIFEST_FILE" <<EOF
{
  "mode": "$MODE",
  "env": "$ENV_NAME",
  "deployedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "gitCommit": "$git_commit",
  "components": "$(resolve_components | tr ' ' ',')",
  "imageState": "${IMAGE_STATE:-unknown}",
  "readiness": "${READINESS:-unknown}",
  "appliedMigrations": ${migrations_json}
}
```
Dockerfile 的 base：

```
apps/admin-api/Dockerfile:4:    FROM node:24-alpine AS builder
apps/admin-api/Dockerfile:12:   FROM node:24-alpine
apps/executor-python/Dockerfile:2:  FROM python:3.12-slim AS builder
apps/executor-python/Dockerfile:8:  FROM python:3.12-slim
apps/admin-web/Dockerfile:2:    FROM node:24-alpine AS builder
apps/admin-web/Dockerfile:10:   FROM nginx:1.27-alpine
```

**触发路径**：v1.11.0 部署（`--build`，镜像 A）→ 3 周后宿主磁盘不足/误删镜像 → 同一 commit
重跑 `./deploy.sh --build` → `node:24-alpine` 在这三周里前进过 → 得到镜像 B（不同 npm/openssl/
musl 版本）→ manifest 两行记录完全相同（`gitCommit` 一样、`imageState` 都是 `built`）。
反向场景：线上报障，`docker compose images` 的 ID 早就被下一次 build 覆盖，
**无法回答「线上跑的是哪份字节」**。

**影响与量级**：运维误导（P2 档：不是数据损坏，但「回滚/复现」这两个承诺在字节层面不成立）。
注意 compose 里第三方服务**已经** pin 到具体 release/minor（`postgres:16-alpine` /
`minio/minio:RELEASE.2024-10-13…` / `verdaccio/verdaccio:5.31.1` / `grafana/loki:3.0.0`，
见 `docker-compose.yml:319`、`:677`、`:933`；`E-34`/`O-3` 两轮已修），只有**自建 app 的 base**
没跟上同一纪律；`docs/deployment.md:487` 还把 `node:24-alpine ×2 + python:3.12-slim` 当作
既定事实写着。

**最小修法**：
① `write_manifest` 追加一行镜像身份（约 8 行）：
`"images": "$(compose images --format '{{.Service}}={{.ID}}' | tr '\n' ',')"`
（source 模式记 `git rev-parse` + `node -v` 即可）；
② 四个 Dockerfile 的 base 改 `FROM node:24-alpine@sha256:…`（首次升级时用
`docker buildx imagetools inspect` 取 digest）；或退一步：在 `docker-compose.yml` 里给
build 加 `args:` 把 base 版本固化成一个 env 键，由 `deploy.sh doctor` 检查漂移。
③ 顺带把 `docs/deployment.md:487` 的「全 alpine/slim」表述补上 digest 纪律。

**可借鉴的 OSS 做法**：Renovate 的 `docker:pinDigest` preset（自动把 tag 换成
`tag@sha256:…` 并持续开 PR 升级）；Kubernetes 部署侧则是「部署清单必须引用 digest 而非 tag」。

---

### CIR-08 · npm 发布无 provenance、长期 token；PyPI 已 OIDC

**现象**：同一份 `release.yml` 里，PyPI 侧已迁 Trusted Publishing（OIDC、无长期 token，
并把「为什么」写成 20 行注释），npm 侧仍是长期 `NPM_TOKEN`，且 `npm publish` 没有 `--provenance`。

**逐字代码**（`release.yml:164-171`）：

```yaml
      - name: Publish (dry-run 结构校验)
        working-directory: ${{ matrix.dir }}
        run: npm publish --access public --dry-run

      - name: Publish
        working-directory: ${{ matrix.dir }}
        env:
          NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}
        run: npm publish --access public
```

对照 PyPI 侧（`release.yml:197-201`）：

```yaml
    # U-1: OIDC 取 token 需要 id-token 权限；contents: read 保留给 checkout。
    # 注意：job 级 permissions 会覆盖 workflow 级默认（此处显式补回 contents: read）。
    permissions:
      contents: read
      id-token: write
```

**触发路径**：`NPM_TOKEN` 是一个 npmjs Automation token——它没有 OIDC 的短时性，
一旦泄露（CI 日志、runner 内存转储、误提交的 `.npmrc`）可以长期以发布者身份发版；
而 `publish-npm` 的 `environment: release` 审批只保护"这一次 CI 运行"，不保护 token 本体。
另一方面，`npm publish` 不带 `--provenance` 意味着 `@autocodeflow/sdk` / `@autocodeflow/cli`
/ `autocodeflow-mcp-server` 的下载页没有「由此仓库此 workflow 构建」的可验证链接
——用户无法区分官方包与被抢注的同名包。

**影响与量级**：P2（供应链姿态不一致 + 缺失可验证性）。与 `deep-audit-2026-09-22.md`
的「CI 泄密：无 pull_request_target/workflow_run；PyPI OIDC 免长期 token」结论是
**同域但不同事实**：那条把 PyPI 的 OIDC 当成整个发布面的证据，npm 侧从未 OIDC 化。

**最小修法**（约 10 分钟）：给 `publish-npm` 加 `permissions: {contents: read, id-token: write}`
与 `npm publish --access public --provenance`（npm 11 + public repo 已支持，无需额外配置）；
token 迁移到 npm Trusted Publishing 需要 npmjs 侧一次性登记（与 PyPI 同流程），
可先只做 provenance，把 token 保留为回退路径并写进注释。

**可借鉴的 OSS 做法**：`actions/setup-node` 的官方文档「Publishing packages to npm with
provenance」+ npm 的 Trusted Publishing（2025 起 GA）；`pnpm`/`vite` 等仓库已全量迁。

---

### CIR-09 · Lighthouse job 注释称「复用构建产物」，实际重装重构建，且永不 gate

**现象**：连续两条注释说「在 admin-web-build 之后运行，复用构建产物」，但 job 内没有任何
`download-artifact`，而是重新 `npm ci` + `npm run build`。

**逐字代码**（`ci.yml:688-712`）：

```yaml
  # ── Lighthouse CI 性能监控 ────────────────────────────────────
  # 自动化前端性能审计，防止性能回归。在 admin-web-build 之后运行，复用
  # 构建产物。初期设为 continue-on-error 不阻塞 CI，建立性能基线后再收严。
  admin-web-lighthouse:
    runs-on: ubuntu-latest
    timeout-minutes: 15
    needs: admin-web-build
    if: github.event_name != 'schedule'
    continue-on-error: true
    steps:
      - uses: actions/checkout@v7
      ...
      - run: npm ci
        working-directory: apps/admin-web
      # 构建生产版本（Lighthouse 审计生产构建的性能）
      - name: Build production bundle
        run: npm run build
        working-directory: apps/admin-web
```

**触发路径**：每次 develop push / PR 都跑一遍 `admin-api` 之外**第二重** `admin-web` 的
`npm ci`（约 60-90s）+ `vite build`（约 60-120s）+ `lhci autorun`；结果是
`continue-on-error: true`，无论分数多低 job 都是绿的。

**影响与量级**：每次 run 约 **3-4 分钟机器时间买零门禁价值**（注释里的「建立基线后再收严」
没有任何到期机制——这与 `auto-label` / `cost-monitor` 那种「没人看红叉就静默腐烂」同型，
只是这里腐烂成"永远绿"）。另外「复用构建产物」是**假陈述**：读者会以为
`admin-web-build` 的产物被消费，实际两份构建彼此独立（如果 Lighthouse 侧的 build 因环境
差异产出不同 bundle，审计的是另一份产物）。

**最小修法**（二选一，约 10 分钟）：
① **收严**：`admin-web-build` 加 `upload-artifact: apps/admin-web/dist`，Lighthouse job 改
`download-artifact` + `lhci autorun --collect.staticDistDir=dist`，删掉 `npm ci`/`build`，
并把 `continue-on-error` 换成 `lhci assert` 的阈值（当前 `lighthouserc` 已配置 assertions）；
② **下线**：整 job 删除，性能回归交给已有的
`admin-web/src/__tests__/monaco-first-paint.perf01.test.ts` 与 `micro-benchmark` job。
选①的净收益：-2 步重装重构建（≈3min/run）+ 一个真门禁。

**可借鉴的 OSS 做法**：`treosh/lighthouse-ci-action` 官方示例即「build 一次 + `staticDistDir`」，
不做二次构建。

---

### CIR-10 · `release.yml` 全部 job 无 `timeout-minutes`

**现象**：`grep -c timeout-minutes .github/workflows/release.yml` → **0**。同目录
`ci.yml`（每个 job 都有）、`release-desktop.yml`（`:101` = 45min）都设了。

**逐字代码**（`release.yml:125-128`，最长的一个）：

```yaml
  publish-npm:
    needs: version-guard
    runs-on: ubuntu-latest
    # N42 (round-10): tag push 本身即发布动作，version-guard 之外再加一道
```

**触发路径**：`npm publish` 卡在 registry 无响应（npmjs 偶发 502/长挂）→ GitHub 默认
360 分钟才杀；`publish-npm` 与 `publish-pypi` 都挂了 `environment: release`，
**environment 的审批锁与 concurrency group（`cancel-in-progress: false`，
`release.yml:33-35`）在整个窗口内被占住** → 期间任何人对该 tag 的操作排队，发版窗口被
一条挂死的 step 占 6 小时。

**影响与量级**：P3（不会错发，只会卡住 + 浪费 minutes）。注意 `demote-sdk-release`
里的 `for _ in $(seq 1 30); sleep 2`（`:294`）已经自带 60s 上界——说明作者对"卡住"
是有意识的，只是没落到 job 级。

**最小修法**：`version-guard` 5、`publish-npm` 20、`publish-pypi` 20、`ensure-release` 5、
`demote-sdk-release` 5（分钟）。一行一个。

**可借鉴的 OSS 做法**：`kubernetes-sigs` / `actions-runner` 一类仓库把
`timeout-minutes` 当 lint 项（`actionlint` 有 `job-timeout` 类规则可查）。

---

### CIR-11 · `packages/docs-site` 的 lockfile 不在 `lockfile-integrity` 矩阵（注释声称已补）

**现象**：入库的 lockfile 共 9 份（`git ls-files | grep package-lock.json`），
`lockfile-integrity` 矩阵列了 7 个，缺 `packages/docs-site` 与根 `package-lock.json`
（根无依赖，可忽略）。而注释声称已补：

**逐字代码**（`ci.yml:498`，位于 npm-audit job 内）：

```yaml
      # 矩阵也补 docs-site（此前 lockfile-integrity 漏审的那一项）。
```

矩阵本体（`ci.yml:740-750`，**无 docs-site**）：

```yaml
      matrix:
        project:
          - apps/admin-api
          - apps/admin-web
          - apps/executor-node
          - apps/executor-desktop
          - packages/acf-cli
          - packages/mcp-server
          - packages/autocodeflow-node-sdk
```

**触发路径 / 影响（如实降级）**：`docs-site-build` job（`ci.yml:2012-2013`）确实跑
`npm ci`，而 `npm ci` 在 lock↔manifest 不一致时会自己失败——所以**漂移仍被间接兜住**，
这条的实际后果只有两条：① 一句**假陈述**躺在安全相关 job 的注释里（下一个读者会以为
矩阵已覆盖全仓）；② `npm-audit` 的矩阵同样少了 docs-site，而 `--omit=dev` 下
docs-site 的依赖全是 devDeps（`vitepress` 一枚），确实不在审计面内——所以②无害。
按此，本条只值 P3，修法就是一行。

**最小修法**：给 `ci.yml:740-750` 的矩阵加 `- packages/docs-site`，并修正 `:498` 的措辞
（或把注释挪到它真正说明的那一处）。**反向选择**：若决定"docs-site 由 docs-site-build 的
`npm ci` 兜住"，就把 `:498` 改成这个理由，别留一句"已补"。

**可借鉴的 OSS 做法**：`actions/dependency-review-action` + 一份从 `package.json` 遍历出来的
矩阵自动生成（避免手抄矩阵漏项——本仓已有 `check-no-hoisting.mjs` 遍历各 package.json，
可直接复用其发现逻辑产矩阵）。

---

## 5 建议实施顺序（收益 ÷ 风险）

| 序 | 条目 | 改动成本 | 风险 | 收益 | 备注 |
|---|---|---|---|---|---|
| 1 | **CIR-04** ci-local 三处对齐 | 15 min（纯脚本，3-6 行） | 极低 | 高：恢复"提交前自检"的可信度 | 无 CI 行为变化，可立即提交 |
| 2 | **CIR-03** ci-local npm-audit 豁免 | 20-40 min | 低 | 高：消掉"本地必红"→ 不再系统性 `--skip-audit` | 顺手把豁免清单从 YAML 提成脚本（CI 一并受益） |
| 3 | **CIR-01** 覆盖率门进 PR + 补重试 | 5 min（①）+ 30 min（②合并分片覆盖） | 低 | 高：门真正拦住合并；flake 与回归可分 | ①可单独先上 |
| 4 | **CIR-02** 拆 `desktop-selftests` push job | 15-20 行 + 2~3 min/run | 低（新 job，不动既有） | 高：48 个 selftest + renderer 守卫回到主干 | 顺带给 `check-guards-wired` 加门控判据 |
| 5 | **CIR-09** Lighthouse 收严或下线 | 10 min | 低 | 中：-3min/run，或换来一个真性能门 | 二选一，别继续留着"永远绿" |
| 6 | **CIR-10** release.yml 补 timeout | 5 min（5 行） | 无 | 中：发版窗口不被单步占 6h | 纯防御 |
| 7 | **CIR-08** npm provenance | 10 min | 低（publish 需回滚路径） | 中：包可验证来源 | 下次发版前落地 |
| 8 | **CIR-05** pin 写权限 job 的 action + pip-audit 定版本 | 30 min（若只做 3 个 job + 空集改红） | 低 | 中高：堵住"上游变异→写权限"与"审计假绿" | 全量 pin 属独立工程，别混进来 |
| 9 | **CIR-11** docs-site 进矩阵 / 改注释 | 5 min | 无 | 低 | 顺手做 |
| 10 | **CIR-06** rollback 消费 appliedMigrations | 30-45 min（bash + selftest 用例） | 中（改 rollback 路径，必须先补 `scripts/deploy.selftest.sh` 用例） | 高：把"回滚承诺"变成可判定 | 需 staging 演练配合；**未验证项**先补验证 |
| 11 | **CIR-07** manifest 记镜像身份 + base pin digest | 30 min（①）~ 半天（②含四次 digest 升级流程） | 中（换 digest 需同步 renovate/文档） | 中：部署可复现、故障可回答"跑的是哪份字节" | ①可先上，②单独一轮 |

**不建议本轮动的**：`e2e-full-windows` 的 PR/手动门控（`ci.yml:1623`）——文件头注已把
「不进每次 develop push」写成拍板决策（windows 服务/portable redis 的 flaky 面），
改它的前提是先解决那两个 flaky 源；`docker-multiarch-build` 的
`push: false`（镜像不入仓库，生产走宿主 build）属于部署形态选择，不是本域的缺陷。
