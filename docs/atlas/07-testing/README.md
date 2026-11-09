# 测试体系总览
> 所属: docs/atlas/07-testing · 最后核对: 2026-11-03 · 对应代码: package.json（根）、.github/workflows/ci.yml、apps/*/（各应用测试）、scripts/、apps/admin-web/e2e/legacy/

> **本页数字由 `node scripts/check-atlas-counts.mjs --update` 机械维护**（它只改数字、不动文字）。
> 判据带 **±5% 容差**（`--tolerance`，默认 5%；`--tolerance 0` 恢复旧的精确相等）：偏差超容差才红。
> 另有两条独立判据：**表格 ↔ 命令旁必须精确相等**（文档内部自洽，永不放宽）；
> **单调指标（spec 文件数 / 用例数）不得大于现场值**（领先于现实只能是编的）。
> ⇒ 新增几十个 spec **不会**让本页红；把 7,000 写成 700 才会。

## 测试金字塔（各层定位）

```text
            ┌─────────────────────────────┐
            │  真机矩阵 / 全链 e2e（最上层）│  ← 根级 Playwright 51 例 `test()`（legacy 三份 spec）、Windows e2e、desktop 冒烟、scripts/ 真机自测
            ├─────────────────────────────┤
            │  admin-api 集成 e2e          │  ← test/*.e2e-spec.ts（4 个，bootstrap 完整 AppModule + 真 PG/Redis）
            ├─────────────────────────────┤
            │  契约测试（四端同源）        │  ← packages/contract-fixtures/contract.json 被 4 个客户端包测试消费
            ├─────────────────────────────┤
            │  单元测试（主体）            │  ← admin-api jest / executor-node jest / executor-python pytest / admin-web vitest / 各 package
            └─────────────────────────────┘
```

| 层 | 位置 | 规模（2026-10-31 静态核实） | 运行命令 |
|---|---|---|---|
| admin-api 单测 | `apps/admin-api/src/**/__tests__`（455 个 `*.spec.ts`） | jest，`it/test` 7348 处（静态统计，实跑数以 CI 输出为准） | `npm run test:api` |
| admin-api e2e | `apps/admin-api/test/*.e2e-spec.ts`（4 个） | jest-e2e 配置，需真 PG/Redis | `npm run test:e2e -- --runInBand` |
| executor-node | `apps/executor-node/src`（65 个 `*.spec.ts`） | jest，`it/test` 1216 处（静态） | `npm run test:node` |
| executor-python | `apps/executor-python/tests/`（68 个 `test_*.py`） | pytest，`def test_` 1072 个（静态；另有 142 处 `async def test_` 未计入此列） | `npm run test:python` |
| admin-web | `apps/admin-web/src/__tests__/`（307 个 `*.test.ts/tsx`） | vitest（jsdom） | `npm run test:web` |
| packages（JS） | acf-cli 16 文件 / mcp-server 10 文件 / node-sdk 5 文件 | vitest ×2 + jest ×1 | `test:cli` / `test:mcp` / `test:node-sdk` |
| packages（Py） | autoflow-sdk 8 文件 / 166 用例 · http 2 文件 / 13 · ai 2 / 29 · notify 2 / 2 · db 2 / 30 | pytest（用例数 = `def test_` 静态计数） | `test:sdk-py` / `test:lib-*` |
| registry-pypi | `apps/registry-pypi/tests/` | pytest，164 个 `def test_` | `npm run test:pypi` |
| 契约测试 | [contract-and-selftest.md](contract-and-selftest.md) | 四端共享 `contract.json` | 随各包测试运行 |
| 根级全链 e2e | `apps/admin-web/e2e/legacy/` 三份 spec：`e2e-full.spec.js`（48 个 `test()` + 5 个条件 `test.skip()`）、`e2e-python-executor.spec.js`（1 个）、`e2e-ui09-mobile.spec.js`（2 个） | Playwright chromium，真栈；`playwright.e2e.config.js` 的 `testDir` **只圈 `legacy/`**（`testMatch: '**/e2e-*.spec.js'`） | `bash scripts/e2e-full.sh` |
| 自测/真机脚本 | `scripts/*selftest*`（40 个） | 见 [contract-and-selftest.md](contract-and-selftest.md) | 各自独立命令 |

> 遗留副本 `apps/admin-web/e2e-full.spec.js`（601 行 / 16 个 `test()`，内容停在用例 16）**不在**
> `playwright.e2e.config.js` 的 `testDir` 内，任何入口都不会执行它——统计 e2e 例数时请以
> `apps/admin-web/e2e/legacy/` 为准（`scripts/e2e-full.sh` 与 ci.yml 的 `e2e-full` job 同此口径）。

