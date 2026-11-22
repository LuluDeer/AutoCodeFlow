# W4 实例留存 —— ROADMAP 先行指标口径与可复算脚本（R451）

> **受众**：PM / 运营 / 接手维护者 · **状态**：内部 · **最后核对**：2026-11-21
> 固化 ROADMAP「W4 实例留存 ≥40%」的可执行口径与脚本；复用现有 TTFV 漏斗数据，零 DDL、零新埋点。

## 1. 指标定义（PM 裁决）

**W4 留存率 = 「安装满 28 天且在**第 4 周（安装后 day 21–28）**至少一次真实使用」的 install 数 / 「安装满 28 天」的 install 数。**

- **分母锚点**：`funnel_events` 的 `install_completed` 事件（服务端 HMAC `install_id`），`ts ≤ as_of − 28d`。
- **分子「真实使用」**：`task_first_attempted` / `task_first_success` / `business_confirmed` 三类事件之一，且事件 `ts ∈ (installed_at + 21d, installed_at + 28d]`（含端点 day 21 与 day 28）。
- **不算使用**：`install_completed` 只是注册，不计入留存行为。
- **同源保证**：分母与分子的 `install_id` 均由 `deriveAnonymousId(deviceFingerprint, "ttfv-install")` 派生（`funnel-install.listener.ts:55` / `funnel-success.listener.ts:81`），可安全关联。
- **数据完整**：`funnel_events` 保留 90 天（`FUNNEL_EVENT_RETENTION_DAYS=90`），W4 观测窗 28 天 < 90 天，分母与第4周事件都在保留期内。
- **口径边界**：只覆盖 opt-in 安装（漏斗双闸写入），未授权安装不进分母/分子——脚本 warnings 常驻此说明。

**为什么 day 21–28**：第 4 周 = 安装后第 21 天起到第 28 天（含），是"第 4 周内是否仍活跃"的业界口径；`≥21d` 与 `≤28d` 含端点，selftest 有 day 21/28 计入、day 20/29 排除的边界夹具。

## 2. 与 ROADMAP 的关系

ROADMAP「先行指标」列 `W4 实例留存 ≥40%`（`docs/ROADMAP.md` 指标段）。此前只有目标数字、无实现（代码/脚本零命中）；本方案用现成漏斗数据补齐可复算口径——与「模板→成功转化率」（无 DDL 埋点、已明确放弃）不同，W4 有现成数据源，属可自主落地缺口。

## 3. 脚本

`scripts/w4-retention.mjs`：

- `W4_RETENTION_SQL`（导出）：CTE `installed`（分母）+ `used_w4`（分子），单查询返回 `eligible_installs` / `retained_installs`。`$1::timestamptz` 显式转型（避免 string 减 interval 报错）。
- `computeW4Retention(events, asOf)`（导出）：内存复刻 SQL 语义，供 selftest 与对账。
- `FIXTURES` 5 例：达标（0.40）/ 不达标（0）/ 边界（day21·28 计入、day20·29 排除）/ 未满 28 天不进分母 / 空样本 rate=null 不伪造。
- CLI：`--selftest`（5/5）；`--report [--dsn] [--as-of] [--json]`；无连接参数 SKIP exit 0；缺表 SKIP exit 0。
- 退出码：0 跑完（含 SKIP）/ 1 夹具失败 / 2 结构错 / 3 连不上库。口令只进 pg connectionString，不落日志。

## 4. 验收证据（R451）

- selftest **5/5** exit 0；`node --check` 通过；无连接 `--report` SKIP exit 0。
- **真库对账**：测试库 `autoflow_ttfv_e2e` <!-- metric-docs:ignore-unknown 这是 PostgreSQL 测试数据库名，不是指标名 --> 造受控种子（3 install：满28天且第4周活跃 / 满28天不活跃 / 未满28天），`--report --json` 得 `eligible=2, retained=1, rate=0.5`，与内存口径一致；清理后残留 0。
- **反证有牙**：把 SQL 窗口上限 `28d→20d` → 真库 `retained 1→0, rate 0.5→0`（结果真由 SQL 窗口决定、非硬编码）；还原 sha 一致、selftest 5/5 复绿。
- `check-script-main-guard` exit 0（脚本有 export + main guard，无需豁免登记）。

## 5. 边界与后续

- 生产库尚未启用漏斗埋点（`SEC_SECRETS_KEY`/迁移/`telemetry.ttfv.enabled` 前置，见 [生产启用 runbook](north-star-enablement.md)）——脚本在真生产数据出来前只能对测试库造数验证，与 `north-star-weekly.mjs` 同处境。
- 可选后续：把 W4 脚本接入运营看板/数据 API（仿 R327/R449 的同源贯通）；或加 CI 定时巡检（需生产样本）。
- 未做：SOP 成功率/人工接管率（ROADMAP 另一先行指标）——需定义"人工接管"判据与数据源，属独立切片。

## 6. 证据索引

- 脚本：`scripts/w4-retention.mjs`
- 漏斗方案：[TTFV 埋点方案](ttfv-funnel-instrumentation.md) · [北极星判据](north-star-business-confirmed.md)
- 状态总览：[PROJECT-STATUS.md](../PROJECT-STATUS.md)
