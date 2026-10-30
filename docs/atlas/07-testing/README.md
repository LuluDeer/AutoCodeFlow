# 测试体系总览
> 所属: docs/atlas/07-testing · 最后核对: 2026-10-30 · 对应代码: package.json（根）、.github/workflows/ci.yml、apps/*/（各应用测试）、scripts/、apps/admin-web/e2e/legacy/

## 测试金字塔（各层定位）

```
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

| 层 | 位置 | 规模（2026-10-30 静态核实） | 运行命令 |
|---|---|---|---|
| admin-api 单测 | `apps/admin-api/src/**/__tests__`（371 个 `*.spec.ts`） | jest，`it/test` 6185 处（静态统计，实跑数以 CI 输出为准） | `npm run test:api` |
| admin-api e2e | `apps/admin-api/test/*.e2e-spec.ts`（4 个） | jest-e2e 配置，需真 PG/Redis | `npm run test:e2e -- --runInBand` |
| executor-node | `apps/executor-node/src`（56 个 `*.spec.ts`） | jest，`it/test` 1111 处（静态） | `npm run test:node` |
| executor-python | `apps/executor-python/tests/`（50 个 `test_*.py`） | pytest，`def test_` 921 个（静态；另有 142 处 `async def test_` 未计入此列） | `npm run test:python` |
| admin-web | `apps/admin-web/src/__tests__/`（262 个 `*.test.ts/tsx`） | vitest（jsdom） | `npm run test:web` |
| packages（JS） | acf-cli 13 文件 / mcp-server 9 文件 / node-sdk 5 文件 | vitest ×2 + jest ×1 | `test:cli` / `test:mcp` / `test:node-sdk` |
| packages（Py） | autoflow-sdk 8 文件 / 166 用例 · http 2 文件 / 13 · ai 2 / 29 · notify 2 / 2 · db 2 / 30 | pytest（用例数 = `def test_` 静态计数） | `test:sdk-py` / `test:lib-*` |
| registry-pypi | `apps/registry-pypi/tests/` | pytest，164 个 `def test_` | `npm run test:pypi` |
| 契约测试 | [contract-and-selftest.md](contract-and-selftest.md) | 四端共享 `contract.json` | 随各包测试运行 |
| 根级全链 e2e | `apps/admin-web/e2e/legacy/` 三份 spec：`e2e-full.spec.js`（48 个 `test()` + 5 个条件 `test.skip()`）、`e2e-python-executor.spec.js`（1 个）、`e2e-ui09-mobile.spec.js`（2 个） | Playwright chromium，真栈；`playwright.e2e.config.js` 的 `testDir` **只圈 `legacy/`**（`testMatch: '**/e2e-*.spec.js'`） | `bash scripts/e2e-full.sh` |
| 自测/真机脚本 | `scripts/*selftest*`（27 个） | 见 [contract-and-selftest.md](contract-and-selftest.md) | 各自独立命令 |

> 遗留副本 `apps/admin-web/e2e-full.spec.js`（601 行 / 16 个 `test()`，内容停在用例 16）**不在**
> `playwright.e2e.config.js` 的 `testDir` 内，任何入口都不会执行它——统计 e2e 例数时请以
> `apps/admin-web/e2e/legacy/` 为准（`scripts/e2e-full.sh` 与 ci.yml 的 `e2e-full` job 同此口径）。

**上表数字的复核命令**（口径：文件数用 `find`/`ls` 点数；用例数用 `grep -o` 数声明，**静态**，不等于实跑数；
`packages` 行的「N 文件」= 该包 `src/` 下 `.test.ts` 文件数（与各包收集配置对齐：acf-cli / mcp-server 是 vitest `include: ['src/**/*.test.ts']`；node-sdk 是 jest `roots: ['<rootDir>/src']` + `testMatch: '**/__tests__/**/*.test.ts'`，用例都在 `src/__tests__/` 下）；
采样时点 2026-10-30，工作区在动，数字会跟着变，请以命令输出为准）：

```bash
find apps/admin-api/src -path '*__tests__*' -name '*.spec.ts' | wc -l                       # 371
grep -rhoE '^\s*(it|test)\(' apps/admin-api/src --include=*.spec.ts | wc -l                 # 6185
find apps/executor-node/src -name '*.spec.ts' | wc -l                                       # 56
grep -rhoE '^\s*(it|test)\(' apps/executor-node/src --include=*.spec.ts | wc -l             # 1111
ls apps/executor-python/tests/test_*.py | wc -l                                             # 50
grep -rhoE '^\s*def test_' apps/executor-python/tests | wc -l                               # 921（async def 另 142）
find apps/admin-web/src/__tests__ -name '*.test.ts*' | wc -l                                # 262
find packages/acf-cli/src -name '*.test.ts' | wc -l                                         # 13
find packages/mcp-server/src -name '*.test.ts' | wc -l                                      # 9
find packages/autocodeflow-node-sdk/src -name '*.test.ts' | wc -l                           # 5
grep -rhoE '^\s*def test_' apps/registry-pypi/tests | wc -l                                 # 164
ls scripts/*selftest* | wc -l                                                               # 27（含守卫 check-desktop-selftests-wired.mjs）
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
判据型的 `check-*.mjs` 现 44 个（另 `scripts/docs/check-docs.mjs`），加上 `scripts/*selftest*` 27 个自测文件，都归本文这一节管。

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

- **`--root <dir>`**：仓库根当参数传，别硬编码 `process.cwd()`（44 个 `check-*.mjs` 里 43 个已支持）。只给 selftest 用：
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

现况（2026-10-30 实跑 `node scripts/check-guards-wired.mjs`）：**45 个 `check-*.mjs` 全部被 CI 执行**（另 1 个显式豁免）；
**46 个守卫有自检，其中 45 个在本地 `test:guards` 与 CI 都真的跑了自检**（1 个自检豁免，0 个只接一面）。
豁免必须**可证**：`ALLOWLIST` 管①②、`SELFTEST_ALLOWLIST` 管③，两套分开；标 `wired` 的那一面会被事实核对，
对不上（声称 CI 跑了但 ci.yml 里没有）与陈旧豁免同样是**结构红**。

### 4. 两面接线（缺一面 = 白写）

| 面 | 落点 | 跑什么 |
|---|---|---|
| 本地 | 根 `package.json` 的 `test:guards` = `test:guards:repo` && `test:guards:selftests` | 判据型 `check:*`（离线、约 40 秒）+ 真机/行为型自测（要构建，分钟级） |
| CI | `ci.yml` 的 `check-migrations` job（判据型，与 DOC-GOV 同 job）+ `selftests` job（行为型） | 同一批脚本，直接写 `node …` 或 `npm run check:*` |

新增守卫：① 用 harness 写 `--selftest`（含反证：把修好的事实改回去必须红）② 两边接线
③ `npm run check:guards-wired` 自证没有只接一面 ④ `npm run test:guards` 本地跑一遍。

跨文档：CI 细节见 [deployment-and-ci](../06-infra/deployment-and-ci.md)；脚本全图见 [仓库脚本地图](../06-infra/scripts.md)；任务全链背景见 [任务生命周期](../04-flows/task-lifecycle.md)。
