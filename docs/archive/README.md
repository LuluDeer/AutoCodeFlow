# 归档区（Archive）

> **这些文档是历史快照，不随代码更新。** 用于追溯「当时为什么这么做」，
> 不作为当前行为的依据。当前有效文档请回 [文档中心](../README.md)。

## 为什么单独放这里

治理前，一次性报告（审计结论、实施总结、CI 排查记录）和已完成的优化计划
散落在**仓库根目录**，与 `README.md`、`LICENSE`、`CONTRIBUTING.md` 混在一起。
后果是：新读者分不清哪份是当前事实、哪份是三个月前的快照；根目录也失去了
「一眼看懂这个仓库是什么」的作用。

归档不是删除：文件用 `git mv` 迁移，**历史完整保留**，全仓引用已同步重写。

## 目录结构

| 目录 | 内容 | 典型来源 |
|---|---|---|
| [`plans/`](plans/) | 已完成的优化计划与历史开发计划 | 根目录 `PLAN-*.md`、`PLANS-INDEX.md`、`docs/DEVELOPMENT-PLAN-2026-09*` |
| [`reports/`](reports/) | 一次性实施报告、审计结论、排查记录 | 根目录 `AUDIT-*.md`、`FINAL-SUMMARY.md`、`NEXT-ACTIONS.md`、`docs/CI_*` |
| [`audits/`](audits/) | 全栈 / 前端 / UX / 安全专项审计 | `docs/*-AUDIT-*.md`、`docs/SEC-01-*` |
| [`reviews/`](reviews/) | 深度评审与逐轮复核报告 | `docs/DEEP_REVIEW_*`、`docs/review_*`、`docs/reviews/*` |
| [`progress/`](progress/) | 轮次进度快照 | `docs/PROGRESS-round*` |
| [`handoffs/`](handoffs/) | 已过期的会话交接 | `docs/HANDOFF-*` |
| [`verifies/`](verifies/) | 真机验证记录 | `docs/VERIFY-<日期>-*.md` |
| [`incidents/`](incidents/) | 事故复盘与演练报告 | `docs/INCIDENT-*`、`docs/CHAOS-DRILL-*` |

## 使用约定

1. **引用归档文档时**，在链接文字里写明「历史快照」与日期，避免被当成当前契约。
   例：`[2026-10 审计结论（历史快照）](reports/audit-final-report-2026-10-17.md)`。
2. **不要把归档文档当规范**。规范在 [文档中心](../README.md) 的 2.1 / 2.2 两节。
3. **新增归档**：直接把文件放进对应子目录，并在本文件的目录表补一行。
   CI 的孤儿检查对 `archive/` 豁免，但本文件仍建议保持索引完整。
4. **不要从归档里「复活」旧计划**：若结论已过时，写新的 ADR 或在
   [PLAN-CLAIMS.md](../PLAN-CLAIMS.md) 开新行，而不是修改历史快照。

## 仍然有效的「历史」文档

以下文档虽然名字带日期或轮次，但**仍在维护**，因此留在主文档面：

| 文档 | 为什么不算归档 |
|---|---|
| [`../PLAN-CLAIMS.md`](../PLAN-CLAIMS.md) | 任务认领唯一事实源，脚本会读（`check-migrations.mjs`） |
| [`../AGENT_HANDOFF.md`](../AGENT_HANDOFF.md) | 跨会话交接的活文档，持续追加 |
| [`../DEVELOPMENT-PLAN-2026-10.md`](../DEVELOPMENT-PLAN-2026-10.md) | 本期计划，尚未清偿 |
| [`../VERIFY-MATRIX.md`](../VERIFY-MATRIX.md) | 长期复用的验证清单，不是一次性记录 |
| [`../ARCH-MULTI-INSTANCE-MATRIX.md`](../ARCH-MULTI-INSTANCE-MATRIX.md) | 多实例行为矩阵，结论仍然有效 |