**上表数字的复核命令**（口径：文件数用 `find`/`ls` 点数；用例数用 `grep -o` 数声明，**静态**，不等于实跑数；
`packages` 行的「N 文件」= 该包 `src/` 下 `.test.ts` 文件数（与各包收集配置对齐：acf-cli / mcp-server 是 vitest `include: ['src/**/*.test.ts']`；node-sdk 是 jest `roots: ['<rootDir>/src']` + `testMatch: '**/__tests__/**/*.test.ts'`，用例都在 `src/__tests__/` 下）；
采样时点 2026-10-31，工作区在动，数字会跟着变，请以命令输出为准）：

```bash
find apps/admin-api/src -path '*__tests__*' -name '*.spec.ts' | wc -l                       # 455
grep -rhoE '^\s*(it|test)\(' apps/admin-api/src --include=*.spec.ts | wc -l                 # 7348
find apps/executor-node/src -name '*.spec.ts' | wc -l                                       # 65
grep -rhoE '^\s*(it|test)\(' apps/executor-node/src --include=*.spec.ts | wc -l             # 1216
ls apps/executor-python/tests/test_*.py | wc -l                                             # 68
grep -rhoE '^\s*def test_' apps/executor-python/tests | wc -l                               # 1072（async def 另 142）
find apps/admin-web/src/__tests__ -name '*.test.ts*' | wc -l                                # 307
find packages/acf-cli/src -name '*.test.ts' | wc -l                                         # 16
find packages/mcp-server/src -name '*.test.ts' | wc -l                                      # 10
find packages/autocodeflow-node-sdk/src -name '*.test.ts' | wc -l                           # 5
grep -rhoE '^\s*def test_' apps/registry-pypi/tests | wc -l                                 # 164
ls scripts/*selftest* | wc -l                                                               # 40（含守卫 check-desktop-selftests-wired.mjs）
```

## 运行命令速查表（根 package.json scripts 逐条核实）

| 命令 | 跑什么 |
|---|---|
| `npm run test:unit` | api + node + python + web + cli + mcp + pypi + sdk-py + node-sdk + lib-http + lib-ai + lib-notify + lib-db + desktop（**14 个套件，含 desktop**，最后一段就是 `npm run test:desktop`；**不含** scripts 自测与 `test:guards`） |
| `npm run test:guards` | **守卫/自测两面门禁**：`test:guards:repo`（判据型 `check:*`，含 DOC-GOV 与 `check:guards-wired`，离线无 DB/网络，**约 40 秒**）+ `test:guards:selftests`（真机/行为型自测，含 admin-api/executor-node 构建，分钟级）。CI 在 `check-migrations`（判据型）与 `selftests`（行为型）两个 job 跑同一批；新增守卫见本文末「新增一个守卫的 checklist」 |
| `npm run test:api` / `test:node` | admin-api / executor-node 的 jest |
| `npm run test:python` / `test:pypi` | executor-python / registry-pypi 的 pytest |
| `npm run test:web` / `test:cli` / `test:mcp` | admin-web / acf-cli / mcp-server 的 vitest |
| `npm run test:node-sdk` | autocodeflow-node-sdk 的 jest |
| `npm run test:sdk-py` | autoflow-sdk（Python SDK）pytest |
| `npm run test:lib-http` / `lib-ai` / `lib-notify` / `lib-db` | 四个 Python 库 `python -m pytest tests -q` |
| `npm run test:desktop` | executor-desktop `test:main`（串联 **61 个** `*.selftest.js`）+ `test:renderer`（1 个 `renderer.selftest.mjs`） |
| `npm run test:registry-npm` | registry-npm 配置三处一致性自检 |
| `npm run test:private-registry`（`:live` / `:dispatch`） | BUG-18 私服契约（默认 dry-run / live 双仓 / executor 侧派发链） |
| `npm run test:arch31-multi-instance` / `test:arch31-rollout` / `test:arch31-outbox` | ARCH-31 多实例三真机门禁 |
| `npm run test:nginx-sse` / `test:qa05-callback-tier` | BUG-17 反代 SSE / QA-05 回调 10k 分钟真机门禁 |
| `npm run demo:seed:selftest` / `demo:failure:seed:selftest` / `bench:micro:selftest` | 种子与基准工具自检 |
| `npm run typecheck:all` / `lint:all` | 类型 / 规范（executor-node 的 `lint:node` 显式跳过，ARCH-20） |
| `bash scripts/e2e-full.sh` | 全链 e2e 编排（`SKIP_DOCKER=1` 复用外部 PG/Redis），见 [e2e-testing.md](e2e-testing.md) |

## CI 里的测试相关 job（ci.yml 实测 38 个 job）

