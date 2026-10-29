# 文档真实性审计（2026-10-29 · 第 3 轮）

> 只读审计。本文件是本次唯一的写操作；未改动任何源码 / 配置 / 其他文档。
> 工作区当时有另一个 agent 在改源码（`agent` 域、`ci-local.sh`、`package.json`、`ci.yml`），本文所有「实际值」都由我在**当场**重跑命令得到，并逐条标注了取值命令，便于复核者在工作区变动后重算。

## 1 范围与方法

### 1.1 审什么

域：**文档—实现一致性、路线图与交接可信度**。目标不是「文档旧了」，而是每条都能给出**可核对的「文档 X / 实际 Y」外加 Y 的出处**。

六个面：① 数字与清单（端点/表/迁移/脚本/测试数/默认值/环境变量）② 失效链接与死引用 ③ `done` 声明可信度 ④ quickstart 可执行性 ⑤ 同一事实多处口径不一 ⑥ 版本一致性。

### 1.2 探查工具与顺序

按 `AGENTS.md` §1：代码符号先走 CodeGraph（`codegraph explore` / `codegraph node`，索引 1,974 文件 / 38,094 节点，`status` 显示 up to date），文档与配置走 `read` / `grep`。CodeGraph 用于 `PROTOCOL_CONTROL_PLANE_MIN`、`isControlPlaneUnavailable`、`ControlCommandResult` 等 done 声明的落点核实。

### 1.3 先读守卫判据，只报覆盖不到的部分

按要求先读了 **10 个**文档守卫的判据（注释头），再逐条判断「这条漂移是否已被机械覆盖」。

> **先纠一个委派指令里的路径事实**：任务给的守卫清单写的是 `scripts/check-docs.mjs` 与 `scripts/check-api-reference-appendix.mjs`，**这两个路径都不存在**。真实位置是 `scripts/docs/check-docs.mjs`（子目录）与 `scripts/gen-api-reference-appendix.mjs`（是**生成器** + `--check` 模式，不是 `check-*` 命名）。npm 别名分别是 `check:docs` / `check:api-reference`。`ls scripts/check-*.mjs` 共 45 个，`ls scripts/docs/` 另有 2 个——按 `check-*` 前缀扫会漏掉 `check-docs`，这大概就是清单写错的成因。

| 守卫 | 判据（读自源码注释头） | 本次实跑 |
|---|---|---|
| `scripts/docs/check-docs.mjs` | ①Markdown 相对链接可解析 ②`docs/` 孤儿可达 ③根目录 MD 白名单 ④**反引号**内的仓库相对路径必须存在 | **exit 1**（4 条死链，全部来自本轮并行产出的 `sdk-dx.md`，非既有文档） |
| `scripts/check-cli-doc.mjs` | `cli.md` 每节计数 = 代码 `.command(` 数；标题总数 = 全部 `.command(` + `login.ts` 根命令 | exit 0，`69 = 66 + 3` |
| `scripts/check-atlas-counts.mjs` | ①迁移数+首尾文件名 ②模块索引表行数 ③`atlas/README.md` 应用数 | **exit 1**（迁移数/末个迁移名不符，见 DT-12） |
| `scripts/gen-api-reference-appendix.mjs --check` | 附录与 openapi 逐字节一致 | exit 0，206 路径 / 240 操作 |
| `scripts/check-sdk-docs-truthfulness.mjs` | `ctx.` 示例必须显式引入 SDK + 必须写明 requirements 口径 | exit 0（2 篇） |
| `scripts/check-user-facing-language.mjs` | 面向用户英文 0 处 | exit 0 |
| `scripts/check-audit-actions-doc.mjs` | 68 个审计 action 全部在 `audit.md` | exit 0 |
| `scripts/check-metric-docs.mjs` | 注册表 41 指标 ↔ 文档双向比对 + 基线棘轮 | exit 0（41/38/欠账 3），selftest 15/15 |
| `scripts/check-interface-maps.mjs` | MCP 56 工具 / REST 30 前缀 / SDK 版本 / 审计标签 | exit 0 |
| `scripts/check-index-drift.mjs` | 63 个命名 `@Index` ↔ 迁移 DDL | exit 0 |

**因此本文排除**：文档间相对链接死链、`docs/` 孤儿、CLI 命令计数、atlas 迁移/模块/应用计数、REST 端点清单、SDK 示例、审计动作、指标名、索引漂移——这些都有守卫且本次为绿（除已单列的 atlas 迁移数与在途死链）。

### 1.4 样本量

- 数字/清单抽查：**98 处**（README 三语 11、`docs/*.md` 34、`docs/atlas/**` 41、`docs/design/**` 12），其中 20 处见 §4 逐条，其余为核对通过项（见 §2.2）。
- 链接/引用抽查：**27 个**（相对链接 9、反引号裸路径 6、**代码块内路径 4**、`npm run` 引用 8）。
- `file:line` 引用全量扫描：**545 处**（自动比对文件存在性与行号上界）。
- `done` 声明核实：**5 条**（4 条兑现见 §2.2，第 5 条 ARCH-20 见 DT-09）。
- 版本链：9 个版本承载文件全量比对。

## 2 未覆盖 / 未实测

### 2.1 未实测（只读纪律下的硬边界）

