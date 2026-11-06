# 全仓健康基线（health baseline）

> 最后更新：2026-11-07（由 `npm run health:snapshot` 生成，**不要手改数字**）

本文件是**可重复**的全仓健康基线：四端全量 + 全链 + 度量，**每一步都记录真实 exit code**。
判据是「与上一次基线相比没有退步」，而不是「某个数字好看」。

## 用法

```bash
npm run health:snapshot            # 全量重建（约 30–40 分钟）
npm run health:snapshot -- --skip-heavy   # 只重建度量段（秒级）
```

## 全量结果

| 检查项 | exit | 关键数字 | 耗时 |
|---|---|---|---|
| admin-api 全量（默认环境，`npm test -- --maxWorkers=2`） | **0** | suitesPassed=473 / suitesTotal=473 / testsPassed=8077 / testsFailed=0 / testsSkipped=0 / testsTotal=8077 | 141s |
| admin-api 全量（`SELFTEST_SKIP_ENV_FILE=1`，夹具干净态） | **0** | suitesPassed=473 / suitesTotal=473 / testsPassed=8077 / testsFailed=0 / testsSkipped=0 / testsTotal=8077 | 120s |
| admin-web 全量（`npx vitest run`） | **0** | passed=2394 / failed=0 / skipped=1 / total=2395 | 774s |
| executor-node 全量（`npm test`） | **0** | testsPassed=1866 / testsFailed=0 / testsSkipped=13 / testsTotal=1879 | 17s |
| executor-python 全量（`python3 -m pytest`） | **0** | passed=1981 / failed=0 / errors=0 / skipped=1 / total=1982 / coveragePct=87.45 | 191s |
| 全链 `npm run test:guards:repo` | **0** | parsed=100 / executed=100 / diff=空 | 147s |

> ⚠️ **全量数字沿用上次基线**（`2026-11-06`）：本次以 `--skip-heavy` 运行，**没有重跑**四端全量。

> **python 项的 `errors` 语义（R56 实测）**：`fixture` 抛异常与 **collection error**（模块级 raise）在 XML 里**都是 `<error …>`**，计入 `<testsuite errors="N">` ⇒ `passed` 不含它们；**collection error 时 pytest 退出码为 2，但 junitxml 仍会被写出**（实测 1 例 ⇒ `errors=1 / failed=0 / passed=0`），因此 python 行仍可读。
> **python 项的 `skipped` 语义（R55 实测）**：`@pytest.mark.skip` 在 XML 里是 `<skipped type="pytest.skip"/>`；**`@pytest.mark.xfail` 也表现为 `<skipped type="pytest.xfail"/>`** ⇒ **xfail 计入 `skipped`，不计入 `passed`**（实测：加 1 skip + 1 xfail ⇒ `tests=1694 / skipped=2 / passed=1692`）。
> **python 项的 `collected` 是「收集数」，不是通过数**：本仓 pytest 配置下不打印 `N passed` 汇总行（末尾是 coverage 表），所以「是否全过」以 `exit` 为权威、规模用 `--collect-only` 的收集数表示。**不要**把它当通过数用于对比（那会让 +N 看起来像新增通过用例）。

## 度量（静态，不跑测试）

| 指标 | 值 | 说明 |
|---|---|---|
| 守卫链段数（`test:guards:chain` 按 `&&` 切分） | **100** | 链的每一段都会被执行，矩阵入口逐条报告 |
| `scripts/env-switch-known-gaps.json` 条目数 | **0** | 约定缺口；**应为 0**（非 0 即有登记的技术债） |
| blocked 条目数（PLAYBOOK 内「记 blocked」） | **0** | 已正式登记为阻塞的立项数 |
| `source-size-baseline.json` 登记条目 | **98** | 体量棘轮逐文件登记数（`files` 键下的条目） |
| 迁移文件数（`apps/admin-api/src/migrations/*.ts`，不含 spec） | **142** | 由 `check:migrations` 守着注册表 |

## 与上次基线对比

上次基线生成于 `2026-11-06`（读 `docs/health-baseline.json`）。

| 指标 | 上次 | 本次 | 差值 |
|---|---|---|---|
| admin-api 全量（默认环境，`npm test -- --maxWorkers=2`） · testsPassed | 8077 | 8077 | — |
| admin-api 全量（默认环境，`npm test -- --maxWorkers=2`） · suitesTotal | 473 | 473 | — |
| admin-api 全量（默认环境，`npm test -- --maxWorkers=2`） · exit | 0 | 0 | — |
| admin-api 全量（`SELFTEST_SKIP_ENV_FILE=1`，夹具干净态） · testsPassed | 8077 | 8077 | — |
| admin-api 全量（`SELFTEST_SKIP_ENV_FILE=1`，夹具干净态） · suitesTotal | 473 | 473 | — |
| admin-api 全量（`SELFTEST_SKIP_ENV_FILE=1`，夹具干净态） · exit | 0 | 0 | — |
| admin-web 全量（`npx vitest run`） · passed | 2394 | 2394 | — |
| admin-web 全量（`npx vitest run`） · exit | 0 | 0 | — |
| executor-node 全量（`npm test`） · testsPassed | 1866 | 1866 | — |
| executor-node 全量（`npm test`） · exit | 0 | 0 | — |
| executor-python 全量（`python3 -m pytest`） · passed | 1981 | 1981 | — |
| executor-python 全量（`python3 -m pytest`） · exit | 0 | 0 | — |
| 全链 `npm run test:guards:repo` · parsed | 100 | 100 | — |
| 全链 `npm run test:guards:repo` · exit | 0 | 0 | — |
| 度量 · segments | 100 | 100 | — |
| 度量 · gaps | 0 | 0 | — |
| 度量 · blocked | 0 | 0 | — |
| 度量 · sizeEntries | 98 | 98 | — |
| 度量 · migrations | 142 | 142 | — |

## 已知限制

- **admin-api 全量必须 `--maxWorkers=2`**：默认按 CPU 核数起 worker（本机 12），swap 已满时会被 SIGTERM（R28 实测）；
- 本脚本**不在** `test:guards:chain` 里：全量 30–40 分钟，接进链会让「提交前跑一遍」不可用（链 13 分钟用途不同）；
- 跑不动的一端写「未测」+ 原因，**不许**用历史数字冒充满血当前（R27 教训㊽）。
