# 测试约定
> 所属: docs/atlas/07-testing · 最后核对: 2026-09-13 · 对应代码: 各应用 jest/vitest/pytest 配置、package.json（根）、scripts/

## 命名约定（全仓一致，均已核实）

| 后缀 | 框架 | 用在哪 |
|---|---|---|
| `*.spec.ts` | Jest | admin-api / executor-node 单测（`testRegex: ".*\\.spec\\.ts$"`） |
| `*.e2e-spec.ts` | Jest（独立配置） | admin-api 集成 e2e（`test/jest-e2e.json`，正则 `.e2e-spec.ts$`） |
| `*.test.ts` / `*.test.tsx` | vitest | admin-web（jsdom）、acf-cli、mcp-server（`include: ['src/**/*.test.ts']`） |
| `test_*.py` | pytest | executor-python、autoflow-sdk、四个 python lib、registry-pypi |
| `*.selftest.ts` | 自研断言 | executor-desktop 主进程自测（`src/main/`，tsc 编译后跑） |
| `*.selftest.mjs` / `*.selftest.sh` | 自研断言 | scripts/ 工具自检，全过退出码 0 |
| `e2e-*.spec.js` | Playwright | 根级全链（`testMatch: '**/e2e-*.spec.js'`） |
| `*.spec.js`（`e2e/` 目录） | Playwright | desktop 冒烟（`e2e/desktop-smoke.spec.js`，独立配置）与 `apps/admin-web/e2e/*.spec.ts` 页面走查（`playwright.config.ts`，testDir `./e2e`） |

命名示例（照抄即可）：

- `apps/admin-api/src/modules/task/__tests__/task.service.spec.ts`
- `apps/admin-api/test/tasks.e2e-spec.ts`
- `apps/admin-web/src/__tests__/task-form-page.test.tsx`
- `apps/executor-node/src/routes/execute.spec.ts`
- `apps/executor-python/tests/test_registration.py`
- `apps/executor-desktop/src/main/updater.selftest.ts`
- `scripts/load-test.selftest.mjs`、根目录 `e2e-full.spec.js`

## 与 Makefile / dev.sh 的关系

- `make test` / `make lint` / `make typecheck` **全部委托**根 package.json（`npm run test:unit` 等），Makefile 不维护命令清单（ARCH-20）。
- `dev.sh` 只负责起开发环境（infra、install、迁移、4 服务），**不含任何测试步骤**——验证永远显式跑。
- `scripts/ci-local.sh` 可在本地一条命令复刻 ci.yml 全部 job（远端无凭证时的等价物）。

## 组织约定

- **admin-api**：模块内就近 `src/modules/<mod>/__tests__/`（147 个 spec）；集成 e2e 集中在 `test/`（4 个 + `helpers/app.helper.ts`）；大型夹具放 spec 旁子目录（如 `application/__tests__/deploy-fixture/manifest.json`）。
- **admin-web**：全部集中在 `src/__tests__/`（74 个文件），源码目录不散放；公共 fixture 也放这里（如 `ThemeToggleFixture.tsx`）。
- **executor-node**：spec 与被测源码同目录或同域子目录（`routes/`、`lib/`、`middleware/`），21 个。
- **executor-python**：`tests/` 平铺 + `conftest.py`（autouse 的 event loop 清理 fixture）。
- **executor-desktop**：自测文件与被测代码同目录（`src/main/*.selftest.ts`），无独立 test 目录。
- **packages**：每包独立测试套件与配置（acf-cli/mcp-server 用独立 `vitest.config.ts`，node-sdk 用 package.json jest 键），互不共享 node_modules（无 workspace hoisting，ARCH-20）。
- **新增测试放哪**（速判）：后端业务 → 模块 `__tests__`；前端 → `src/__tests__`；契约相关 → 消费 contract-fixtures 向量而非另造样例；跨服务/真机 → 并入根 e2e 或 scripts 真机自测并在 [VERIFY-MATRIX](../../VERIFY-MATRIX.md) 登记。

## mock 纪律

1. **越往上越真**：单测允许 mock 模块边界（axios、typeorm repository）；集成 e2e bootstrap 完整 AppModule + 真 PG/Redis（`createTestApp()`）；根级 e2e 与 scripts 真机门禁一律真实进程，**不依赖 .env**（`scripts/e2e-full.sh` 头注明文：测试专用值显式传入）。
2. **不给安全纪律开后门**：SSRF 守卫（`assertSafeHttpUrl`）回环地址直接拒绝、**无测试开关**——arch31-outbox 自测因此改用 DB 级并发而非走 HTTP 回调面（脚本头注为证）。需要回环目标的全链测试走 `EXECUTOR_ALLOW_PRIVATE_NETWORK=true` 显式配置，而不是给守卫加豁免。
3. **pytest 全量 strict**（executor-python `filterwarnings = error`）：新增警告要么修代码要么在 pytest.ini 精确豁免并注明复查条件（现有两条豁免均注明"升级后应复核回收"），禁止一刀切 ignore。
4. **e2e 防抖三件套**（改动 e2e 编排时不得破坏）：每次全新空库、节流放大（`LOGIN_THROTTLE_LIMIT/THROTTLE_LIMIT=10000`）、回调密钥两端显式同值（`EXECUTION_CALLBACK_SECRET`）。
5. **生成物入库 + CI diff 防漂移**：openapi.json、api-types.ts、desktop ncc bundle 均为"产物入库"，改动后必须重新生成并提交，CI 用 git diff 拦截（`api-types-drift` / `desktop-bundle-drift` job）。
6. **自测脚本写头注**：scripts/ 下每个 selftest 都在头注说明"为什么必须真机跑 / 为什么用这种并发形态"，新增脚本沿用此格式（排查时先读头注）。