| 项 | 为什么没做 |
|---|---|
| quickstart 路径 A（`./scripts/demo.sh`） | 需起 8 个容器 + 构建镜像（3–8 分钟）。改为**逐行读 `demo.sh` / `docker-compose.demo.yml` / `demo-seed.mjs`** 核对每个前置与断言，见 §2.2 |
| quickstart 路径 B（`docker compose up -d`） | 同上。改为核对 `.env.example` 必填键、`configuration.ts` 的 fail-fast 判据、compose 端口映射 |
| 全量测试套件 | 未跑 `test:unit`（14 套件）。`07-testing` 的「6603 例 / 2126 例」类数字只做**静态文件与断言计数**，不声称等于实跑数 |
| VitePress 文档站构建 | 未跑 `packages/docs-site` build；站内死链未验 |
| 浏览器/UI 面 | 未开浏览器；quickstart 的菜单路径（「应用 → 应用管理」等）**未点验**，只核对了后端路由存在性 |
| `promtool` / `lhci` / Grafana | 未跑（与 `observability.md` 同一边界） |

### 2.2 §4 之外、核对**通过**的项（避免下轮重复劳动）

- **quickstart 路径 A 的每条断言与代码一致**：`demo:seed → node scripts/demo-seed.mjs` ✓；`make demo → ./scripts/demo.sh` ✓（Makefile:108）；UI 端口 8088（`demo.sh:31 WEB_PORT="${ACF_DEMO_WEB_PORT:-8088}"`）✓；「3 个 demo 任务 + 3 条 SOP」✓（`demo-seed.mjs:52 export const DEMO_SOP_COUNT = 3`，任务 `demo-hello-fixed` / `demo-cron-report` / `demo-fragile`）；`--port` / `--down` / `--reset` / `--logs` 四个开关 ✓；`reset-admin-password.sh` 的 `--demo` / `--user` / `--password` / `--dry-run` ✓。
- **quickstart 的「Node.js 18+」是正确的，不是漂移**：`demo.sh:102` 自己按 `node_major < 18` 判死，并在 `:103` 明写「the demo scripts need Node >= 18 (repo engines require >= 24)」，修复提示指向 `nvm install 24`。路径 A 只需 18，仓库工程面需 24——两者不矛盾。（DT-02 只针对 `development.md`，那里写的是**工程面**前置。）
- **部署环境变量默认值表**（`docs/deployment.md:75-122`，41 行）逐项核对 `.env.example` + `configuration.ts`，抽样 16 项全对：`ZIP_MAX_FILE_BYTES=536870912`、`ZIP_MAX_TOTAL_BYTES=1073741824`、`ZIP_MAX_NESTED_INFLATE_BYTES=67108864`、`TASK_EXECUTION_RETENTION_DAYS=90`（`configuration.ts:662`）、`DISK_CLEANUP_TTL_DAYS=7`、`BACKUP_RETENTION_DAYS=30`、`THROTTLE_LIMIT/TTL=60/60000`、`LOGIN_THROTTLE_LIMIT=20`、`PYTHON_RUNTIME_VERSION_MIN/MAX=3.7/3.14`（`docker-compose.yml:211-212`）、`CLAMD_TIMEOUT_MS=10000`。**这张表是全仓最准的一份数字表**，可作为其他表的范式。
- **`done` 声明抽 5 条，4 条兑现**：ARCH-33（`PROTOCOL_CONTROL_PLANE_MIN` 在 `protocol-compat.util.ts:30` + 专设 spec `protocol-version-consistency.spec.ts:107`）、DEP-04（`app-deployment.controller.ts:240/268/289` 三动作 + 第二人规则注释 `:221`）、SEC-07（`sandbox_unavailable` + `apps/executor-python/tests/test_executor_protocol_contract.py:217` 断言）、N-11（`scripts/check-desktop-update-chain.mjs` + selftest 在位）。第 5 条 ARCH-20 见 DT-09。
- **交接文档的当期数字可复核**：`AGENT_HANDOFF.md` 称 `check-migrations（119 个、下一可用 1790000000075）`→ 实跑一致；称 `check:metric-docs 15/15` → selftest 15/15 ✓；称 `admin-api 380 套件 / admin-web 255 文件` → 静态文件数正是 380 / 255 ✓。**这份交接文档的最新一节是本轮可信度最高的一处。**
- **`file:line` 引用**：545 处中，**live 文档 0 处越界或指向不存在文件**（8 处越界全部落在 `docs/archive/` 的归档审计报告里，归档区按 `docs/README.md` §2.7「不随代码更新」豁免）。行号**指向错位置**的语义问题见 DT-11。

### 2.3 在途噪声（**不是**文档漂移，别记到账上）

1. `check-guards-wired.mjs` 目前 **exit 1**，点名 `scripts/check-cron-guard.mjs` 未接线——该文件 `git status` 为 `??`（未跟踪，12:22 由并行 agent 新建），属在途。
2. `check-docs.mjs` 的 4 条死链全部来自本轮并行产出 `docs/archive/audits/2026-10-29-round3/sdk-dx.md`（`compare/v1.8.0...v1.9.0`），属在途。
3. `package.json` 的 `version` 字段与 `scripts` 段正被并行 agent 改动（`git diff package.json`），但 **`version: 1.11.0` 在 `HEAD` 里就是 1.11.0**（`git show HEAD:package.json`），非在途引入，见 DT-03。

## 3 发现总表

