# SOP 成功率 / 人工接管率 —— ROADMAP 先行指标口径与可复算脚本（R452）

> **受众**：PM / 运营 / 接手维护者 · **状态**：内部 · **最后核对**：2026-11-21
> 固化 ROADMAP「桌面 SOP 成功率 ≥90%、人工接管率 ≤10%」的可执行口径与脚本；复用现有 SOP 数据，零 DDL、零新埋点。

## 1. 指标定义（PM 裁决）

只统计**终态**指派（`status ∈ completed/failed/cancelled`，与 `sop-clarification-inbox.service.ts` 的终态三项判据一致）；`assigned/in_progress/blocked/stalled` 是非终态、不计入分母。

- **SOP 成功率** = `completed` / 终态指派数。
- **人工接管率** = 终态中「`status='failed'`（按 inbox 注释：`failed` 在这里不是结束而是**等人接管**）OR 存在 `resolution='escalated_to_human'` 的澄清（超出 Agent 能力或 maxRounds 触顶→通知人）」的**不同 assignment 数** / 终态数。两类信号 `DISTINCT` 去重，避免一个 failed+escalated 的 assignment 被双计。
- **时间窗**：`assignment.createdAt ∈ [as_of − N days, as_of]`，N 默认 30（`--days` 覆盖）。
- **口径理由**："人工接管"的两个信号都来自既有代码语义——`escalated_to_human` 是 `sop-clarification.entity.ts` 的明确枚举值，`failed` 在 `sop-clarification-inbox.service.ts:101-110` 被刻意列为"计入待人工答复"（注释原文：failed 在这里不是结束而是等人接管）。不新造"接管"字段，避免与既有语义漂移。

## 2. 与 ROADMAP 的关系

ROADMAP「先行指标」列「桌面 SOP 成功率 ≥90%，人工接管率 ≤10%」。此前只有目标数字、代码/脚本零实现。与 W4 留存（R451）同属"有现成数据源、可自主落地"的指标缺口——数据源是 `sop_assignments` / `sop_clarifications` 两张既有表，不需新埋点。

## 3. 脚本

`scripts/sop-success-rate.mjs`：

- `SOP_RATE_SQL`（导出）：CTE `terminal`（终态分母）+ `taken_over`（failed OR escalated 去重），单查询返回 `terminal_count`/`completed_count`/`takeover_count`。`$1::timestamptz` 显式转型、`$2` 窗口天数。
- `computeSopRates(assignments, clarifications, asOf, days)`（导出）：内存复刻语义，供 selftest 与对账。
- `FIXTURES` 6 例：达标（0.9/0.1）/ escalated 计入接管 / failed+escalated 去重 / 非终态排除 / 窗口外排除 / 空样本 rate=null。
- CLI：`--selftest`（6/6）；`--report [--dsn] [--as-of] [--days] [--json]`；无连接/缺表 SKIP exit 0；口令只进 pg connectionString。
- 退出码：0 跑完（含 SKIP）/ 1 夹具失败 / 2 结构错 / 3 连不上库。

## 4. 验收证据（R452）

- selftest **6/6** exit 0；无连接 `--report` SKIP exit 0；script-main-guard exit 0（有 export + main guard）。
- **真库对账**：测试库造受控种子（2 completed、1 failed、1 assigned 非终态，其中 1 个 completed 带 escalated 澄清），`--report --json` 得 `terminal=3, completed=2, takeover=2, success_rate=0.667, takeover_rate=0.667`，与内存口径一致；清理残留 0。
- **反证有牙**：把 SQL 的 `status='failed'` 接管信号去掉 → 真库 `takeover 2→1, takeover_rate 0.667→0.333`（结果真由 SQL 判据决定、非硬编码）；还原 sha 一致、selftest 6/6 复绿。

## 5. 边界与后续

- 生产库 SOP 数据规模/真实性未验证（本脚本 selftest + 测试库造数验证，不假称生产已出数）。
- "人工接管"判据基于既有 `escalated_to_human`/`failed` 语义；若将来产品引入独立的"人工接管"标记字段，需同步本口径（届时可能是新 DDL）。
- 可选后续：接入运营看板/数据 API（仿 R327/R449 同源贯通）；CI 巡检（需生产样本）。
- 至此 ROADMAP 先行指标里 TTFV/24h 激活/北极星/W4/SOP 成功率均有可复算实现；「模板→成功转化率」因无 DDL 埋点已明确放弃（见 W4 方案）。

## 6. 证据索引

- 脚本：`scripts/sop-success-rate.mjs`
- 相关：[W4 留存](w4-retention.md) · [TTFV 埋点方案](ttfv-funnel-instrumentation.md) · [北极星判据](north-star-business-confirmed.md)
- 状态总览：[PROJECT-STATUS.md](../PROJECT-STATUS.md)