## 改动后必跑（最小回归集）

| 改动类型 | 必跑 | 可选/兜底 |
|---|---|---|
| admin-api 某模块 | `npm run test:api` | 改了 controller/DTO → `npm run test:e2e -- --runInBand`；改了 DTO → `openapi:export` + `gen:api-types` |
| 数据库迁移 | 空库 `migration:run` ×2（第二次须 no-op）+ `node scripts/check-migrations.mjs` | CI `admin-api-migrations` job 全套；月度含 revert 演练 |
| executor-node | `cd apps/executor-node && npm run build && npx jest` | 全链改动 → `bash scripts/e2e-full.sh` |
| executor-python | `npm run test:python` | 回调/注册语义 → 真机项对照 [VERIFY-MATRIX](../../VERIFY-MATRIX.md) |
| admin-web | `npm run test:web` + `npm run typecheck` + `npm run build` | 页面走查 → `apps/admin-web/e2e` 手动 Playwright |
| 客户端四包（cli/mcp/双 SDK） | 对应包测试（契约面向量会联动） | admin-api 信封改动 → 四端全跑 + `npm run test:unit` |
| scripts/ 下工具 | 对应 `*.selftest.*`（见 [contract-and-selftest](contract-and-selftest.md) 清单） | 真机门禁脚本按其头注跑 live 形态 |
| 桌面端 | `cd apps/executor-desktop && npm run test:main && npm run test:renderer` | 改了主进程/IPC → `npm run test:e2e` 冒烟 3 例 |
| nginx/反代配置 | `npm run test:nginx-sse` | 见 [nginx-and-reverse-proxy](../06-infra/nginx-and-reverse-proxy.md) |
| 不确定影响面 | `npm run test:unit` + `npm run typecheck:all` | 终极兜底 `bash scripts/e2e-full.sh`；`make test`（委托 `npm run test:unit`，ARCH-20） |

## 常见场景 → 先读哪篇

| 你要做什么 | 先读 |
|---|---|
| 改 admin-api 某模块，想知道现有测试覆盖了什么 | [admin-api-testing](admin-api-testing.md) + 模块文档（[01-apps/admin-api/modules/](../01-apps/admin-api/README.md)） |
| 改前端页面/组件 | [frontend-testing](frontend-testing.md) + [admin-web README](../01-apps/admin-web/README.md) |
| 改执行器（node/python/desktop） | [executors-testing](executors-testing.md) + 对应执行器文档 |
| 改信封/DTO/API 契约 | [contract-and-selftest](contract-and-selftest.md) + [rest-api](../05-interfaces/rest-api.md) |
| 排查/新增全链场景 | [e2e-testing](e2e-testing.md) + [task-lifecycle](../04-flows/task-lifecycle.md) |
| 发版前最终验证 | 真机矩阵 [VERIFY-MATRIX](../../VERIFY-MATRIX.md) + [06-infra/deployment-and-ci](../06-infra/deployment-and-ci.md) |

## 已知覆盖薄弱点（如实记录，2026-09-13 核实）

- **admin-api**：coverage 统计显式排除 `main.ts`、`app.module.ts`、`data-source.ts`、`config/configuration.ts`、`http-exception.filter.ts`、`shutdown-guard.util.ts`、`migrations/**`——装配与生灭路径无单测，靠迁移 job 与 e2e 兜底。门槛是防倒退地板（75/69/84/84），不保证均衡；工作区残留 lcov 水位 lines 91.45% / funcs 82.17% / branches 78.32%，**branches 离地板最近**，新增条件分支最易触线。
- **executor-node / admin-web / python 侧**：均未配置 coverage 门槛（如实缺省，不是"已达标"）。
- **admin-api 的 CI e2e 只覆盖 auth / executors / tasks 三个域 + OpenAPI 导出**；notification、application/deployment、metrics 等域 HTTP 层靠 mock 单测，真实链路由根级 45 例 e2e 部分覆盖（审批/RBAC/SSRF/私服有红线用例，其余域按 UI 走查粒度）。
- **admin-web vitest 不在 CI**（CI 只有 lint+build），测试绿不绿依赖本地自觉——改前端必须手动 `npm run test:web`。
- **桌面端无单元框架**：全部为自研自测脚本 + 3 例 Electron 冒烟，冒烟仅 PR/手动触发；executor-desktop 也不在 `test:unit` 里（只有根 `test:desktop`）。
- **`lint:node` 显式跳过**（executor-node 无 eslint.config.*，ESLint v9 需要 flat config，ARCH-20 记录在案）——executor-node 只有类型检查与 jest 两道门。
- **executor-desktop / scripts 真机门禁大多不在默认 CI 轮**（arch31 三件套、nginx-sse、qa05、private-registry:live 均为本地/真机轮跑），真正的回归拦截依赖人工按 [VERIFY-MATRIX](../../VERIFY-MATRIX.md) 执行。
- ci.yml 内两处注释与实际配置有滞后（e2e"43 例" vs spec 实际 45 个 `test()`；coverage 注释 68/58/56/69 vs package.json 75/69/84/84）——**读 CI 注释时以配置文件为准**，本目录各篇均按配置文件口径记录。

> ⚠️ 待核实：各套件"实跑用例数"（如 admin-api 静态 2238 处 `it/test` 展开后的总数、executor-python parametrize 展开后总数）需以最近一次 CI 输出为准；本文只承诺文件数与静态统计口径。发现实际数字与文档不符时，按 [仓库维护规则](../README.md) 以代码为准并回改文档。
