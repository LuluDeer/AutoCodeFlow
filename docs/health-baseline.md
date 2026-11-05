# 全仓健康基线（health baseline）

> 最后更新：2026-11-05（由 `npm run health:snapshot` 生成，**不要手改数字**）

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
| admin-api 全量（默认环境，`npm test -- --maxWorkers=2`） | **0** | suitesPassed=465 / suitesTotal=465 / testsPassed=7947 / testsFailed=0 / testsSkipped=0 / testsTotal=7947 | 128s |
| admin-api 全量（`SELFTEST_SKIP_ENV_FILE=1`，夹具干净态） | **0** | suitesPassed=465 / suitesTotal=465 / testsPassed=7947 / testsFailed=0 / testsSkipped=0 / testsTotal=7947 | 120s |
| admin-web 全量（`npx vitest run`） | **0** | passed=2357 / skipped=1 / total=2358 | 184s |
| executor-node 全量（`npm test`） | **0** | testsPassed=1514 / testsFailed=0 / testsSkipped=13 / testsTotal=1527 | 16s |
| executor-python 全量（`python3 -m pytest -q`） | **0** | collected=1692 / coveragePct=87.48（本仓 pytest 不打印 "N passed" 汇总行；**通过以 exit 0 为权威**，规模=收集数） | 175s |
| 全链 `npm run test:guards:repo` | **0** | parsed=92 / executed=92 / diff=空 | 116s |

## 度量（静态，不跑测试）

| 指标 | 值 | 说明 |
|---|---|---|
| 守卫链段数（`test:guards:chain` 按 `&&` 切分） | **92** | 链的每一段都会被执行，矩阵入口逐条报告 |
| `scripts/env-switch-known-gaps.json` 条目数 | **0** | 约定缺口；**应为 0**（非 0 即有登记的技术债） |
| blocked 条目数（PLAYBOOK 内「记 blocked」） | **1** | 已正式登记为阻塞的立项数 |
| `source-size-baseline.json` 登记条目 | **98** | 体量棘轮逐文件登记数（`files` 键下的条目） |
| 迁移文件数（`apps/admin-api/src/migrations/*.ts`，不含 spec） | **141** | 由 `check:migrations` 守着注册表 |

## 与上次基线对比（手工填写）

| 指标 | 上次 | 本次 | 变化 | 结论 |
|---|---|---|---|---|
| 四端全量是否全绿 | — | — | — | 手工填 |
| 守卫链段数 | — | — | — | 手工填 |

## 已知限制

- **admin-api 全量必须 `--maxWorkers=2`**：默认按 CPU 核数起 worker（本机 12），swap 已满时会被 SIGTERM（R28 实测）；
- 本脚本**不在** `test:guards:chain` 里：全量 30–40 分钟，接进链会让「提交前跑一遍」不可用（链 13 分钟用途不同）；
- 跑不动的一端写「未测」+ 原因，**不许**用历史数字冒充满血当前（R27 教训㊽）。
