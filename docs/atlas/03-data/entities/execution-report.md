# ExecutionReport 实体（execution_reports 表）— 按日执行统计报表

> 所属: docs/atlas/03-data · 最后核对: 2026-09-13 · 对应代码: apps/admin-api/src/modules/metrics/entities/execution-report.entity.ts

## 所属模块与源文件

- 模块：[metrics 模块](../../01-apps/admin-api/modules/metrics.md)（`apps/admin-api/src/modules/metrics/`）
- 源文件：`apps/admin-api/src/modules/metrics/entities/execution-report.entity.ts`

## 表名

`execution_reports`（`@Entity("execution_reports")`）

## 字段表

主键 `id: int`（`@PrimaryGeneratedColumn()`，serial）。全字段——每行 = 某一天的执行统计：

| 列名 | 类型 | 说明 |
|---|---|---|
| `triggerDay` | date NOT NULL | 统计日（**唯一**）；按天聚合的分区键 |
| `runningCount` | int，default 0 | 当日 running 状态执行数 |
| `successCount` | int，default 0 | 成功数 |
| `failCount` | int，default 0 | 失败数 |
| `timeoutCount` | int，default 0 | 超时数 |
| `cancelledCount` | int，default 0 | 取消数 |
| `avgDurationMs` | float，default 0 | 平均时长（ms） |
| `maxDurationMs` | float，default 0 | 最大时长（ms） |
| `minDurationMs` | float，default 0 | 最小时长（ms） |
| `updateTime` | timestamptz | `@UpdateDateColumn`（注意列名不是 updatedAt） |
| `createdAt` | timestamptz | `@CreateDateColumn` |

## 索引与约束

| 索引/约束 | 定义处 | 说明 |
|---|---|---|
| `UNIQUE (triggerDay)` | 实体 `@Index(["triggerDay"], { unique: true })` | 一天一行，重算走 upsert |

## 关系

- **引用 / 被引用**：均无 FK。数据来源是 [task_executions](task-execution.md) 的聚合（按 `status` 与 `duration` 分桶统计），属于纯派生表。

## 生命周期与写入方

- **写入**：`MetricsService.generateReport(date)` —— 按 `triggerDay` 聚合当日 [task_executions](task-execution.md) 后写/覆盖当日行（upsert 语义，靠 triggerDay 唯一约束）。
- **读取**：`getReports`（区间）、`getTodayReport`、`getRecentReports(days)`——dashboard 报表与趋势图（[pages-system](../../01-apps/admin-web/pages-system.md)）。

## 常见改动场景

1. **加统计维度**（如按 runtime/project 细分）：本表一行一天的形态不够用，建议新建明细维度表而非加列；若只加"全日汇总列"，走实体+迁移（幂等）+ `generateReport` 聚合逻辑。
2. **重算历史**：`generateReport` 可对任意 date 重放（幂等覆盖），补数不需要迁移。
3. **时区口径**：`triggerDay` 是 date 列，聚合起点 `startOfDay` 的时区处理在 `MetricsService`，改口径需同步重刷存量行。