| job | 内容 |
|---|---|
| `admin-api-test` | typecheck + lint + `npm test -- --coverage` + 迁移 + e2e（`--runInBand`） |
| `admin-api-migrations` | 空库全迁移链 + 二跑幂等守卫；月度（schedule）追加实体/迁移漂移检查与 revert 演练 |
| `executor-node-test` / `acf-cli-test` / `mcp-server-test` / `autocodeflow-node-sdk-test` | 各包 build/typecheck + 测试（node-sdk 带 coverage） |
| `admin-web-build` / `windows-admin-web` | lint + build（admin-web 的 vitest 不在 CI） |
| `executor-python-test` / `autoflow-sdk-python-test` / `python-packages-test` / `registry-pypi-test` | pytest（python 3.12；python-packages-test 为 http/notify/db/ai 四包矩阵） |
| `windows-node-tests` | windows-latest 上 executor-node / acf-cli / mcp-server 单测（Windows 兼容基线，R15-3.5） |
| `e2e-full` | ubuntu 全链（legacy 三份 spec：`e2e-full.spec.js` 48 例 + `e2e-python-executor` 1 例 + `e2e-ui09-mobile` 2 例 = 51 例；PG/Redis 由 services 提供，`SKIP_DOCKER=1`）。⚠️ step 名仍写 `Run 48-case full-chain e2e`——48 只是首份 spec 的数，三份合计 51；同 job 头注释在 Windows 侧又写「29 例」，读 CI 文案请以本表为准 |
| `e2e-full-windows` | 同一 spec 在 windows-latest（仅 PR / 手动 / schedule，W-28） |
| `desktop-linux-bundle` | 桌面端 `test:main` 自测 + 打包闸（仅 PR / 手动） |
| `desktop-e2e-smoke` | Playwright `_electron` 冒烟 8 例（含 locale 无关化 + preload 通道白名单防漂移）；**每次 develop push 跑**（2026-10-08 起，此前 PR/手动门控导致 6/6 develop push 全 skip、长期无人发现地腐烂） |
| `desktop-bundle-drift` | 离线重打 ncc bundle 与入库产物 git diff（W-18 防漂移） |
| `check-migrations` / `private-registry-contract` / `npm-audit` / `lockfile-integrity` / `secret-scan` | 迁移登记自检 / 私服契约（dry-run）/ 依赖审计（moderate+ 红灯）/ lockfile 漂移 / 泄漏扫描 |
| `api-types-drift` | OpenAPI 导出与前端类型生成物 diff（契约面防漂移，ARCH-23） |
| `docs-site-build` | 文档站 sync-check（DOC-09）+ VitePress 构建（死链即红） |
| `docker-multiarch-build` | ARM64/amd64 三镜像只 build 不 push（BUG-20 构建闸，非测试但同属质量门） |

schedule（每月 1 日 03:20 UTC）触发时主套件旁路，仅跑迁移演练与冒烟（QA-08）；同分支旧跑自动取消（concurrency）。

## coverage 门槛（以 apps/admin-api/package.json jest 配置为准）

- `coverageThreshold.global`：**branches 75 / functions 69 / lines 84 / statements 84**（%）。
- 注意：ci.yml 内注释写的是"stmts 68 / branch 58 / funcs 56 / lines 69"，**已滞后于配置**，以 package.json 为准。
- 工作区最近一次本地运行的 `apps/admin-api/coverage/lcov.info` 汇总：lines 91.45%、functions 82.17%、branches 78.32%（残留产物，仅作水位参考）。

## 各文档导航

- [admin-api-testing.md](admin-api-testing.md) — 后端单测/e2e 组织、Jest 配置、关键 spec 清单
- [executors-testing.md](executors-testing.md) — 三执行器（node / python / desktop）测试与自测
- [frontend-testing.md](frontend-testing.md) — admin-web vitest 能测什么、不能测什么
- [e2e-testing.md](e2e-testing.md) — 根级 51 例全链 e2e（legacy 三份 spec）、运行环境、与 admin-web/e2e 分工
- [contract-and-selftest.md](contract-and-selftest.md) — 契约四端消费 + scripts 自测清单 + 真机矩阵
- [testing-conventions.md](testing-conventions.md) — 命名/组织/mock 纪律/最小回归集/薄弱点

## 新增测试放哪（速判）

1. admin-api 业务逻辑 → `src/modules/<mod>/__tests__/<name>.spec.ts`（jest 自动收）。
2. admin-web 组件/工具 → `apps/admin-web/src/__tests__/<name>.test.tsx|ts`。
3. executor-node → 源码同目录 `<name>.spec.ts`；executor-python → `tests/test_<name>.py`。
4. 客户端包契约相关 → 消费 `packages/contract-fixtures/contract.json` 向量，别另造样例。
5. 跨服务/真机才能验证的 → 优先并入 `e2e-full.spec.js` 或 scripts 真机自测，并在 [VERIFY-MATRIX](../../VERIFY-MATRIX.md) 登记。

## 新增一个守卫的 checklist（`scripts/check-*.mjs`）

