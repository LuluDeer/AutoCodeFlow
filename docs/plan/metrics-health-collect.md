# 先行指标健康度采集入口 —— 一条命令出健康度（R456）

> **受众**：PM / 运营 · **状态**：内部 · **最后核对**：2026-11-21
> R455 的 `evaluateHealth` 需人工喂 inputs；本脚本补采集层，串行跑三个指标脚本 → 组装 inputs → 判定，一条命令出全貌。零新口径。

## 1. 做什么

`scripts/metrics-health-collect.mjs` 串行跑三个既有指标脚本的 `--report --json`（继承 DB env），提取实测值 → 调 R455 的 `evaluateHealth` → 输出健康度：

| 来源脚本 | 提取字段 | → evaluateHealth input |
|---|---|---|
| `w4-retention.mjs` | `retention_rate` | `w4_retention_rate` |
| `sop-success-rate.mjs` | `success_rate` / `takeover_rate` | `sop_success_rate` / `sop_takeover_rate` |
| `north-star-weekly.mjs` | `promotionEligibility.eligible` | `north_star_promotion_eligible` |

**零新口径、零 DB 逻辑复刻**——只做编排与字段映射，判定逻辑仍是 R455 的单一事实源。

## 2. fail-closed

某脚本 SKIP（无连接/缺表）或报错 ⇒ 对应 input=null ⇒ `evaluateHealth` 判 `no_data`（met=false），**绝不伪造达标**。输出每条带 `collected[key].source`（如 `sop:OK` / `w4-retention.mjs:SKIP` / `sop:error(...)`）便于诊断。无连接时四指标全 no_data、healthy=false。

## 3. CLI

- `node scripts/metrics-health-collect.mjs [--as-of ISO] [--days N] [--json]`
- `--as-of` 透传给三个脚本；`--days` 只给 SOP（W4 窗口固定 28 天）。
- 退出码：0 输出健康度（healthy 与否都是只读信号、非故障）/ 2 结构错。

## 4. 验收（R456）

- `node --check`、script-main-guard exit 0。
- **无连接 fail-closed**：不设 DB env → 四指标全 `no_data`、healthy=false、source 均 `:SKIP`，note 提示"需先启用埋点"。
- **真库采集**：测试库造 3 SOP assignment（2 completed + 1 failed）→ 采集得 SOP `success_rate=0.667`/`takeover_rate=0.333`（source `sop:OK`，字段映射正确），W4 无数据 `no_data`、north-star `eligible=false`（source OK），总体 healthy=false；清理残留 0。
- 过程中把 SKIP 识别从 `JSON.parse` 异常改为显式 `text.startsWith("SKIP:")`，source 从 `error(JSON parse)` 变干净的 `:SKIP`。

## 5. 边界与后续

- 本脚本不自动调度——一次手动/CI 调用出一帧健康度；定时巡检需接调度（建议等生产数据就绪，否则每帧都是 no_data）。
- TTFV/24h 仍不在健康度判定内（R455 已说明）。
- 后续：接运营看板/API 展示（仿 R449），或 CI 巡检（需生产样本）。

## 6. 证据索引

- 脚本：`scripts/metrics-health-collect.mjs` · 判定：[metrics-health.md](metrics-health.md)
- 状态总览：[PROJECT-STATUS.md](../PROJECT-STATUS.md)