| id | 优先级 | 一句话 | 落点 |
|---|---|---|---|
| DT-01 | **P1** | 开发指南让人装 pnpm 8 / 跑 `pnpm install`——本仓是 npm-only（`packageManager: npm@11.19.0`、无 pnpm lock、有 no-hoisting 守卫），且根 `package.json` 零依赖，`pnpm install` 装了等于没装 | `docs/development.md:8` `:22` `:55` |
| DT-02 | **P1** | 开发指南写 Node.js 20.x LTS，实际要求 >=24（`engines: {"node":">=24"}`、CI 6 处 `node-version` 全为 `'24'`）——20.x 与 `engines` 直接冲突 | `docs/development.md:7` |
| DT-03 | **P1** | 版本链只有根 `package.json` 掉队：1.11.0 vs 其余 8 个文件 1.15.0，且它不在 release-please `extra-files` 里，**永远不会被自动 bump** | `package.json:3` |
| DT-04 | **P1** | `06-infra` 的 CI/部署面板 5 处数字全错：workflow 5→10、job 37→38、`deploy.sh` 129→1963 行、迁移 25→119、e2e 48→16 | `docs/atlas/06-infra/deployment-and-ci.md:3,13,17,26,31,37` |
| DT-05 | **P1** | `07-testing` 的测试规模表整体过期 2–3 倍，且 `test:unit` 套件数写成「9 个不含 desktop」（实际 14 个**含** desktop）、引用不存在的 `e2e-ui09-mobile.spec.js` | `docs/atlas/07-testing/README.md:20-24,27,29,30,36,43,52` |
| DT-06 | P2 | README 三语都写 `acf` 有 67 个子命令，实际 69（`cli.md` 标题与守卫同为 69） | `README.md:226,684`；`README.en.md:198`；`README.zh.md:202` |
| DT-07 | P2 | `README.en.md` 落后于它自己的生成器：缺 4 行 `ALLOW_LOOPBACK_CORS` 警告——英文读者照 README 做，admin-api 启动即退出 | `README.en.md`（应含 `README.md:241-244` 那 4 行） |
| DT-08 | P2 | 文档中心三处口径错：ADR 范围 001~025（实际 028）、atlas「七层」（实际 9 个目录）、quickstart「60 秒 demo」（实际首次 3–8 分钟） | `docs/README.md:28,44,62` |
| DT-09 | P2 | 两个**失效的命令名**：`npm run check:shell-multibyte-var`（实际 `check:shell-multibyte`）、`npm run test:all`（实际 `test:unit`，`test:all` 从不存在） | `docs/design/agent-and-deployment/06-roadmap.md:51`；`docs/PLAN-CLAIMS.md:84` |
| DT-10 | P3 | 两份文档的 `git clone` URL 是占位符 `your-org`，照抄必 404 | `docs/development.md:18`；`docs/deployment.md:261` |
| DT-11 | P3 | 两处 `file:line` 引用指向错误代码（行号存在但内容已移走）：`rollback-semantics` 与 `DB-LEAST-PRIVILEGE` | `docs/rollback-semantics.md:20`；`docs/DB-LEAST-PRIVILEGE.md:36` `:373` |
| DT-12 | P3 | atlas 的 admin-api 迁移自述 117（末个 …072），实际 119（末个 …074）——`check-atlas-counts` 已因此报红 | `docs/atlas/01-apps/admin-api/README.md:64` |

> 计数：P1 5 / P2 4 / P3 3 = **12 条**。

## 4 逐条证据

### DT-01（P1）开发指南要求 pnpm，本仓是 npm-only 且根无依赖

**文档原文**（`docs/development.md`）：

```text
:7   | Node.js | 20.x LTS | https://nodejs.org 或 nvm |
:8   | pnpm | 8.x | `npm install -g pnpm@8` |
:22  pnpm install                       # 注释：安装 Node.js 依赖（monorepo 根目录）
:55  cd apps/admin-web && pnpm dev
```

**实际值**（4 个独立证据，全部指向 npm）：

| 证据 | 命令 / 位置 | 值 |
|---|---|---|
| 声明的包管理器 | `node -p "require('./package.json').packageManager"` | `npm@11.19.0` |
| pnpm 工作区面 | `ls pnpm-lock.yaml pnpm-workspace.yaml` | 两个文件**都不存在** |
| 架构裁定 | `docs/atlas/02-packages/README.md:24`、`:90` | 「根 package.json … **刻意不启用 npm/yarn workspace 提升**（ARCH-20，各 app 独立安装依赖），只提供统一命令入口」 |
| 机械守卫 | `scripts/check-no-hoisting.mjs`（ARCH-28b） | 一旦出现 `workspaces`/`pnpm-workspace.yaml` 即红；实测「8 个子项目 `npm ci` 全部 exit 1」 |
| 根依赖 | `node -p "JSON.stringify(require('./package.json').devDependencies||{})"` | `{}` —— **根一个依赖都没有**，`pnpm install` / `npm install` 在根目录装了等于没装 |

**修法**：删掉 `:8` 的 pnpm 行；`:22` 改为与事实源一致的逐包安装。事实源就是 `Makefile` 的 `install` target（`Makefile:49-60`），它才是仓库认可的入口：