守卫与普通测试的差别：它**读仓库事实**、**打印判据**、**用退出码表态**，而且必须被门禁**真的跑到**。
加一个守卫很便宜，接进两面才是让它生效的那一步——漏接是**完全静默**的（脚本存在、本地能跑、README 可能还写着它，CI 从不执行）。
判据型的 `check-*.mjs` 现 **91** 个（`scripts/` 下 **89** 个 + `scripts/docs/` 下 **2** 个：`check-docs.mjs` / `check-doc-style.mjs`），加上 `scripts/*selftest*` **40** 个自测文件（组成见 [contract-and-selftest.md](contract-and-selftest.md)），都归本文这一节管。
（上一版这里写的是「44 个 / 28 个」—— 那是 **2026-10-30 → 11-01** 的快照。）
（口径注：三个「守卫数量」**分母不同、不可互相替换** ——
① 本行的 **91** = `check-guards-wired` 自报的「91 个 `check-*.mjs` 全部被 CI 执行」那个口径
（`scripts/` 89 + `scripts/docs/` 2，**不含** `*.selftest.mjs` 伴生自检、**不含**覆盖式豁免的
`check-route-authz-matrix.mjs`、**不含**扫描面外的 `examples/scripts/check-task-examples.mjs`）；
② 「扫描面 **98** 个」= **判别型脚本**口径 = `check-*` ∪ `agent-*`（覆盖计数判据④ 的分母，含 6 个 `agent-*`）；
③ `scripts/` 下 `check-*.mjs` 原始 glob = **90**（比①多一个伴生自检 `check-brand-drift.selftest.mjs`）。
三个数各自成立，但都不是「仓库里 `check-*.mjs` 文件的总数」—— 那个总数是 **96**
= ① 的 91 ＋ **3** 个 `check-*.selftest.mjs` 伴生自检（`scripts/check-brand-drift.selftest.mjs` /
`scripts/docs/check-docs.selftest.mjs` / `scripts/docs/check-doc-style.selftest.mjs`）
＋ 覆盖式豁免的 `apps/admin-api/scripts/check-route-authz-matrix.mjs`
＋ 扫描面外的 `examples/scripts/check-task-examples.mjs`，
**与「被 CI 执行的守卫数」无关**，别拿它解释①或②。）

### 1. 自检必须用共享 harness

唯一入口是 `scripts/lib/guard-selftest.mjs`（零依赖，`npm run check:guard-harness` 跑它自己的自检）：

| API | 用途 |
|---|---|
| `runGuard(script, { args, cwd, env, timeoutMs })` | `spawnSync(process.execPath, …)` 跑**真脚本**，返回 `{ code, stdout, stderr, timedOut, durationMs }`；脚本不存在立即抛错 |
| `expectExit(result, { code, contains, absent, withinMs, label })` | 断言退出码 + 关键报错文本（`contains`）/该绿的树上不许出现（`absent`）；不符**抛错**——不让「忘了看返回值」静默通过 |
| `makeFixtureRepo(files, { prefix })` | 在 `mkdtemp` 里造最小树（`{ "相对路径": 内容 }`，非 string 按 JSON 写），配 `--root` 用；返回 `{ dir, cleanup }` |
| `reportCases([{ name, fn }], { title })` | 统一 ✔/✘ 输出 + 汇总行，返回失败条数 |
| `REPO_ROOT` | 仓库根绝对路径（由本文件位置推出，不依赖调用方 cwd） |

**为什么必须跑子进程**：只断言内部函数的自检测的是**函数**不是守卫——`process.exit(1)` 被删掉、报错文本改两个字符、
`--root` 把路径吃掉（于是扫空目录、「0 条 = 没问题」），这三种「假绿」它都看不见。用例要**有本事失败**：
每条负例都配一条正例控制组，否则「expectExit 永远抛」也能让全部负例通过。

### 2. 三条约定：`--root` / 扫描面下界 / 结构红

- **`--root <dir>`**：仓库根当参数传，别硬编码 `process.cwd()`（**`scripts/` 下 90 个 `check-*.mjs` 现已全部支持**；R147 之前是 90 中 81 支持、9 个不支持：`check-agent-event-limits` / `check-brand-drift`(+`.selftest`) / `check-collaborator-self-call` / `check-npm-audit-exemptions` / `check-protocol-three-way` / `check-sanitize-parity` / `check-source-text-contracts` / `check-spec-coupling-surfaces`，本轮全部补齐）。只给 selftest 用：
  把 fixture 树当仓库根扫，默认 `process.cwd()`。
- **扫描面下界**：判据不许以「0 条 = 没问题」结尾。每个扫描面配一个 `MIN_*`（如 `check-atlas-counts` 的
  `MIN_MIGRATION_FILES = 20` / `MIN_MODULES = 10` / `MIN_APPS = 5`），实测低于下界即红——**分母塌了不等于事实都合规**。
