# R327 独立验收报告 —— 北极星后端 API 真库对账 + 静态复核

> 验收 agent：`r327-api-verify`  
> 验收对象：A 切片 `NorthStarMetricsService` / `GET /api/agent/north-star/metrics` 的数据口径  
> 权威参照：[north-star-weekly.mjs](../../scripts/north-star-weekly.mjs) `buildPayload()` + `--report --json`  
> 新增证据脚本：[north-star-api-reconcile.mjs](../../scripts/north-star-api-reconcile.mjs)

## 1. 结论

**数据口径建议关闭。** 在同一测试库、同一 `as_of = 2026-11-21T12:00:00.000Z` 下，权威 CLI 与被测 API service 的六个核心字段逐字一致，且与独立期望常量 `EXPECTED` 一致；反证注入后稳定转红（exit 1），正常态 exit 0；清理复查三表前缀残留均为 0。

需 lead 知悉一项非数据口径差异：任务书文字写的是 `GET /agent/metrics/north-star`，A 实现落盘路由是 `GET /api/agent/north-star/metrics`（见 [agent.controller.ts](../../apps/admin-api/src/modules/agent/agent.controller.ts) L1113）。本次走 **service 直调**，未做 HTTP 传输层/鉴权可达性验证；若路由字面量要求严格一致，需另开 HTTP e2e 小题裁决。

## 2. 采用的对账路径与验收级别

- **路径①（权威）**：`node scripts/north-star-weekly.mjs --report --json --dsn=<e2e> --as-of=<fixed>`，子进程 `TZ=UTC`，`status != OK` 直接结构红。
- **路径②（被测 API）**：`require` A 的 CommonJS 编译产物 `apps/admin-api/dist/modules/agent/runtime/north-star-metrics.service.js`，`new NorthStarMetricsService(new DataSource({ url: dsn }))`，真库执行 `report(asOf)`。这是任务允许的「直接 import 编译产物 + 注入真 DataSource」方案；`.mjs` 无法直接 import TS `createTestApp()` helper，故未起 Nest app / HTTP 进程。
- **验收级别**：**真库 + 真 service 进程内集成**（非内存替身、非静态-only；HTTP/Nest 路由与鉴权层不在覆盖内）。另附静态 SQL 等价复核作旁证。
- **隔离**：`--from-env` 从 `.env` 的 `DB_*` 拼 `autoflow_ttfv_e2e` <!-- metric-docs:ignore-unknown 这是 PostgreSQL 测试数据库名，不是指标名 -->；库名 `test|e2e` 防误；种子前缀 `r327_api_rec_v1_`；口令只进连接配置/子进程 argv，日志 `redact`，未出现明文口令。

## 3. 执行证据

### 3.1 门禁与基线

| 步骤 | 命令 | 结果 |
|---|---|---|
| R326 真库基线 | `node scripts/north-star-pg-reconcile.mjs --from-env` | 21 项全绿，exit 0，清理残留 0 |
| 新脚本纯函数自检 | `node scripts/north-star-api-reconcile.mjs --selftest` | 10/10，exit 0 |
| admin-api 构建 | `cd apps/admin-api && npm run build` | exit 0；产物 `dist/modules/agent/runtime/north-star-metrics.service.js` |
| 最终真库对账 | `node scripts/north-star-api-reconcile.mjs --from-env` | 28 项断言全绿，`FINAL_EXIT=0` |

说明：首次运行时编译产物是 stale 版本（`warnings` 只含严格说明、缺代理强警告），对账立刻报红 exit 1；按最终源码重新 `npm run build` 后 `warnings` 两条齐全，最终运行全绿。这条轨迹本身证明 warnings 门控有效，也提醒发布前必须以最新构建产物为准。

### 3.2 逐字段双口径对比（CLI vs API）