```bash
# 二选一
make install        # 逐包 npm install + uv/venv 装 Python 依赖（= 本仓事实源）
# 或手动，注意根目录不需要装任何东西
cd apps/admin-api && npm install
cd apps/admin-web && npm install
cd apps/executor-node && npm install
cd apps/executor-python && ([ -d .venv ] || uv venv .venv) && uv pip install -r requirements.txt
```

`:55` 的 `pnpm dev` → `npm run dev`（`apps/admin-web/package.json` 有 `dev` script ✓，我核过）。

### DT-02（P1）Node.js 20.x LTS vs 实际 >=24

**文档原文**：`docs/development.md:7` → `| Node.js | 20.x LTS |`（在「环境要求」表，即**工程面**前置）。

**实际值**：

- `node -p "require('./package.json').engines"` → `{"node":">=24"}`
- `.github/workflows/ci.yml` 的 `node-version:` **全部 6 处都是 `'24'`**（`:139` `:212` `:281` `:325` `:395` `:464`）
- 无 `.nvmrc` / `.node-version` / `.tool-versions`（`ls -a | grep -i nvmrc` 空）——`engines` 是唯一事实源
- `scripts/demo.sh:91` 的修复提示也写 `nvm install 24 (repo engines: >=24)`

**为什么是 P1 而不是 P3**：20.x 与 `engines: >=24` 直接冲突。npm 默认只 warn，但一旦有人开了 `engine-strict`（或换 pnpm/yarn，它们默认更严）就装不上；而照 20.x 装的环境跑 `test:main` 之类会碰到 Node 24 才有的 API。这是「按文档做，第一步就偏」的那类错误。

**修法**：`:7` 改为 `| Node.js | 24.x（`engines: >=24`，CI 全量 24） | https://nodejs.org 或 nvm |`；建议顺手在仓库根加 `.nvmrc` 写 `24`，让「事实源」从一份 JSON 字段变成工具可直接消费的文件。

### DT-03（P1）版本链：根 `package.json` 停在 1.11.0，且结构上不会自愈

**文档原文**：`docs/development.md:379-383` 声明版本契约——

> `version.txt` | root 条目的 `version-file`（`release-type: simple` 的事实源）
> **版本号只有一个来源**：root 条目算出新版本后，由 `extra-files` 写入三个 npm 包的 `package.json`、它们的 `package-lock.json`…因此包之间**结构上不可能**出现版本漂移。

**实际值**（9 个版本承载文件全查）：

| 文件 | 值 | 一致？ |
|---|---|---|
| `version.txt` | 1.15.0 | ✓ |
| `release-please-manifest.json` `"."` | 1.15.0 | ✓ |
| `CHANGELOG.md` 顶部 | `## [1.15.0] (2026-10-26)` | ✓ |
| `packages/autocodeflow-node-sdk/package.json` | 1.15.0 | ✓ |
| `packages/acf-cli/package.json` | 1.15.0 | ✓ |
| `packages/mcp-server/package.json` | 1.15.0 | ✓ |
| `packages/autoflow-sdk/pyproject.toml` / `__init__.py` | 1.15.0 | ✓ |
| `packages/autocodeflow-{http,ai,db,notify}` | 0.3.2 | ✓（与 manifest 一致） |
| **`package.json:3`（仓库根）** | **1.11.0** | ✗ **差 4 个 minor** |

**根因**（这条比数字本身重要）：`release-please-config.json` 的 root 条目 `extra-files` 列了 18 个文件，**没有 `/package.json`**：

```json
{"type":"json","path":"/packages/autocodeflow-node-sdk/package.json","jsonpath":"$.version"}
... （三个 npm 包 + lock 双 slot + py SDK + docs-site 五页 + sdk-guide + atlas 两处）
```

所以 `check-release-config.mjs` 的「①版本广播面完整」判据扫不到它（它只校验**已登记**的 extra-files 是否覆盖**已登记的**发布矩阵），`version-guard` 也不读它——**它是一份孤儿版本号，永远不会被任何环节更新，也不会被任何环节判红**。

**修法**（二选一，推荐前者）：① 在 root 条目 `extra-files` 追一条 `{"type":"json","path":"/package.json","jsonpath":"$.version"}`，然后把 `package.json:3` 手工改成 `1.15.0`，下次 Release PR 起自动跟版；② 若认定根版本号无意义，直接删掉这个字段（`private: true` 包不需要 version），并在 `development.md` 的版本契约表里写明「根 package.json 不承载版本」。**不要**只改数字——那只是把同一个坑埋到下一个 minor。

### DT-04（P1）`06-infra` 的 CI/部署面板：5 处数字全错

**文档原文**（`docs/atlas/06-infra/deployment-and-ci.md`，头注「最后核对: 2026-09-19」）：

| 行 | 文档值 | 实际值 | 取值命令 |
|---|---|---|---|
| `:3` | `## 怎么部署（deploy.sh，**129 行**）` | **1963 行** | `wc -l < deploy.sh` |
| `:13` | `## Workflow 文件总览（.github/workflows/，**5 个**）` | **10 个** | `ls .github/workflows/*.yml \| wc -l` |
| `:17` `:26` | `**37 个 job** 的全量质量门禁` / `共 **37 个 job**：` | **38 个** | 解析 `ci.yml` 的 `jobs:` 块，2 空格缩进键共 38 |
| `:31` | `admin-api-migrations`（空库全链 **25 个迁移**…） | **119 个** | `ls apps/admin-api/src/migrations/*.ts \| grep -v spec \| wc -l`；`node scripts/check-migrations.mjs` 亦报 119 |
| `:37` | `e2e-full`（ubuntu，**48 例** Playwright…） | **16 个 `test()`** | `grep -cE '^\s*test\(' apps/admin-web/e2e-full.spec.js` |