- **结构红**：源码改名、正则失效、事实源文件缺失这类「解析不出来」的形态必须 `exit 1` 并点名「结构红 / 扫描器失效」，
  不许退化成「漂移 0 项」或静默跳过。selftest 里对应一条「把解析面砸掉 → 必须结构红」的反证用例。

### 3. `check-guards-wired` 的三条判据（本仓的「生效」定义）

`node scripts/check-guards-wired.mjs` 判定「守卫真的在跑」，`--selftest` 在临时假根里用真子进程反证误绿/误红形态（含判据③ 的六种形态与豁免校验）：

1. **CI 直接执行**：文件名出现在任一 `.github/workflows/*.yml` 的 `run:` 段里（YAML 注释先剥掉——被注释掉的步骤不算）；
2. **CI 经 npm script 执行**：文件名出现在某个 `package.json` script 里，且**那个 script 名**被某个 workflow 调用
   （CI 常写 `npm run check:xxx` 而不写文件名）；
3. **自检被真的执行**（2026-10-29 新增）：凡「有自检」的守卫——源码里有**字符串字面量** `--selftest`，或存在伴生
   `<stem>.selftest.mjs`——本地 `test:guards` 与 CI 都必须真的展开到这条自检调用。①② 只管「脚本被跑」，
   对「自称有自检、自检永远不执行」完全盲（2026-10-29 审计实测 13 处长期存活且前后都绿）。

现况（2026-11-07 实跑 `node scripts/check-guards-wired.mjs`，HEAD `a13f0b88`；**R162 起扫描面含 `agent-*`**）：**97 个守卫（`check-*` ∪ `agent-*`）全部被 CI 执行**（另 1 个 `check-route-authz-matrix` 覆盖式豁免）；
**97 个守卫（`check-*` ∪ `agent-*`）有自检，其中 96 个在本地 `test:guards` 与 CI 都真的跑了自检**（1 个自检豁免，0 个只接一面）。
（R162：判据扫描面从 `check-*` **扩到 `agent-*` 族** ⇒ **91/90 → 97/96**。此前 `agent-*` 全在判据①②③ 的扫描面外 ⇒
本族里「补了 `--selftest` / 加了守卫，但**没人跑它**」是一整类**判据盲区**。两条 audit 守卫
`agent-context-token-audit` / `agent-event-projection-audit` 早已自带 `--selftest`，只是从未被接线 ⇒ 本轮补接。
它们**只接自检、不接主跑**（主跑要连库取 ≥30 轮样本，CI 临时库没有 ⇒ 挂进去只会稳定红 = 用假红换假绿）。）
（R155：两条此前**零自检**的守卫 —— `check-categories-single-source` / `check-cross-end-consistency` ——
补了自检并接进两面 ⇒ 89/88 → **91/90**。）
（R156：修掉一个**判据自身的口径 bug** —— `detectSelftest` 用裸正则扫全文，把**注释里**带引号的
`--selftest` 也算成「有自检」，与它自己头注写的口径相反 ⇒ 改用只抹注释、保留字面量的
`stripCommentsKeepStrings`。**判据在数「注释」还是「实现」，会决定它是在保护还是在制造噪音。**）
（上一版这里写的是 46 / 47 / 46 —— 那是 **2026-10-30** 的快照，其间新增了 45 个守卫，数字已过期约一个半月。）
覆盖面提醒：**「守卫数量」与「受覆盖计数保护的守卫数量」是两回事** —— 判别型脚本共 **98** 个
（`check-*` ∪ `agent-*`），但只有 **13** 个已登记覆盖计数（能报出可解析的用例计数且 ≥ 下界），
其余 **85** 个**尚无覆盖计数保护**（它们仍受接线与自检面约束，但不强制「用例数不得塌方」）。
豁免必须**可证**：`ALLOWLIST` 管①②、`SELFTEST_ALLOWLIST` 管③，两套分开；标 `wired` 的那一面会被事实核对，
对不上（声称 CI 跑了但 ci.yml 里没有）与陈旧豁免同样是**结构红**。

### 4. 两面接线（缺一面 = 白写）

| 面 | 落点 | 跑什么 |
|---|---|---|
| 本地 | 根 `package.json` 的 `test:guards` = `test:guards:repo` && `test:guards:selftests` | 判据型 `check:*`（离线、约 40 秒）+ 真机/行为型自测（要构建，分钟级） |
| CI | `ci.yml` 的 `check-migrations` job（判据型，与 DOC-GOV 同 job）+ `selftests` job（行为型） | 同一批脚本，直接写 `node …` 或 `npm run check:*` |

新增守卫：① 用 harness 写 `--selftest`（含反证：把修好的事实改回去必须红）② 两边接线
③ `npm run check:guards-wired` 自证没有只接一面 ④ `npm run test:guards` 本地跑一遍。

### 5. 测试替身保真（`check-agent-stub-fidelity.mjs`，2026-11-01 事故驱动）

