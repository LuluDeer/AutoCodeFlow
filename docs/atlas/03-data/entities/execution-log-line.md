# ExecutionLogLine 实体（execution_log_lines 表）— 执行日志明细行

> 所属: docs/atlas/03-data · 最后核对: 2026-09-13 · 对应代码: apps/admin-api/src/modules/task/entities/execution-log-line.entity.ts

## 所属模块与源文件

- 模块：[task 模块](../../01-apps/admin-api/modules/task.md)（`apps/admin-api/src/modules/task/`，日志保留子目录 `task/log-retention/`）
- 源文件：`apps/admin-api/src/modules/task/entities/execution-log-line.entity.ts`
- 配套工具：`task/log-retention/log-partition.util.ts`、`LogRetentionCleanupService`、`task/log-level.util.ts`

## 表名

`execution_log_lines`（`@Entity("execution_log_lines")`）

**该表自迁移 `1789900000002-PartitionExecutionLogLines.ts`（ARCH-22）起为按日 RANGE 分区表（分区键 `createdAt`）**，实体声明不变，细节见下方"分区与约束"。

## 字段表

| 列名 | 类型 | 说明 |
|---|---|---|
| `id` | int（serial） | 主键；分区化后与 `createdAt` 组成**联合主键 `(id, createdAt)`**（PG 要求唯一约束含分区键） |
| `executionId` | varchar NOT NULL | 所属执行 id，字符串引用 [task_executions](task-execution.md)，**无 FK** |
| `lineNumber` | int NOT NULL | 行号（同一执行内递增，读取按其排序分页） |
| `content` | text NOT NULL | 日志行内容 |
| `level` | varchar(8) nullable | OBS-03：写入时由 `levelOfLine(content)` 推断的级别（`ERROR`/`WARN`/`INFO`/`DEBUG`）；NULL=存量行或推断不出（level 过滤查询不返回 NULL 行）（迁移 `1789300000000`） |
| `createdAt` | timestamptz | DB-002：写入时间，保留期清理与分区的依据 |

## 索引与约束

实体声明 3 个 `@Index`，与分区迁移"只保留读取路径实际消费的三索引"一致：

| 索引 | 说明 |
|---|---|
| `(executionId, lineNumber)` | 基础读取路径：按执行取行 + 行序分页 |
| `(executionId, level, lineNumber)` | OBS-03：level 过滤查询免排序扫描（迁移 `1789300000000` 建 `IDX_execution_log_lines_execId_level_lineNumber`） |
| `(createdAt)` | DB-002：保留期分批 DELETE / 分区管理的范围扫描 |

### 分区与约束（迁移 `1789900000002`）

- `PARTITION BY RANGE (createdAt)`，PK 改为 `(id, createdAt)`；全库核对 id 无外部消费方，改造零破坏。
- 存量库在线搬迁：旧表 RENAME 为 **`execution_log_lines_legacy`**（保留为人工回退源，不 DROP），数据一次性 INSERT 后复用原序列保持 id 连续；迁移全幂等可续跑。
- **不建 DEFAULT 分区**：未来日期写入会显式报错而非静默堆积；每日预建 today-1 ~ today+7 分区由 `LogRetentionCleanupService.ensureUpcomingPartitions` 在同一 cron 内执行。
- 清理路径：优先 `ALTER TABLE … DETACH PARTITION` 按日剥离；DELETE 仅在 fallback 开关下使用。

## 关系

- **引用**：`task_executions.id`（无 FK，`executionId` 字符串）。
- **被引用**：无。`task_executions.logStorage='db'` 指针语义指向本表明细。

## 生命周期与写入方

- **写入**：`TaskService.storeLogLines`（回调/日志上报链路，先按 `executionId` delete 再分块 save——覆盖式写入，[回调上报](../../04-flows/execution-callback.md)）。注意：`LOG_STORAGE_DRIVER=s3` 且上传成功时**不写 DB 行**（仅回填 `logObjectKey` 指针）。
- **删除**：`LogRetentionCleanupService` 按保留期 `LOG_RETENTION_DAYS`（默认 30 天）清理：分区 DETACH 为主、分批 DELETE 为辅；`TaskService.storeLogLines` 覆盖写时也会按 executionId 删旧行。
- **读取**：执行日志分页接口（按 executionId + 可选 level，ORDER BY lineNumber）。

## 常见改动场景

1. **加列**：实体 + 迁移（幂等）；**注意分区表上所有唯一约束必须包含 `createdAt`**；同时考虑 legacy 表是否需要手工同步。
2. **调整级别推断**：只改 `task/log-level.util.ts`，无 schema 变化（存量 NULL 行不回填）。
3. **改保留期**：环境变量 `LOG_RETENTION_DAYS`，无 schema 改动（见 [06-infra](../../06-infra/)）。
4. **分区运维**（手工 DETACH/清理 legacy）：见仓库 `docs/operations.md`「分区表运维」段。