漏掉的 5 个 workflow（按字母序，可用 `ls .github/workflows/` 复现）：`auto-label.yml`、`cost-monitor.yml`、`desktop-e2e.yml`、`readme-sync.yml`、`release-hygiene.yml`。其中 `readme-sync.yml` 尤其要紧——它正是 `README.en.md` / `README.zh.md` 的生成器，是 DT-07 的机制来源，而文档总览里根本没提它。

**修法**：五处数字逐个改成上表实际值；`:13` 的表格补 5 行（触发条件可照抄各 workflow 的 `on:` 段）。**并建议把「CI job 数」与「workflow 文件数」做成守卫**：这两项在本条与 DT-05 里各错一次，且都是纯机械可判的（`check-cli-doc` 已经证明了这种守卫便宜好用）。

### DT-05（P1）`07-testing` 测试规模表：整体过期 2–3 倍 + 两个事实性错误

**文档原文**（`docs/atlas/07-testing/README.md`，`:2` 头注「最后核对: 2026-09-13」，`:18` 表头「规模（2026-09-13 静态核实）」）：

| 行 | 文档值 | 实际值 | 取值命令 |
|---|---|---|---|
| `:20` | admin-api 单测 `src/**/__tests__`（**147** 个 `*.spec.ts`），`it/test` 约 **2238** 处 | **360** / **5761** | `find apps/admin-api/src -path '*__tests__*' -name '*.spec.ts' \| wc -l` |
| `:21` | admin-api e2e（**4 个**） | **4** ✓ | `ls apps/admin-api/test/*.e2e-spec.ts \| wc -l` |
| `:22` | executor-node `src`（**21** 个 `*.spec.ts`），约 **276** 处 | **54** / **1083** | 同法 |
| `:23` | executor-python（**16** 个 `test_*.py`），`def test_` **237** 个 | **45** / **808** | `ls apps/executor-python/tests/test_*.py \| wc -l` |
| `:24` | admin-web `src/__tests__/`（**74** 个） | **249** | `find apps/admin-web/src/__tests__ -name '*.test.ts*' \| wc -l` |
| `:27` | registry-pypi `def test_` **58** 个 | **157** | `grep -rhoE '^\s*def test_' apps/registry-pypi/tests \| wc -l` |
| `:29` | 根级全链 `e2e-full.spec.js`（**45 个** `test()`）+ `e2e-ui09-mobile.spec.js`（**2 个**） | **16 个**；**`e2e-ui09-mobile.spec.js` 不存在**（`ls` 报 No such file；`apps/admin-web/` 下只有 `e2e-full.spec.js`） | |
| `:30` | `scripts/*selftest*`（**15 个**） | **32** | `ls scripts/*selftest* \| wc -l` |
| `:36` | `test:unit` → …（**9 个套件**；**不含** desktop 与 scripts 自测） | **14 个套件，且第 14 个就是 `test:desktop`** | `node -p "require('./package.json').scripts['test:unit']"` → 14 段，最后一段 `npm run test:desktop` |
| `:43` | `test:desktop` → `test:main`（**4 个自测**）+ `test:renderer`（1 个） | `test:main` 串 **61 个** `*.selftest.js` | `require('./apps/executor-desktop/package.json').scripts['test:main'].split('&&').filter(s=>/selftest\.js/.test(s)).length` → 61 |
| `:52` | `## CI 里的测试相关 job（ci.yml 实测 **26 个 job**）` | **38 个** | 同 DT-04 |

**为什么是 P1**：`:36` 的「9 个套件；**不含** desktop」是**反向错误**——它会让读者以为「跑 `test:unit` 不覆盖桌面端，得单独跑 `test:desktop`」，而实际上 `test:unit` 已经包含它（这也是 `package.json` 里 `//test:guards` 注释所强调的「本地全绿 → CI 红」那类认知错位的镜像）。`:29` 引用一个不存在的文件，读者按图索骥会白找。

**修法**：整表按上表重算（建议只保留计数、删掉 `it/test` 估算值——标注「静态统计」的估算数每轮都要重算，收益低）；`:36` 改为「14 个套件（含 desktop 与…；**不含** scripts 自测与 `test:guards`）」；`:29` 删掉 `e2e-ui09-mobile.spec.js` 并把 45 改 16。

### DT-06（P2）README 三语：CLI 67 个子命令 vs 实际 69

**文档原文**：

- `README.md:226`（英文段）：`` | **Tooling** | `acf` CLI (67 subcommands), Node/Python SDKs, MCP server (56 tools), VitePress docs site | ``
- `README.md:684`（中文段）：`` | **交付** | `acf` CLI（67 个子命令）、Node/Python 双 SDK、MCP Server（56 个工具）、VitePress 文档站 | ``
- `README.en.md:198`、`README.zh.md:202` 同上（由 `readme-sync` 从上面两处拆出，所以会一起错）

