# 测试体系总览
> 所属: docs/atlas/07-testing · 最后核对: 2026-09-13 · 对应代码: package.json（根）、.github/workflows/ci.yml、apps/*/（各应用测试）、scripts/、e2e-full.spec.js

## 测试金字塔（各层定位）

```
            ┌─────────────────────────────┐
            │  真机矩阵 / 全链 e2e（最上层）│  ← 根级 Playwright 45 例、Windows e2e、desktop 冒烟、scripts/ 真机自测
            ├─────────────────────────────┤
            │  admin-api 集成 e2e          │  ← test/*.e2e-spec.ts（4 个，bootstrap 完整 AppModule + 真 PG/Redis）
            ├─────────────────────────────┤
            │  契约测试（四端同源）        │  ← packages/contract-fixtures/contract.json 被 4 个客户端包测试消费
            ├─────────────────────────────┤
            │  单元测试（主体）            │  ← admin-api jest / executor-node jest / executor-python pytest / admin-web vitest / 各 package
            └─────────────────────────────┘
```

| 层 | 位置 | 规模（2026-09-13 静态核实） | 运行命令 |
|---|---|---|---|
| admin-api 单测 | `apps/admin-api/src/**/__tests__`（147 个 `*.spec.ts`） | jest，`it/test` 约 2238 处（静态统计，实跑数以 CI 输出为准） | `npm run test:api` |
| admin-api e2e | `apps/admin-api/test/*.e2e-spec.ts`（4 个） | jest-e2e 配置，需真 PG/Redis | `npm run test:e2e -- --runInBand` |
| executor-node | `apps/executor-node/src`（21 个 `*.spec.ts`） | jest，`it/test` 约 276 处（静态） | `npm run test:node` |
| executor-python | `apps/executor-python/tests/`（16 个 `test_*.py`） | pytest，`def test_` 237 个（静态） | `npm run test:python` |
| admin-web | `apps/admin-web/src/__tests__/`（74 个 `*.test.ts/tsx`） | vitest（jsdom） | `npm run test:web` |
| packages（JS） | acf-cli 5 文件 / mcp-server 3 文件 / node-sdk 4 文件 | vitest ×2 + jest ×1 | `test:cli` / `test:mcp` / `test:node-sdk` |
| packages（Py） | autoflow-sdk 9 文件 / http 21 用例 / ai 25 / notify 18 / db 8 | pytest | `test:sdk-py` / `test:lib-*` |
| registry-pypi | `apps/registry-pypi/tests/` | pytest，58 个 `def test_` | `npm run test:pypi` |
| 契约测试 | [contract-and-selftest.md](contract-and-selftest.md) | 四端共享 `contract.json` | 随各包测试运行 |
| 根级全链 e2e | `e2e-full.spec.js`（45 个 `test()`）+ `e2e-ui09-mobile.spec.js`（2 个） | Playwright chromium，真栈 | `bash scripts/e2e-full.sh` |
| 自测/真机脚本 | `scripts/*selftest*`（15 个） | 见 [contract-and-selftest.md](contract-and-selftest.md) | 各自独立命令 |

## 运行命令速查表（根 package.json scripts 逐条核实）

| 命令 | 跑什么 |
|---|---|
| `npm run test:unit` | api + node + python + web + cli + mcp + pypi + sdk-py + node-sdk（9 个套件；**不含** desktop 与 scripts 自测） |
| `npm run test:api` / `test:node` | admin-api / executor-node 的 jest |
| `npm run test:python` / `test:pypi` | executor-python / registry-pypi 的 pytest |
| `npm run test:web` / `test:cli` / `test:mcp` | admin-web / acf-cli / mcp-server 的 vitest |
| `npm run test:node-sdk` | autocodeflow-node-sdk 的 jest |
| `npm run test:sdk-py` | autoflow-sdk（Python SDK）pytest |
| `npm run test:lib-http` / `lib-ai` / `lib-notify` / `lib-db` | 四个 Python 库 `python -m pytest tests -q` |
| `npm run test:desktop` | executor-desktop `test:main`（4 个自测）+ `test:renderer`（1 个自测） |
| `npm run test:registry-npm` | registry-npm 配置三处一致性自检 |
| `npm run test:private-registry`（`:live` / `:dispatch`） | BUG-18 私服契约（默认 dry-run / live 双仓 / executor 侧派发链） |
| `npm run test:arch31-multi-instance` / `test:arch31-rollout` / `test:arch31-outbox` | ARCH-31 多实例三真机门禁 |
| `npm run test:nginx-sse` / `test:qa05-callback-tier` | BUG-17 反代 SSE / QA-05 回调 10k 分钟真机门禁 |
| `npm run demo:seed:selftest` / `demo:failure:seed:selftest` / `bench:micro:selftest` | 种子与基准工具自检 |
| `npm run typecheck:all` / `lint:all` | 类型 / 规范（executor-node 的 `lint:node` 显式跳过，ARCH-20） |
| `bash scripts/e2e-full.sh` | 全链 e2e 编排（`SKIP_DOCKER=1` 复用外部 PG/Redis），见 [e2e-testing.md](e2e-testing.md) |

## CI 里的测试相关 job（ci.yml 实测 26 个 job）

| job | 内容 |
|---|---|
| `admin-api-test` | typecheck + lint + `npm test -- --coverage` + 迁移 + e2e（`--runInBand`） |
| `admin-api-migrations` | 空库全迁移链 + 二跑幂等守卫；月度（schedule）追加实体/迁移漂移检查与 revert 演练 |
| `executor-node-test` / `acf-cli-test` / `mcp-server-test` / `autocodeflow-node-sdk-test` | 各包 build/typecheck + 测试（node-sdk 带 coverage） |
| `admin-web-build` / `windows-admin-web` | lint + build（admin-web 的 vitest 不在 CI） |
| `executor-python-test` / `autoflow-sdk-python-test` / `python-packages-test` / `registry-pypi-test` | pytest（python 3.12；python-packages-test 为 http/notify/db/ai 四包矩阵） |
| `windows-node-tests` | windows-latest 上 executor-node / acf-cli / mcp-server 单测（Windows 兼容基线，R15-3.5） |
| `e2e-full` | ubuntu 全链 45 例 Playwright（PG/Redis 由 services 提供，`SKIP_DOCKER=1`） |
| `e2e-full-windows` | 同一 spec 在 windows-latest（仅 PR / 手动 / schedule，W-28） |
| `desktop-linux-bundle` / `desktop-e2e-smoke` | 桌面端 `test:main` 自测 + 打包闸 / Playwright `_electron` 冒烟 3 例（均仅 PR / 手动） |
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
- [e2e-testing.md](e2e-testing.md) — 根级 45 例全链 e2e、运行环境、与 admin-web/e2e 分工
- [contract-and-selftest.md](contract-and-selftest.md) — 契约四端消费 + scripts 自测清单 + 真机矩阵
- [testing-conventions.md](testing-conventions.md) — 命名/组织/mock 纪律/最小回归集/薄弱点

## 新增测试放哪（速判）

1. admin-api 业务逻辑 → `src/modules/<mod>/__tests__/<name>.spec.ts`（jest 自动收）。
2. admin-web 组件/工具 → `apps/admin-web/src/__tests__/<name>.test.tsx|ts`。
3. executor-node → 源码同目录 `<name>.spec.ts`；executor-python → `tests/test_<name>.py`。
4. 客户端包契约相关 → 消费 `packages/contract-fixtures/contract.json` 向量，别另造样例。
5. 跨服务/真机才能验证的 → 优先并入 `e2e-full.spec.js` 或 scripts 真机自测，并在 [VERIFY-MATRIX](../../VERIFY-MATRIX.md) 登记。

跨文档：CI 细节见 [deployment-and-ci](../06-infra/deployment-and-ci.md)；脚本全图见 [仓库脚本地图](../06-infra/scripts.md)；任务全链背景见 [任务生命周期](../04-flows/task-lifecycle.md)。