| 字段 | 权威 CLI | API service | 结果 |
|---|---|---|---|
| `as_of` | `2026-11-21T12:00:00.000Z` | 同 | 一致 |
| `business_confirmed.weeks` | 周B `{active=1, confirmed=1}`；周A `{active=2, confirmed=3}` | 同 | 一致 |
| `business_confirmed.totals` | `{active_install_weeks:3, confirmed_events:4}` | 同 | 一致 |
| `business_results_proxy.weeks` | 周A `{executions:2}` | 同 | 一致 |
| `business_results_proxy.totals` | `{executions:2}` | 同 | 一致 |
| `warnings` | 严格口径说明 + `⚠️ 有产物/有证据 ≠ 被业务确认，代理值勿当严格值` | 同序同字 | 一致 |

两条路径不仅互比，还分别与独立字面常量 `EXPECTED` 对账，避免「两边一起错」的假绿。种子覆盖：周A 同 install 2 确认 + 另一 install 1 确认、周B 单确认、event_name/dedupe 前缀干扰行、`as_of` 之后行、proxy 的 `artifacts=[] / synthetic=true / status=failed` 三过滤。

### 3.3 反证（明确 exit code）

- 命令：`node scripts/north-star-api-reconcile.mjs --from-env --counterproof`
- 注入：克隆 API payload，把周 A `confirmed_events` 从 `3` 改成 `4`；不改 A 源文件。
- 结果：`[API] business_confirmed.weeks=EXPECTED` 与 `[A/B] business_confirmed.weeks` 两项转红，**exit code = 1**。
- 还原：原 API payload 未变，sha256 `6ff41bbbc106… → 6ff41bbbc106…`；清理复查残留仍为 0。
- 正常态再跑：`FINAL_EXIT=0`。

### 3.4 静态 SQL 等价复核（旁证，不替代真库对账）

对编译产物常量与权威脚本常量做「去 `--` 注释 + 归一空白 + `:as_of`→`$1`」的规范化比对：

```json
{"strictEq":true,"proxyEq":true,"utcEq":true,"warnEq":true}
```

- strict：`date_trunc('week', ts)`、`COUNT(DISTINCT install_id)`、`COUNT(DISTINCT dedupe_key)`、`event_name='business_confirmed'`、`dedupe_key LIKE 'confirmed:%'`、`ts <= $1` 全等同。
- proxy：`date_trunc('week', e."endTime" AT TIME ZONE 'UTC')`、`status='success'`、`synthetic=false`、`jsonb_typeof/jsonb_array_length` CASE、`endTime <= $1` 全等同；列别名 `executions` vs `business_results_proxy` 仅命名差异，`buildPayload` 映射后输出同名 `executions`。
- UTC：`SET LOCAL TIME ZONE 'UTC'` 逐字一致；warnings 两条逐字一致。

## 4. 清理与写域

- 每次真库运行前后均按 `r327_api_rec_v1_%` 复查 `funnel_events` / `task_executions` / `tasks`；最终三表残留均为 0。
- 本次只新增：[north-star-api-reconcile.mjs](../../scripts/north-star-api-reconcile.mjs)、本报告。
- 未修改 A 的实现文件、R326 脚本、生产代码或任何 baseline；未改 README（按任务书要求由 lead 挂链）。

## 5. 哈希留痕

```text
scripts/north-star-api-reconcile.mjs                           1d670b28ad6e81a559924aa7ecfb9952282456e7bf33c0644d3fd369d908fe0d
apps/admin-api/src/modules/agent/runtime/north-star-metrics.service.ts  6fc91caa57328cf597d2b410a18048aaa9f409834a306c4f1e0a6b6d3ff18927
apps/admin-api/dist/modules/agent/runtime/north-star-metrics.service.js e641bc8dd6215d9ceeeea05986d22ca405a1cbcd434898941ca794d5b4be2d38
```

## 6. 给 lead 的建议

1. **关闭数据口径验收**：API 输出与权威脚本同源、双口径不混算、warnings 常驻，真库证据充分。
2. **保留一项待裁决**：任务书路由字面量 `/agent/metrics/north-star` 与实现 `/api/agent/north-star/metrics` 不同；若必须严格匹配任务书，需 A 或 lead 明确接受当前路由，或补一轮 HTTP e2e（含 JWT/ADMIN 鉴权）后再关。
3. **发布前置**：CI/部署必须使用最新构建产物；stale dist 曾导致代理警告缺失并被本次对账抓出。