**实际值：69**。`docs/atlas/05-interfaces/cli.md:1` 标题 `# CLI 命令地图（acf，69 个子命令）`、`:20` `共 69 个子命令`，且 `check-cli-doc.mjs` 用代码把 69 钉住：

```text
✔ CLI 命令地图一致：13 节计数与代码相符，总数 69 = 66 个 .command( + 3 个根命令。
```

我独立复算：`commands/*.ts` 的 `.command(` = 63（tasks 23 / apps 14 / approval 4 / deploy 4 / executors 4 / mutex 4 / apikeys 3 / projects 2 / sop 2 / agent 1 / audit 1 / exec 1 / login 0）+ `index.ts` 3 = **66**；`login.ts` 的 `new Command(` 根命令 **3**；合计 **69**。67 对不上任何一种口径（既不是 66 也不是 69），是纯粹的旧值残留。

**注意：这一处正是守卫的盲区**——`check-cli-doc.mjs` 只校 `cli.md`，不校 README。README 里的 56 个 MCP 工具则由 `check-interface-maps.mjs` 覆盖（56 ✓）。

**修法**：`README.md` 两处 67 → 69，然后跑一次 `readme-sync`（或手工同步 `README.en.md` / `README.zh.md`）。顺手把「README 里的 CLI 子命令数」加进 `check-cli-doc.mjs`——它已经算出了正确总数，多断言一行就能防复发。

### DT-07（P2）`README.en.md` 落后于它自己的生成器，缺的是「启动即退出」警告

**机制**（`.github/workflows/readme-sync.yml`）：`README.en.md` = `README.md` 中 `<a name="english">` 到 `<a name="chinese">` 之间的 `awk` 切片 + 一段固定导航尾。所以**它是否同步是机械可判的**：

```bash
awk '/<a name="english">/,/<a name="chinese">/{ if (/<a name="chinese">/) exit; print }' README.md | diff - README.en.md
```

**实测结果**：`README.zh.md` **同步**（diff 只有末尾那 4 行导航，属预期）；**`README.en.md` 不同步**，少 4 行：

```diff
213,216d212
< # For a local trial you also need: ALLOW_LOOPBACK_CORS=true
< #   (compose defaults to NODE_ENV=production + localhost CORS origins, and the
< #    production guard rejects loopback origins unless this is explicitly set —
< #    without it admin-api exits at boot. Use your real domain in production.)
```

**这 4 行不是排版**：`README.md:241-244` 说的正是「不设它 admin-api 启动即退出」。也就是说**英文读者按 README 的 Option 1 走，会在 `docker compose up -d` 后遇到 admin-api 退出，而英文文档里没有任何一句话解释原因**。中文读者没事（`README.zh.md` 是同步的）。`docs/PLAN-CLAIMS.md:2999` 登记过这次补齐的口径（「README Option 1 + quickstart 路径 B 各一行」）——中文与 `quickstart.md` 都补上了，**只有英文产物没重跑生成**。

**修法**：跑一次 `readme-sync` 工作流（或在本地执行那两条 `awk` + 尾注，再提交 `README.en.md`）。**并建议给 `check-docs.mjs` 加第 5 条判据**：`README.en.md`/`README.zh.md` 必须等于对 `README.md` 的机械切片——这比「有人记得跑 workflow」可靠，成本也就十几行。

### DT-08（P2）文档中心三处口径错（`docs/README.md`，它是「唯一入口」）

| 行 | 文档原文 | 实际值 | 取值命令 |
|---|---|---|---|
| `:62` | 架构决策记录（**ADR-001 ~ ADR-025**） | **ADR-001 ~ ADR-028**（28 篇编号 ADR + `adr-template.md` + `README.md` = 30 文件） | `ls docs/adr/adr-*.md \| sed 's/.*adr-\([0-9]*\).*/\1/' \| sort -n \| tail -1` → 028；`docs/adr/README.md:42-44` 已收录 026/027/028 |
| `:44` | `atlas/` …按目录分**七层** | **9 个目录**（`00-overview` … `08-workflows`），且**同一张表下面正好列了 9 行** | `ls -d docs/atlas/*/ \| wc -l` |
| `:28` | `quickstart.md` \| **60 秒 demo**（一键隔离栈） | 首次 **3–8 分钟**（构建镜像），之后 ~30 秒 | `docs/quickstart.md:5` `首次约 3–8 分钟，之后 ~30 秒`；`README.md:61` `The first run builds images (~3–8 minutes…)` 与 `README.md:519` `约 3–8 分钟，视网络` |

`:44` 这条尤其值得记：**「七层」和它下面那张 9 行的表在同一个屏幕内自相矛盾**——没有任何守卫读它，因为 `check-atlas-counts` 只校 `atlas/README.md` 的「N 个应用」。

**修法**：`:62` → `ADR-001 ~ ADR-028`（并建议改成不写死范围，如「见 `docs/adr/README.md` 索引」以彻底免疫）；`:44` → `按目录分九层`；`:28` → `3–8 分钟首次 demo（之后 ~30 秒）`。

**附带一条同源问题**（未单列，属同一文件的同一类）：`docs/adr/README.md:48` 仍写「DOC-04 … 当前已覆盖到 **ADR-012**」，而它与 028 的完整索引在**同一个文件**里。建议同批改成「已覆盖到 ADR-028」。

### DT-09（P2）两个失效的命令名