`scripts/agent-*.mjs` 绕过 jest 直接起运行时，依赖是**手写的对象字面量**替身。生产加了一个方法、
替身没跟上，测的就不再是生产语义，而是「碰巧没走到那一行」——直到 CI 上真走到它。
2026-11-01 develop 的 `selftests` 红就是这个形态：

```text
TypeError: this.sessionService.tryAppendEvent is not a function
```

G1 给 `AgentSessionService` 加了 `tryAppendEvent`，生产 `agent-runtime.service.ts` 也调了它，但
`scripts/agent-runtime-check.mjs` 里的替身没加。而那个脚本里**逐字写着**「替身必须保真（ADR-027）」——
**纪律在、守卫不在，所以它腐烂了**。注释不会让 CI 变红，只有断言会。

`node scripts/check-agent-stub-fidelity.mjs` 的三步判据（都能人工复核）：

| 步 | 做什么 |
|---|---|
| ① 找替身 | `scripts/agent-*.mjs` 里**方法简写 ≥2** 的对象字面量；按工厂/变量名（`session` / `boundary` / `approval`）或「方法名与生产调用集交集 ≥2」判角色（工厂被改名也抓得住；`makeAi` 这类无关替身交集为 0，自动排除） |
| ② 找生产调用 | `apps/admin-api/src/modules/agent/`（排除 `__tests__`、`*.spec.ts`）的 `this.<角色>.<方法>(`，**跨行**匹配；排除 `?.` 可选链（那是「可以没有」的显式声明）、注释，以及声明类型为 `Repository<…>` 的同名属性（那是 TypeORM 仓储，不是服务） |
| ③ 双向比对 | 生产调用的方法替身**必须**有 ⇒ 缺即**红**；替身有、生产不用的 ⇒ 只 **warn**（可能是预留） |

**结构红（绝不判绿）**：`--root` 树不完整（缺 `scripts/` 或 `apps/admin-api/src/modules/agent/`）、
一个替身都没找到（正则/命名面失效）、生产调用零处、某个**有替身**的角色在生产侧零调用。
反证方式：把真树替身里的一个方法删掉 ⇒ 必须红；`--selftest`（15 条用例，含正例控制组）里
有一条专门复刻事故的**换行**形态 `this.sessionService` + 换行 + `.tryAppendEvent(`。

**盲区（必须知道）**：间接调用（`const s = this.sessionService; s.foo()`）、`this["sessionService"].foo(`、
把服务传出去再调，都看不见；`agent.controller.ts` 用 `this.sessions.` 注入同一个服务，也不在判据内
（它不是替身要满足的契约面）。**绿只等于「直接调用点都有同名方法」，不等于替身语义保真**——
返回 `false` 还是 `undefined`、抛不抛错，仍然只能靠 harness 自己的断言（ADR-027 的另一半）。

### 6. 拼出来的代码也要被解析校验（`check-windows-gui-script.mjs`，2026-11-02）

`gui-windows.ts` 用 `String.raw` 内联了约 230 行 PowerShell（`Reply` 回话协议 + `Add-Type` 注入
user32 P/Invoke）。它**从来没有被任何东西校验过**：`gui-windows.selftest.ts` 把 `invoke` 整体 mock 掉，
130 行自检没有一行触到脚本文本；CI 里也没有 Windows PowerShell 解析器。于是少一个 `}`、
here-string 的 `'@` 缩进一格、模板里混进一个 `${`——**只有真机 Windows 打到那一步才炸**，
现场表现是 `invalid_powershell_response`（脚本根本没跑起来，stdout 为空），
日志里分不清是「脚本语法错」还是「Windows API 抽风」。

判据（纯静态，`node scripts/check-windows-gui-script.mjs`，零依赖、不需要 PowerShell）：

| # | 判据 | 怎么复核 |
|---|---|---|
| ① | 从 `gui-windows.ts` **解析**出 `String.raw` 模板体（**不复制脚本文本**，副本必然与源漂移） | 报告给出内容行号区间 `L…-L…` |
| ② | `{}` / `()` / `[]` 平衡（**先剥**字符串、here-string、`#` 注释，否则 C# 里的 `'{'`、`"user32.dll"` 会误报） | 打印三类开/闭计数 + 最大嵌套 |
| ③ | 单/双引号成对（`''`、反引号为转义）；here-string 闭合且终止符**必须在行首**（PS 5.1 硬约束） | 打印段数与起止行号 |
| ④ | 不得出现 `${`（该脚本设计上不接收任何插值，模型输入只走 stdin 的 JSON） | 打印命中数（应为 0） |
| ⑤ | 必需结构：`function Reply` / `try` / `catch` / `ConvertTo-Json` / `$ErrorActionPreference='Stop'`；失败路径必须落在 `catch` 里的 `Reply`（进程 exit 0），禁止 `exit <非零>` | 逐项列名 |
| ⑥ | **结构红**：取不到脚本 / 模板未闭合 / 非空行 < 50 ⇒ 打印「判据瞎了」+ `exit 2`，**绝不当绿** | 反证：`--root` 指向缺失、改名、掏空的树 |
| ⑦ | **第二半**：`gui-windows.selftest.ts` 的 `[script-assert:begin]` 段必须真有 ≥ 2 条脚本文本断言（否则 mock 掉 `invoke` 的自检又变回「什么都没验」） | 删掉该标记段 ⇒ 判据⑦ 红 |

