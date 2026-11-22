# 先行指标健康度判定 —— ROADMAP 目标数字变为机器可判状态（R455）

> **受众**：PM / 运营 · **状态**：内部 · **最后核对**：2026-11-21
> 把 ROADMAP 目标数字（文档文字 / 指标脚本 thresholds 元数据）变成机器可判的达标状态；纯函数、零依赖、无样本不算达标。

## 1. 为什么

ROADMAP 先行指标都有目标数字（TTFV≤10min、24h激活≥60%、W4留存≥40%、SOP成功≥90%、接管≤10%、北极星周业务结果），三个指标脚本（R324/R451/R452）也各自输出 `thresholds` 字段——但**没有任何地方把"实测值 vs 目标"判定成达标状态**。运营要手动跑脚本、自己比对数字。本方案补上这层判定，`evaluateHealth` 是唯一事实源。

## 2. 判定口径（PM 裁决）

| 指标 | comparator | 目标 | 数据源 |
|---|---|---|---|
| W4 实例留存率 | ≥ | 0.4 | `w4-retention.mjs` retention_rate |
| SOP 成功率 | ≥ | 0.9 | `sop-success-rate.mjs` success_rate |
| 人工接管率 | ≤ | 0.1 | `sop-success-rate.mjs` takeover_rate |
| 北极星升主判据 | is_true | true | `north-star-weekly.mjs` promotionEligibility.eligible |

- **每条** = `{name, label, value, target, comparator, met, status}`，`status ∈ met/unmet/no_data`。
- **无样本（value=null）⇒ status='no_data' 且 met=false**——绝不算达标。这是核心护栏：避免"零样本假装达标"（与三个脚本"空样本 rate=null 不伪造"一致）。生产未启用漏斗时，指标无数据，健康度应诚实报 no_data 而非 green。
- **总体** = `{healthy, unmet[], noData[], checks[], note}`；`healthy=true` 当且仅当所有 check 都 `met=true`。
- **TTFV 中位数/24h 激活暂不纳入**：`ttfv-real-metrics.mjs` 用 PERCENTILE_CONT + 多 CTE，口径复杂；在健康度脚本里复刻一套可能漂移的判据违反"单一事实源"。属独立后续接入（需先让该脚本导出可复用的判定函数）。

## 3. 脚本

`scripts/metrics-health.mjs`：

- `evaluateHealth(inputs)`（导出，纯函数、零依赖、无副作用）：inputs = `{w4_retention_rate, sop_success_rate, sop_takeover_rate, north_star_promotion_eligible}`。
- `FIXTURES` 6 例：全达标 / 边界正好达标(0.4/0.9/0.1) / W4未达标 / SOP成功+接管双未达标 / 无样本(no_data 且 met=false) / 混合(unmet+noData)。
- CLI：`--selftest`；`--report --input <file.json>`（读各指标脚本产出的实测值，不连库；无 input SKIP exit 0）。

## 4. 验收证据（R455）

- selftest **6/6** exit 0；`node --check` 通过；script-main-guard exit 0（有 export + main guard）。
- `--report --input` 实测：W4=0.35 输入 → `healthy=false, unmet=[w4_retention]`，判定正确。
- **反证有牙**：把 `>=` 改成严格 `>` → 边界夹具转红（5/6），还原 sha 逐字一致、selftest 6/6 复绿。
- CI 接线：`north-star-real-e2e`/`selftests` job 的 `Operations metric selftests` step 已包含 `metrics-health.mjs --selftest`（R453/R455），与三个指标脚本同批防复发。

## 5. 边界与后续

- 本脚本只做"判定"，不做"采集"——输入由各指标脚本或运营提供；接入自动采集（从真库拉各指标实测值喂给 evaluateHealth）是独立后续，需生产数据就绪。
- healthy=false 是"运营信号"，不是故障告警——不触发任何自动动作，纯只读判定。
- 后续：TTFV 判定接入（需 ttfv-real-metrics 导出判定函数）；把健康度接入运营看板/API（仿 R449 同源贯通）。

## 6. 证据索引

- 脚本：`scripts/metrics-health.mjs`
- 指标方案：[W4 留存](w4-retention.md) · [SOP 成功率](sop-success-rate.md) · [北极星判据](north-star-business-confirmed.md)
- 状态总览：[PROJECT-STATUS.md](../PROJECT-STATUS.md)