| 文档原文 | 实际命令 | 证据 |
|---|---|---|
| `docs/design/agent-and-deployment/06-roadmap.md:51`：`` `npm run check:shell-multibyte-var` 已验证通过`` | **`npm run check:shell-multibyte`** | `node -p "Object.keys(require('./package.json').scripts).filter(k=>/multibyte/.test(k))"` → `check:shell-multibyte`（脚本文件名才是 `check-shell-multibyte-var.mjs`，文档把文件名当成了 npm 别名） |
| `docs/PLAN-CLAIMS.md:84`（ARCH-20，状态 `done`）：「Makefile 收敛：test/lint/typecheck 三目标…→ 委托根 `npm run test:all/typecheck:all/lint:all`」 | **`npm run test:unit`**（`test:all` **从不存在**） | `node -p "require('./package.json').scripts['test:all'] ?? 'ABSENT'"` → `ABSENT`；`typecheck:all` / `lint:all` 存在 ✓；`Makefile:91` 现行文字是「等价 `npm run test:unit`」 |

DT-09 的第二条同时是**一条 `done` 声明的精度问题**：ARCH-20 标 done 是成立的（Makefile 确实收敛了、三条 `*:all` 里两条在位、`test` 目标也确实委托了根脚本），但**记录里写下的那个命令名从头到尾不存在**——后来的读者照抄会 `npm error Missing script: "test:all"`。修法：把 `test:all` 改成 `test:unit`（这是 `Makefile:91` 与 `package.json` 共同认可的名字）。

### DT-10（P3）`git clone` 占位符 URL

**文档原文**：

- `docs/development.md:18`：`git clone https://github.com/your-org/AutoCodeFlow.git`
- `docs/deployment.md:261`：同上

**实际值**：`https://github.com/LuluDeer/AutoCodeFlow.git`——这是 `README.md:56`（英文段）/`:235`/`:514`/`:693`、`README.zh.md:32`/`:211`、`docs/quickstart.md:10`/`:58`、`CONTRIBUTING.md:24` 一致使用的地址。

**为什么值得报**：这两处是**唯一**两处 `your-org`（`grep -rn 'your-org' docs/*.md README*.md` 只命中这两行），而且 `development.md:18` 正好在 DT-01/DT-02 那个「本地启动步骤」代码块的第 1 行——同一段里连着三个坑（克隆 404 → pnpm 装不上 → Node 版本偏低）。

**修法**：两处替换为 `LuluDeer`。建议顺手加进 `check-docs.mjs`：`grep -rn 'your-org\|yourname\|example.com/AutoCodeFlow'` 视为红。

### DT-11（P3）两处 `file:line` 引用指向错误代码

全量扫了 545 处 `file:line`（自动判「文件存在 + 行号不越界」），live 文档 0 处越界；但**行号存在 ≠ 指对了**，人工复核抓到两处语义错位：

| 文档原文 | 实际位置 | 判断依据 |
|---|---|---|
| `docs/rollback-semantics.md:20`：`TaskService.rollback(id, dto, user)`（**task.service.ts:1318**）+ `TaskService.rollbackToVersion(...)`（**task.service.ts:2270**） | `rollback` 在 **4245**、`rollbackToVersion` 在 **6099** | `grep -n 'async rollback\|rollbackToVersion(' apps/admin-api/src/modules/task/task.service.ts`；`sed -n '1318p'` 落在 `resolveOperateRoleState` 里，`:2270` 落在乐观锁注释里 |
| `docs/DB-LEAST-PRIVILEGE.md:36`（`:373` 复述）：`apps/admin-api/src/main.ts:124-155`「生产环境 admin-api 在启动时自动跑迁移（非 development 即执行）」 | **`main.ts:129-175`**（docstring `:129-141` + `runMigrationsWithAdvisoryLock(bootstrapDs)` 调用 `:171`）；且 `migrationsRun` 已改为 `false`（`configuration.ts:867`） | `sed -n '124p' main.ts` 是 `}`；`grep -n 'runMigrationsWithAdvisoryLock\|migrationsRun' main.ts configuration.ts` |

DT-11 的**结论**没被推翻（`DB-LEAST-PRIVILEGE` 的论点「只要启动期跑迁移，应用账号就必须有 DDL 权限」依然成立），坏的只是引用坐标；`rollback-semantics` 的语义对照表本身也全对，只是两个方法行号过期（代码增长了约 2900/3800 行）。

**修法**：四处行号改为上表实际值。**更根本的修法**：把「方法名 + 文件」当坐标（现在文档其实已经写了方法名），删掉裸行号——行号在 4 周内必然腐烂，而方法名有 CodeGraph/IDE 兜底。若坚持保留行号，建议加一条守卫：`file:line` 必须落在一个 `function|class|const|def|export` 声明附近（±3 行），否则告警。这条守卫成本低、能一次性覆盖全仓 545 处。

### DT-12（P3）atlas admin-api 迁移自述 117 → 119

**文档原文**（`docs/atlas/01-apps/admin-api/README.md:64`）：

> `migrations/` | **117** 个 TypeORM 迁移（`1717473142678-InitialSchema` 起，`1790000000072-AddAiSopSessionTurnLock` 止…）+ `migrations.spec.ts` 守护测试（数量与首尾由 `scripts/check-atlas-counts.mjs` 守护）

