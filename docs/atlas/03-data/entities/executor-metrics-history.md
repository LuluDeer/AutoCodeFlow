# ExecutorMetricsHistory 实体（executor_metrics_history 表）— 执行器指标快照

> 所属: docs/atlas/03-data · 最后核对: 2026-09-13 · 对应代码: apps/admin-api/src/modules/executor/entities/executor-metrics-history.entity.ts

## 所属模块与源文件

- 模块：[executor 模块](../../01-apps/admin-api/modules/executor.md)（`apps/admin-api/src/modules/executor/`）
- 源文件：`apps/admin-api/src/modules/executor/entities/executor-metrics-history.entity.ts`

## 表名

`executor_metrics_history`（`@Entity("executor_metrics_history")`）

## 字段表

主键 `id: uuid`。全字段（本表即一条"某执行器某时刻"的快照）：

| 列名 | 类型 | 说明 |
|---|---|---|
| `executorAddress` | varchar NOT NULL | 执行器地址（弱引用 [executors](executor.md).address，无 FK） |
| `cpuUsage` / `memUsage` / `diskUsage` | float nullable | CPU/内存/磁盘占用百分比 |
| `runningTaskCount` | int，default 0 | 快照时在途任务数 |
| `totalTaskCount` | int，default 0 | 快照时累计任务数 |
| `failedTaskCount` | int，default 0 | 快照时累计失败数 |
| `avgExecutionTime` | float nullable | 平均执行时长 |
| `uptimeSeconds` | int，default 0 | 执行器进程存活秒数 |
| `createdAt` | timestamptz | `@CreateDateColumn`，快照时间（也是分区/查询的时间轴） |

## 索引与约束

| 索引/约束 | 定义处 | 说明 |
|---|---|---|
| `(executorAddress, createdAt)` | 实体 `@Index(["executorAddress", "createdAt"])` | 趋势查询：单执行器按时间范围拉曲线 |

无唯一约束、无 FK——纯追加型时序快照表。

## 关系

- **引用**：`executors.address`（字符串，无 FK；执行器被物理删除后历史快照仍保留）。
- **被引用**：无。

## 生命周期与写入方

- **写入**：`ExecutorService` 心跳管道（心跳处理时 `metricsHistoryRepo.save(metricsHistoryRepo.create({...}))` 落一条快照；见 `getExecutorMetricsHistory` 读回接口）。
- **更新/删除**：无业务更新路径；append-only。

> ⚠️ 待核实：本表未见独立的保留期清理任务（与 execution_log_lines 的 `LOG_RETENTION_DAYS` 清理不同）；数据量随心跳频率线性增长，扩容前建议确认清理策略。

## 常见改动场景

1. **加指标列**（如 `gpuUsage`）：实体 `@Column` + 幂等迁移（`ADD COLUMN IF NOT EXISTS`，见 [migrations.md](../migrations.md)）+ 心跳上报契约（[executor-contract](../../01-apps/executor-contract.md)）+ 前端曲线（[pages-executors](../../01-apps/admin-web/pages-executors.md)）。
2. **加保留期清理**：参照 `task/log-retention/` 的清理服务模式新增 cron；若做分区化，注意唯一约束需含时间列。