退出码：`0` 全绿 / `1` 有判据不通过 / `2` 结构红（判据瞎了，连「有没有问题」都无从判断）。
反证（本机实跑）：临时副本里删掉 `Reply` 里的一个 `}` ⇒ 判据② 红并点名 `gui-windows.ts:88`；
同一份坏脚本喂给编译后的 selftest ⇒ `AssertionError: 括号 {} 不平衡（净差 1）`。
`--selftest` 共 14 条用例，含**两条正例控制组**（真仓库 / 未改坏的 fixture），
避免「判据永远抛」也能让负例全通过。

跨文档：CI 细节见 [deployment-and-ci](../06-infra/deployment-and-ci.md)；脚本全图见 [仓库脚本地图](../06-infra/scripts.md)；任务全链背景见 [任务生命周期](../04-flows/task-lifecycle.md)。

## 守卫覆盖哨兵（判据④：被登记的守卫必须报出可解析的用例计数，0 即红）

> 所属: docs/atlas/07-testing · 最后核对: 2026-11-01 · 对应代码: scripts/check-guards-wired.mjs（判据④）、scripts/lib/agent-coverage.mjs（计数口径）、scripts/coverage-registry.json（登记表）

### 病：零条断言 = 全部通过

判据①②③ 管的是「守卫**有没有被跑到**」。它们对另一件事**完全盲**：
守卫的用例被整体删除或注释掉时，守卫照样打印「=== 全部触发器断言通过 ===」并退出 0 ——
**CI 全绿，而它保护的东西一个都不剩了**。这不是「守卫失败」，是「守卫变得什么都没检查」。

所以需要**第二条视野**：它被跑到了，它**还剩下用例吗**。

### 为什么这条判据挂在守卫的守卫上，而不是挂在守卫自己里

- **自证无效**：守卫判自己 = 被测对象自己出考卷。守卫源码是「被测面」的一部分，改守卫的人
  顺手就能把断言改没、顺手就能把计数改成 0。
- **同族互查会一起绿**：让 A 守卫查 B 守卫，两族互查 ⇒ 整族被删就整族绿，谁也不报警。
- **本仓已有一只「守卫的守卫」**：判据④ 与①②③ 挂在同一个落点（`check-guards-wired.mjs`，
  CI 里同一条命令），比另起一个脚本更容易被盯住 —— 少一个需要被记住的入口。

### 「用例计数」的真实口径

计数 = **守卫源码里断言调用点的个数**（`check(` / `must(` 这类断言函数的调用点），
**不是**运行期被执行了多少次。理由：

1. **依赖无关**：四个 agent 守卫要 `apps/admin-api` 的 typescript / reflect-metadata 才能跑完
   （缺了就崩）。计数行必须在**崩之前**打出来，否则「机器没装依赖」会被误读成「零用例」。
2. **可判定**：运行期次数受循环影响（同一调用点执行 N 次），不适合当「删光了没有」的分母；
   调用点数是**源码的事实** —— 用例被删掉或注释掉，它一定掉。

计数行长这样（独占一行）：

```text
COVERAGE_CASES: 79
```

守卫侧出口在 `scripts/lib/agent-coverage.mjs` 的 `printCoverageBanner()`：用 `fs.writeSync(1, …)`
而不是 `console.log` —— 前者是**同步**写，守卫在下一行崩掉时这行也一定被父进程读到（管道上的异步写会丢）。

### 判据④ 的四条红线（人可自己核对）

| # | 红线 | 后果 |
|---|---|---|
| ① | 守卫输出里**没有** `COVERAGE_CASES:` 计数行 / 格式坏 / 出现互相冲突的两个计数 | **结构红**（不是绿） |
| ② | 守卫打印的 N ≠ 哨兵从**源码**数出的 M | **结构红**（有人在写死数字 = 作弊，或两边不一致无法判断） |
| ③ | N = 0 | **红**，点名这个脚本 |
| ④ | N < 登记表里的 `floor` | **红**，点名这个脚本 |

另有一条**结构性**红线：**登记表本身**是空的 / 读不到 / JSON 坏了 ⇒ 结构红。
（空表 ⇒ 判据④ 变成永远绿的死条文 —— 与仓库其它判据的「扫描面下界」是同一个纪律。）