**实际值**：**119** 个，末个是 `1790000000074-AddAgentSessionAutoResumeCount.ts`（`ls apps/admin-api/src/migrations/*.ts | grep -v spec | grep -v '\.d\.ts' | wc -l` → 119；`node scripts/check-migrations.mjs` 亦报 `119 个迁移全部唯一且已注册；下一可用时间戳 1790000000075`）。

**守卫已红**（这正是它该做的事）：

```text
✖ atlas 迁移自述与实际不符：
  · 文档未声明迁移数 119
  · 文档未出现末个迁移 1790000000074-AddAgentSessionAutoResumeCount
```

**为什么仍要单列**：文档**自己声明**「数量与首尾由 `check-atlas-counts.mjs` 守护」——声明是对的，但它现在处于失败态，说明 CI 的红没有被消化。这条不需要新的判断力，只需要**把 117 改 119、末个迁移名换成 …074、并补上 073/074 一句话说明**（现有的 62-72 逐条编号说明要顺延）。注：本条的「文档值就错」是纯事实，不是覆盖重叠——守卫只负责报警，不负责给出正确值。

## 5 建议实施顺序

按「文件不互踩 + 一个 PR 一个主题」排，前两批能直接消掉 3 条 P1。

| 批次 | 内容 | 涉及文件 | 为什么这个顺序 |
|---|---|---|---|
| **A. 新开发者第一步**（DT-01 + DT-02 + DT-10） | 重写 `development.md` 的「环境要求」表与「本地启动步骤」1/5 两步：删 pnpm 行、Node → 24、`git clone` 换真实 URL、安装步骤改 `make install` 或逐包 `npm install` | `docs/development.md`、`docs/deployment.md:261` | 三处同在一个代码块/一张表，一次改完；这是新人 10 分钟体验的入口，且**只有这一批会让「照文档做」直接失败** |
| **B. 版本链自愈**（DT-03） | `release-please-config.json` root 条目加 `/package.json` 的 `$.version`；`package.json:3` 改 1.15.0；`development.md` 版本契约表补一行 | `release-please-config.json`、`package.json`、`docs/development.md` | 必须**先**把 extra-files 补上再改数字，否则下个 minor 又掉队。改完跑 `node scripts/check-release-config.mjs` 应仍绿 |
| **C. README 三语**（DT-06 + DT-07） | `README.md:226/684` 的 67 → 69；再重跑 readme-sync 生成 en/zh（顺带修好英文缺的 4 行） | `README.md` → 生成 `README.en.md` / `README.zh.md` | 必须按这个顺序：先改事实源再生成，否则生成器又把旧值刷回去 |
| **D. atlas 两份**（DT-04 + DT-05 + DT-12） | `06-infra/deployment-and-ci.md` 五处数字 + 补 5 个 workflow 行；`07-testing/README.md` 整表重算；`01-apps/admin-api/README.md:64` 改 119/…074 | 三份 atlas 文档 | 同属 atlas，一次改完一次核；改完连跑 `check-atlas-counts`（应从红转绿）、`check-cli-doc`、`check-docs` |
| **E. 零散失效引用**（DT-08 + DT-09） | `docs/README.md` 三处 + `adr/README.md:48`；`06-roadmap.md:51` 与 `PLAN-CLAIMS.md:84` 的命令名 | 4 份文档 | 纯文本替换，风险最低，可搭任意 PR |
| **F. 行号引用**（DT-11） | `rollback-semantics.md:20`、`DB-LEAST-PRIVILEGE.md:36/:373` | 2 份文档 | 最后做：它需要 `grep -n` 现场确认，且**若采纳「删裸行号只留方法名」的方案，工作量会扩散到全仓 545 处**，应单独立项而不是塞进本轮 |
| **G.（建议新增，防复发）** | 三条便宜守卫：① `README.en/zh` 必须等于对 `README.md` 的机械切片（DT-07）② README 里的 CLI 子命令数 = `cli.md` 标题数（DT-06）③ `file:line` 必须落在声明附近（DT-11） | `scripts/docs/check-docs.mjs`、`scripts/check-cli-doc.mjs`、新脚本 | 本文 12 条里有 7 条属「同一类漂移的第 N 次复现」。这三条守卫各自 < 30 行，且都能在现有 guard 体系里找到同型先例（`check-cli-doc` 就是最好的范本：算出真值 + 钉住文档值） |

**跨批纪律**：工作区有并行 agent 在改 `apps/executor-desktop/**` 与 `package.json` 的 `scripts` 段。B 批碰 `package.json`，落地前先确认并行 agent 已提交，避免又演一次「`git add -A` 卷进别人的文件」（`AGENT_HANDOFF.md` 2026-10-29 第二轮已记过这次事故）。

---

### 与同批其他报告的关系

本报告是 round3 的第 9 份域报告（`INDEX.md` 收录的 7 域 + 未汇入的 `sdk-dx.md` + 本份）。交叉核对后**无重复**：`ci-release.md` 谈的是 CI 的**行为正确性**（覆盖率门、审批闸、rollback 场景），本文只谈**文档写的数字与代码事实是否一致**；`security.md:29` 提到 ADR-028 是作为「配置密钥明文落库已明确接受」的边界记录，本文 DT-08 谈的是 `docs/README.md` 的索引范围还停在 025。本文与 `INDEX.md` §1 的「评审时实测校正」不冲突——本文所有实际值均为本会话当场重跑所得。