**为什么「解析不出来」不能算绿**：判据本身失效时，无法区分「守卫没用例」与「哨兵读不出来」。
默认往乐观方向猜 = 把「查不出病」当成「没病」。按仓库惯例（`--root` 把路径吃掉 → 扫空目录 → 结构红），
这类形态一律结构红。

**为什么不要求守卫退出码为 0**：CI 里跑本脚本的那个 job 没装 admin-api 的依赖，agent 守卫会在
`require("reflect-metadata")` 处崩掉 —— 但崩之前计数行已同步写出。所以**计数行是判据主体**，
退出码只作参考：计数合法但退出码非 0 ⇒ 只打 `⚠`（那是「守卫自己失败了」，由该守卫自己的 job 负责）；
退出码非 0 **且**没有计数行 ⇒ 走红线①（这时「零用例」与「崩了」无法区分，不能猜）。

### 登记表（`scripts/coverage-registry.json`）

每条 = 一个**可证的事实**：`helper`（断言函数名，决定「用例」在这个守卫里长什么样）、
`floor`（用例数下界）、`args`（跑它要带的参数）。本轮只覆盖 `agent-*` 一族（规格：
「先只覆盖 `agent-*.mjs` 一族，不做全仓改造」）。

### 已知盲区（显式登记为未覆盖）

**扫描面 98 个判别型脚本（`check-*.mjs` 92 个 ∪ `agent-*.mjs` 6 个），登记表只覆盖 **82** 个
⇒ 另有 **16** 个守卫尚无覆盖计数保护。**（R154 13→25，R155 25→28，R156 28→29，R159 29→34，R160 34→54，见下） 这个差额由 `check-guards-wired.mjs` 每次运行都打印出来，
不许靠「没人问就不说」蒙混。

> **2026-11-07 实跑**（`node scripts/check-guards-wired.mjs`）= 上面这行数字；
> **R154 扩面 13 → 22**：新登记的 9 条此前**已经在打印 `COVERAGE_CASES`，但打印的是
> `subprocess` 口径（恒为 0）** —— 即「**有计数行、计数恒 0**」= 看起来被覆盖、实际
> **没有任何下界**（floor 0 对任何用例数都成立）。换成真实用例注册口径 `push` 后，计数
> 变成 31/7/7/6/6/5/5/5/5（第二批又修 3 条各 3）⇒ floor 才有意义。**这比「没有计数行」更隐蔽**：计数行在、
> 数字恒 0，任何「只看有没有计数行」的判据都会被骗过。
> 上一版这里写的是「56 个（51 ∪ 5），只覆盖 5 个 ⇒ 51 个未覆盖」，那是 **2026-11-01** 的快照。
> 登记表已从 5 条扩到 **13** 条（`scopePrefix` 扩到 11 个前缀），但**扫描面长得更快**
> —— ⇒ **「守卫数量」与「受覆盖计数保护的守卫数量」是两回事**，别把前者当后者读。

还有两类**连扫描面都进不来**的判别脚本（本轮范围外，登记也登记不到，需单独记账）：

- 扫描面**外**（哨兵只扫 `scripts/` + `apps/*/scripts/` + `packages/*/scripts/`）：
  `examples/scripts/check-task-examples.mjs`；
- 扫描面**内但命名族外**（既不叫 `check-*` 也不叫 `agent-*`）：
  `scripts/qwen-runtime-check.mjs`、`scripts/ai-qwen-structural-check.mjs`、`scripts/sop-body-scan.mjs`、
  `scripts/audit-verify.mjs`、`scripts/load-test.mjs`、`apps/admin-web/scripts/i18n-key-check.mjs`、
  `apps/admin-web/scripts/i18n-scan.mjs`、`packages/docs-site/scripts/sync-check.mjs`。

**这个哨兵最可能被怎么绕过**（按可能性排序）：

1. **改计数逻辑本身**：`scripts/lib/agent-coverage.mjs` 的计数器被同时用于「守卫侧打印」与
   「哨兵侧交叉核对」⇒ 改它两边一起变，哨兵看不见。**这是最可能也最难防的一条**
   （要防就得把计数器复制成两份互校，代价大）。缓解：计数口径是「源码里的断言调用点数」，
   改动它必然影响所有 agent 守卫的计数行，人工 review 时容易看见。
2. **改断言函数名**：把 `check(` 全改成 `assert(`，而登记表里的 `helper` 没同步 ⇒ 计数变 0 ⇒ 会被
   ③/④ 抓住；但若**同时**把登记表的 `helper` 也改成 `assert` ⇒ 计数照旧变绿，哨兵无感
   （除非有人 review 登记表）。
3. **只删用例、不删计数行**（即本哨兵要抓的形态）⇒ 被 ② 或 ③④ 抓住，已实证。
4. **把计数写死成一个大数** ⇒ ② 抓住（除非同时改了源码里的断言数），已实证。
