# ADR-024: 执行记录归档——保留期之外的 `task_executions` 是留是删

状态：Proposed（待拍板；**本轮不实施**，理由见文末）

> 本文把 `docs/archive/plans/backend-architecture.md` §2.2「执行记录归档」从悬而未决转成**可拍板**的决策文档。
> 结论前置：这**不是**技术方案选型题，是「合规是否要求留存超过保留期的执行记录」这道**业务题**。
> 在拿到该前提之前，本文推荐维持现状（选项 D/A），不建归档表。

---

## 背景

### 现状：Q7 每日一次性硬删，删除不可逆，没有归档

保留期清理由 `ExecutorService.cleanupOldRecords` 承担：

| 事实 | 位置 |
|---|---|
| cron 表达式 `0 0 2 * * *`（每日 02:00） | `apps/admin-api/src/modules/executor/executor.service.ts:4706` |
| 多实例门禁：非 cron Leader 直接 return | `executor.service.ts:4708` |
| 保留期取用（并**再归一一次**，见下节） | `executor.service.ts:4713-4721` |
| cutoff = `now - days × 86400000` | `executor.service.ts:4722` |
| 分批大小 `EXECUTION_RETENTION_BATCH_SIZE = 5000` | `executor.service.ts:4734` |
| 分批循环入口 `cleanupOldTaskExecutions` → `cappedBatchedDelete` | `executor.service.ts:4746-4754` |

**终止闸**（这条决定了「一晚最多删多少」）：公共 helper `cappedBatchedDelete`
（`apps/admin-api/src/common/utils/capped-batched-delete.util.ts:52`）同时压轮数与墙钟——
`LOG_RETENTION_MAX_DELETE_ROUNDS = 200`（`:24`）、`LOG_RETENTION_MAX_DURATION_MS = 10 分钟`（`:26`）。
即 **单晚上限 5000 × 200 = 100 万行**；超出的余量交给下一晚（清理幂等，晚一晚无副作用）。

**事务边界（关键，且与直觉不同）**：`deleteExpiredExecutionRowsBatch` 里**没有**显式
`dataSource.transaction(...)`。两条路径都是「单条语句 / 语句序列」：

- **非 S3 部署**（`executor.service.ts:4773-4788`）：一条
  `DELETE FROM task_executions WHERE id IN (SELECT id ... WHERE createdAt < :cutoff ORDER BY id LIMIT :batchSize)`。
  单语句即单事务。
- **S3 部署**（`executor.service.ts:4789-4821`）：先 `find` 取一批 `(id, logObjectKey)`，
  逐条 `s3.remove(key)`，成功的收进 `deletableIds`，最后
  `execRepo.delete({ id: In(deletableIds) })`（`:4819`）。
  **S3 对象回收与 DB 删行不原子**：对象已删、DB 删行失败时，行留着但指针指向已消失的对象；
  反之某条 `s3.remove` 失败则 `continue`（`:4806-4813`，fail-open）——**该行整行保留**，
  指针留着让下一轮 cron 重试。这是一个刻意的「宁可少删，不可留孤儿」方向。

### 连带影响（逐项核实过，不是推测）

**(1) 执行日志表 `execution_log_lines`：外键根本不存在，靠独立保留期各自清理。**

其按日分区 DDL 只有联合主键、**没有任何 `REFERENCES`**
（`apps/admin-api/src/migrations/1789900000002-PartitionExecutionLogLines.ts:128-136`）；
全仓检索 `REFERENCES "task_executions"` **零命中**。实体侧也没有 `@ManyToOne`
（`apps/admin-api/src/modules/task/entities/execution-log-line.entity.ts:9-36`，`executionId`
只是 `@Column()`，`:26`）。日志由 `LogRetentionCleanupService` 独立清理：

- cron `0 30 3 * * *`（每日 03:30）——`log-retention-cleanup.service.ts:22`
- 保留期读 `logRetention.days`——`apps/admin-api/src/config/configuration.ts:548`
  （`parseInt(LOG_RETENTION_DAYS || "30")`，即**代码缺省 30 天**；但 `.env.example:367`
  随附的示例值是 **7**，`docs/deployment.md:93` 的配置表也写 7。两者都远小于执行保留期的 90）
- 分区库主路径走 `DETACH PARTITION` + `DROP`；legacy 路径才是分批 DELETE
  （`log-retention-cleanup.service.ts:302`）

**这条派生出两个现在就已经存在的后果：**

- 无论取哪个缺省（代码 30 / 示例 7），都**远小于** `TASK_EXECUTION_RETENTION_DAYS=90` →
  一条 90 天窗口里的执行，**从第 31 天（甚至第 8 天）起就再也看不到自己的明细日志**
  （行还在，日志没了）。
- 反过来，若有人把 `LOG_RETENTION_DAYS` 调**大**到超过执行保留期，删 `task_executions`
  行**不会**带走 `execution_log_lines` 行（无 FK）→ **产生孤儿日志行**。
  当前缺省值下不会发生，但这是一个配置就能触发的静默问题。

**(2) `task_executions.logs`（text 列）随行一起删。**
`task-execution.entity.ts:235`。单条上限 512 000 字符
（`execution-list-projection.ts:4-5` 引 `execution-callback.dto.ts` 的 `@MaxLength(512_000)`）。

**(3) S3 日志对象有两条回收路径，先手已把「孤儿」堵住。**

- 独立回收：`S3LogObjectRetentionService.cleanupExpiredObjects`
  （`apps/admin-api/src/modules/task/log-retention/s3-log-object-retention.service.ts:113`），
  cron `0 35 3 * * *`（每日 03:35，`:16`），批 200 行 × 最多 50 轮（`:18`、`:20`），
  保留期同样读 `logRetention.days`（`:206-218`）。
- 删行前兜底：Q7 自己在 `s3.remove` 后才删行（上文）。
  → 对象通常在**行被删之前**就已经被回收且指针被清空（提前量 = 90 天执行保留期 − 日志保留期），
  Q7 那条兜底大概率是空跑。
  `docs/operations.md:143` 的表述与此一致。

**(4) `execution_reports` 日聚合表：与执行行只有「日期」这一层弱关联，且完全没有 retention。**

`apps/admin-api/src/modules/metrics/entities/execution-report.entity.ts:10-11`：
`@Entity("execution_reports")` + `@Index(["triggerDay"], { unique: true })`。
列是 `runningCount / successCount / failCount / timeoutCount / cancelledCount` 与
`avg/max/minDurationMs`（`:19-41`）——**纯计数，无 `executionId`，无外键**。

关联方式：`TaskService.getExecutionReport` 把执行的 `createdAt` 截到本地零点，按
`triggerDay` 等值查一行（`apps/admin-api/src/modules/task/task.service.ts:2765-2775`）。

**业务代码里没有任何清理路径**（全仓 `ExecutionReport` 的引用只有 metrics 写入、
task 读侧与 DTO；无 DELETE、无 retention）。

→ 所以：删执行行**不会**连带删聚合行。但聚合行也**救不回**已删的执行——
`getExecutionReport` 第一步就是 `this.getExecution(id, taskId)`（`:2764`），行没了直接 404，
根本走不到读聚合那一步。**日聚合是 90 天后唯一还活着的残留，而它已经不可达且不含任何单次执行细节。**

**(5) `task_executions` 是级联的父表，没有任何表引用它。**

唯一的外键是 `taskId → tasks(id) ON DELETE CASCADE`
（`apps/admin-api/src/migrations/1717473142679-TaskExecutionForeignKey.ts:22-26`）——
方向是「删任务 → 级联删执行行」，**不是**反的。

这同时说明两件事：① 删执行行**不会**产生跨表孤儿（外键层面安全）；
② 若将来真要建归档表，**不需要处理任何入向外键**，这是选项 B 唯一省事的地方。

> ⚠️ 注意：**删执行行不产生孤儿，不等于不影响其它表**——(1) 的孤儿日志是「保留期错配」造成的，
> 不是外键造成的；(4) 的聚合行则是「本来就无关」。

### 表结构与索引（决定归档搬移的代价）

实体 `apps/admin-api/src/modules/task/entities/task-execution.entity.ts:153`。

**大文本 / 大对象列（搬移成本就在这里）**：

| 列 | 类型 | 位置 |
|---|---|---|
| `logs` | text（单条上限 512 000 字符） | `:235` |
| `aiAnalysis` | text | `:256` |
| `result` | jsonb | `:241` |
| `params` | jsonb | `:242` |
| `artifacts` | jsonb | `:261-262` |

列表读面已显式排除 `logs` + `aiAnalysis`
（`execution-list-projection.ts:31-34`），统计卡再排除 `result`
（`task.service.ts:2729-2731`）——说明**这三个列在实际查询里基本不被读**，
这是评估「归档表要不要保留大文本」的直接依据。

**索引：实体声明 10 条（`:154-199`），但迁移分散在十余个文件里且持续增删。**
生产 `synchronize=false`，**迁移才是 schema 唯一来源**（实体 `:155-160` 的注释就写着这条纪律）。
因此这里不列「完整清单」（会腐坏），只列对**本决策**有判据意义的三组事实：

| 组 | 事实 | 位置 |
|---|---|---|
| 清理只用得到 2 列 | 保留期删除的 `WHERE createdAt < :cutoff` + `ORDER BY id` | `executor.service.ts:4778-4783`、`:4791-4793` |
| 5 条 partial 索引**全部**以 `status = 'running'` 为谓词 | 只覆盖「正在跑」的行，对历史行**恒为空** | `migrations/1717473142691-AddMissingUniqueAndCompositeIndexes.ts:39-41`（`idx_task_executions_running`）、`1790000000026-AddRolloutAndRunningStartPartialIndexes.ts:27-29`（`idx_task_executions_start_time_running`）、`1790000000055-AddTaskExecutionsExecutorId.ts:64`（`idx_task_executions_executor_id_running`）、`1790000000044-AddMutexGroups.ts:85-87`（`idx_task_executions_group_occupancy`）、`1790000000052-AddMutexGroupScope.ts:47-49`（`idx_task_executions_group_occupancy_global`） |
| 非 partial 的按 taskId / createdAt / status / executorAddress / failureReason / traceId 等建的索引另有十余条（含已被 `1790000000051` 并发删掉的冗余索引） | 每条都要在归档表上复制一遍 = 写放大 | 例如 `1717473142683-AddPerformanceIndexes.ts:20`、`1790000000029-AddTaskExecutionDeclaredIndexes.ts:33-46`、`1790000000049-AddExecutionTaskCreatedAtIndex.ts:38` |

→ 推论：**「归档表照抄现有索引」是有害的**。历史行永远不会是 `running`，
那 5 条 partial 索引在归档表上纯属白建；而归档表真正需要的往往只有
`(createdAt)`（按窗口筛）与 `(taskId, createdAt)`（按任务回溯）两类。

### 保留期旋钮的真实语义

两级归一，同样的判据写了两遍：

| 级 | 位置 | 规则 |
|---|---|---|
| 配置归一 | `apps/admin-api/src/config/configuration.ts:566-571` | `parseInt(env.TASK_EXECUTION_RETENTION_DAYS \|\| "90", 10)`；`Number.isFinite(n) && n > 0 ? n : 90` |
| 取用点再归一 | `executor.service.ts:4713-4721` | 仅当 `typeof === "number" && isFinite && > 0` 才用；否则回落 **90** |

**为什么要归一两次**（`executor.service.ts:4710-4712` 的记录）：`?? 90` 抓不到「类型不对」的值——
如 `ConfigService.get()` 返回字符串 `"http"`（既有单测就这么 mock），乘毫秒数会得到 `Invalid Date`，
cutoff 变成无效比较。而归一后的危险方向只有一个：**cutoff 被推到未来 → 一次删空整表**
（`configuration.ts:564-565`）。

实际边界（`parseInt` 语义）：`""` → 兜到 `"90"`；`"abc"` → `NaN` → 90；`"0"` / `"-5"` → 90；
`"90abc"` → 90；`"365"` → 365。**没有「关掉清理」的取值**——想停只能停 admin-api 的 cron。

### 现有文档里关于「不可逆、无归档表」的表述（逐条，供引用/同步）

| 文件 | 行 | 表述 |
|---|---|---|
| `.env.example` | `:371-376` | 段标题「执行记录保留」+ ⚠️ **硬删除且不可逆**、**没有归档表**、需留存的历史必须到期前自行导出、非法/非正数回退 90、`# TASK_EXECUTION_RETENTION_DAYS=90`（注释掉的缺省值） |
| `docs/deployment.md` | `:94` | 配置表行：Q7 每日 02:00 cron、仅 cron Leader、⚠️ 硬删除不可逆、没有归档表、缺省 90 与硬编码时期一致、归一语义、调小=更早丢历史 |
| `docs/operations.md` | `:778-789` | 引用块：不可逆硬删除 + 没有归档表 + 删行连带回收执行日志与 S3 对象 + **没有「先归档再删除」的自动路径** + 调小属破坏性变更 + 归一说明 |
| `apps/admin-api/src/config/configuration.ts` | `:551-571` | 代码注释：硬删除、没有归档表、归一理由 |
| `apps/admin-api/src/modules/executor/executor.service.ts` | `:4697-4701` | 方法头注释：硬删除且不可逆、没有归档表、需留存须自行导出 |

另有两处**不能直接照抄**的：`docs/archive/plans/backend-architecture.md:171-199` 的 §2.2 示例代码写的是
`executions` / `executions_archive` / `created_at` / `@Cron('0 3 * * *')` / 90 天 ——
**与真实 schema 全不符**（真实表 `task_executions`、真实列 `createdAt`、真实 cron `0 0 2 * * *`）；
以及 `:634-644` 的进度说明（本轮之前的状态快照）。

### 为什么这是业务决策而不是技术活

清理链本身已经工程完备：LeaderGate、分批、轮数/墙钟双闸、S3 先回收、fail-open、两级归一。
**剩下的唯一未知量是「这些数据该不该在 90 天后消失」**——外部输入，不是代码能回答的。

上一轮驳回「顺手建表」的理由（`docs/archive/plans/backend-architecture.md:642-644`）依然成立：
没有「合规要求留存」这个前提就建归档表 = **凭空多一条要长期维护的写入路径 + 一份永远没人查的数据**。

---

## 决策选项

四个选项按「是否保留保留期之外的数据」分两类：
**A / D 不保留**（只是窗口长短不同），**B / C 保留**（只是存放介质不同）。

### A. 维持现状：90 天硬删，不留档

| 维度 | 评估 |
|---|---|
| 存储成本量级 | **常量**：稳态 = 最近 90 天窗口内的行。当前实现下这是**唯一能让表变小的选项** |
| 查询可用性 | 窗口内**全功能**：列表（`task.service.ts:2337`）、详情、日志分页、重试链、报告端点、执行器维度、artifacts |
| 实现复杂度 | **0**（已上线并有多轮审计） |
| 可回溯性 | **仅 90 天**。超期即 404 且不可恢复 |
| 迁移风险 | **0** |

**代价**：过期即永久消失，无副本、无软删标记、无回收站。

### B. 同库归档表 `task_executions_archive`，定期搬移

| 维度 | 评估 |
|---|---|
| 存储成本量级 | **线性且永不回收**：稳态 = 90 天窗口 **+ 全部历史**。这是最容易低估的一项——A 是常量，B 是单调增长 |
| 查询可用性 | SQL 直查最强（可 JOIN、可索引）；但**今天没有任何读面**（REST / UI 都不认这张表）。建表必须连读面一起交付，否则就是「没人查的数据」 |
| 实现复杂度 | **中**。见下方四道坎 |
| 可回溯性 | **完整**（前提是 `logs` / `result` / `artifacts` 一起搬） |
| 迁移风险 | **四选项最高**（详见下） |

四道必须过的坎：

1. **搬移的原子性**：`INSERT INTO archive SELECT ...` 与 `DELETE FROM task_executions` **必须同一事务**。
   否则中断会在「两处都有」（重复，可容忍）或「两处都没有」（**数据丢失**）之间落点。
   现有清理路径恰恰是**无显式事务**的（见背景），照抄它的写法会把「无归档」的旧问题原样带进新路径。
2. **与现有 cron 的竞态**：归档作业与 Q7 都对老行做 DELETE。若 Q7 先跑，归档作业的 SELECT 拿到空集——
   良性但静默（该归档的没归档，且没人会知道）。这个失败模式 **A 选项完全没有**。
3. **S3 指针的归属**：现有 `deleteExpiredExecutionRowsBatch` 假设「删行 = 该行指针可以清掉」。
   若归档行保留了 `logObjectKey`，而对象已被 `S3LogObjectRetentionService`（每日 03:35）回收，
   归档行就成了**死指针**。要么归档不保留指针（只留 `logStorage` 状态），要么明确「归档行日志不可取」。
4. **索引不能照抄**：现有 5 条 partial 索引全部以 `status='running'` 为谓词（见「表结构与索引」）——
   对历史行**永远为空**。归档表照抄一遍等于白建 5 个索引 + 5 份写放大。

### C. 冷存储：导出到 S3 / 对象存储后删

| 维度 | 评估 |
|---|---|
| 存储成本量级 | **最省**：对象存储单价通常远低于块存储，且可压缩（gzip / 列存 Parquet） |
| 查询可用性 | **最差**：不能 SQL 直查，要回溯必须先取回并导入临时表 |
| 实现复杂度 | **中高**：导出格式 + schema 演进约束（表加列后旧文件怎么办）、manifest/校验和、重复导出幂等 |
| 可回溯性 | 做对了是**最好**的（异地、不可变、可校验和）；做砸了就是「一堆没人能解析的文件」 |
| 迁移风险 | **中**：新增出网写路径与凭据（已有 `LOG_STORAGE_*` / MinIO 可复用），但失败姿态必须与现有相反 |

**唯一但要命的约束**：**导出成功才能删**。这是 fail-closed（导出失败 → 不删），
而现有 S3 回收是 fail-open（删不掉就跳过、行保留，`executor.service.ts:4806-4813`）——
两个方向相反，实现时必须在**不同代码路径**上，不能共用同一个 helper 的失败语义。

### D. 延长保留期：只调 `TASK_EXECUTION_RETENTION_DAYS`，不做归档

| 维度 | 评估 |
|---|---|
| 存储成本量级 | **线性**：行数 ≈ 日增速 × 天数。受 DB 盘容量约束 |
| 查询可用性 | **最好**：90 天能查的 365 天照样能查，**零新代码、零新读面** |
| 实现复杂度 | **0**（旋钮已存在，`configuration.ts:566`） |
| 可回溯性 | 等于配置值；但**依然不可逆**——调小之后，之后每个 02:00 都会把超出新窗口的行删掉 |
| 迁移风险 | **0**（配置变更） |

**D 与 A 不是两个方案，是同一机制的两个取值。** 真正的问题只是「取多少天」。

### 汇总矩阵

| | 存储 | 查询 | 复杂度 | 可回溯 | 风险 |
|---|---|---|---|---|---|
| **A** 硬删 | 常量（最小） | 窗口内全功能 | 0 | 90 天 | 0 |
| **B** 归档表 | 线性增长（最大） | 需自建读面 | 中 | 完整 | 高 |
| **C** 冷存储 | 最省 | 需先取回 | 中高 | 最好（若格式正确） | 中 |
| **D** 延长保留期 | 线性（可控） | 最好（零改动） | 0 | = 配置值 | 0 |

> 关键判据：**「需要留存」和「需要能查」是两个不同的需求。**
> B 同时满足两者但最贵；C 只满足留存；D 两者都不满足，只买时间。

---

## 推荐与触发条件

### 推荐：现阶段选 D（作为 A 的显式参数化），把 B/C 挂到明确触发条件上

理由：

1. **目前没有证据表明存在「留存 ≥ N 年」的外部要求。** 没有这个前提，B 会引入一条长期维护的
   写路径 + 一份没有读面的数据——正是上一轮驳回它的理由。
2. **D 与 A 共用同一条已验证的清理链**（LeaderGate + 分批 + 双闸 + S3 先回收 + 两级归一），
   零新增失败模式。把 90 调到 365 等于「用磁盘换时间」。
3. 而**时间正是这个决策的压力来源**——D 买到的是**等待合规结论的窗口**，不是最终答案。
   它让「还没拍板」这件事从「每天在丢数据」变成「每天在花钱」。

### 触发条件表（谁在什么情况下必须切到哪个）

| 触发条件 | 应选 |
|---|---|
| 合规/法务确认「无留存超过 X 的要求」 | **A**（或按磁盘预算取 D 的某天数）；本 ADR 记 Accepted(现状) 后关闭 |
| 有留存要求，但日常**不查**、只应监管/审计调阅 | **C**（冷存储） |
| 有留存要求，且必须能**按条件筛查**（复盘 / 计费口径 / 纠纷举证） | **B** + 必须同批交付读面 |
| 只是嫌 90 天太短、要更长的**在库**窗口，且无外部留存要求 | **D** |
| 磁盘是硬约束，同时又必须留存 | **C**（导出后删），**不是** D |

### 成本量级：给方法，不给数字

本文**刻意不写任何具体成本数字**（行数、磁盘、单价因部署而异，写死就是编造）。
拍板前请按下面五条实测，再乘本单位单价：

```sql
-- ① 稳态每晚要搬/要删的行数（选项 B/C 的工作量）
SELECT count(*) FROM task_executions
WHERE "createdAt" < now() - interval '90 days';

-- ② 是否已经追不上：日清理上限是 100 万行（5000 × 200）
--    ①的输出持续 > 1000000 ⇒ 现有 cron 已在积压
-- ③ 日增速，外推 D 的线性成本
SELECT date_trunc('day', "createdAt") AS d, count(*) FROM task_executions
GROUP BY 1 ORDER BY 1 DESC LIMIT 30;

-- ④ 大文本列占比（决定 B 归档表要不要保留 logs/aiAnalysis）
SELECT pg_size_pretty(sum(pg_column_size(t.logs))::bigint)          AS logs_bytes,
       pg_size_pretty(sum(pg_column_size(t."aiAnalysis"))::bigint)  AS ai_bytes,
       pg_size_pretty(sum(pg_column_size(t.result))::bigint)        AS result_bytes
FROM task_executions t;

-- ⑤ 含索引与 TOAST 的真实占用（A vs D 的磁盘增量用这个口径，不要用行数乘平均行宽）
SELECT pg_size_pretty(pg_total_relation_size('task_executions'));
```

量级换算：**稳态字节 ≈ 平均行宽（含 TOAST 与索引，取 ⑤ ÷ 行数）× 目标窗口行数**。

### 顺手可落的最小改进（不依赖 A/B/C/D 任何一个）

现状文档反复说「需要留存的历史必须在到期前自行导出」
（`.env.example:373`、`docs/deployment.md:94`、`docs/operations.md:785-786`），
但**这个能力目前不成立**：

- 执行记录的导出只有前端 CSV，且**只导当前页**
  （`apps/admin-web/src/pages/ExecutionsPage.tsx:77-79` 明写「全量导出需要后端流式端点，此处不做」；
  实现见 `:84` `buildExecutionsCsv` 与 `:254` `handleExportCsv`）。
- 对照：审计日志有**后端**导出端点（`apps/admin-api/src/modules/audit/audit.controller.ts:54-81`，
  CSV、上限 10 000 行 `audit.service.ts:198`）——执行记录**没有对等物**。

所以「到期前自行导出」在工程上只能靠人工翻页。**把这句话变成真的**（一个后端流式导出端点）
是独立于本 ADR 的小改动，且无论最终选 A/B/C/D 都值得做。

---

## 不决策的代价（时间压力来源）

现状下超期数据被**不可逆删除**，且没有任何中间态：

1. **删除本身不可撤销**：`executor.service.ts:4773-4788`（非 S3）/ `:4819`（S3）= `DELETE`，
   没有软删标记、没有 `deletedAt` 列、没有回收站。删掉的 `logs` / `result` / `artifacts` 一起消失。
2. **每过一天，就有一天的执行记录永久消失。** 这是本文唯一有**时间不可逆**性质的结论——
   其它分歧都可以以后补，这一项补不回来。
3. **一旦需要追溯（事故复盘 / 客户纠纷 / 合规审计 / 计费对账），数据已经没了**，而且：

   - `execution_log_lines` **更早**就没了（代码缺省 30 天 / 示例 7 天，见背景 (1)）——
     「90 天内的执行、但更早之前的日志」这个区间**现在就已经是空的**；
   - `execution_reports` 只剩日聚合计数，不含任何单次执行细节，且关联不到执行行
     （`task.service.ts:2764` 先查执行，404 就没了）；
   - **全库备份不是可行手段**：`BACKUP_RETENTION_DAYS` 缺省 30（`.env.example:476`），
     恢复是整库时间点恢复，不是「取回某条执行记录」。
4. **一次误配就能提前引爆**：`TASK_EXECUTION_RETENTION_DAYS=1` 是合法值
   （归一只管 ≤0 / 非数），下一个 02:00 就会把 90 天的历史压到 1 天。
   现有防御只保证「不会删空表」，**不保证「不会删掉你还需要的东西」**。

---

## 待拍板项

### 需要谁

| 角色 | 需要回答 |
|---|---|
| **合规 / 法务** | 是否存在书面的执行记录留存要求？年限？**粒度**（单次执行元数据 / 完整日志 / 产物）？ |
| **安全 / 审计** | 若留存，是否要求不可篡改、异地、可校验和？（决定 C 的 manifest 设计） |
| **运维 / 平台** | DB 盘预算上限是多少？（决定 D 的天数上限） |

### 需要哪些信息

1. 是否存在外部留存要求；有则给出年限与粒度。**这是唯一的分水岭**：
   没有 → A/D；有且要能查 → B；有但只存档 → C。
2. 「可查」是硬需求，还是「能取回就行」？
3. 实测数据：稳态超期行数、日增速、`logs` 占比、`pg_total_relation_size`
   （直接用上节五条 SQL，不猜）。
4. 磁盘预算上限（决定 D 能走多远）。
5. 确认「DB 备份不能替代归档」这一前提（见上节第 3 点）。

### 拍板后的动作

本 ADR 转 `Accepted`，并把选中方案落成独立实施项：
选 B → 需同时产出「表 DDL + 事务性搬移作业 + 读面端点」三件套；
选 C → 需同时产出「导出格式 + manifest + fail-closed 删除闸」三件套；
选 D → 只改 `TASK_EXECUTION_RETENTION_DAYS`，并同步上述五处文档表述。

---

## 本轮不实施（明确）

**本轮不建 `task_executions_archive`、不写迁移、不改任何代码、不改任何配置缺省值。**

理由：

1. **缺少前提**：「合规是否要求留存超过保留期的执行记录」尚未回答。
   在没有这个前提时建表，等于凭空增加一条需要长期维护的写入路径，
   和一份永远没人查的数据——这正是上一轮驳回它的理由
   （`docs/archive/plans/backend-architecture.md:642-644`），本轮没有新证据推翻它。
2. **前置条件未就绪**：B 的四个坎（事务原子性、与 Q7 的竞态、S3 指针归属、索引裁剪）
   与 C 的 fail-closed 删除闸，都取决于「留存粒度」这个还没人回答的问题。
   先写代码会把猜测固化进 schema。
3. **本轮的真实产出是「可拍板」**：把清理链的真实行为、连带影响、四个选项的代价
   和不决策的代价写成一份没读过代码也能决策的文档。这比再写一版无人维护的表更有价值。

**唯一不被本条限制的动作**：拍板后另行排期的实施项（见上节「拍板后的动作」）。

---

## 替代方案（被否）

- **照抄 `docs/archive/plans/backend-architecture.md:171-199` 的 §2.2 示例代码**：不能直接落地。
  它写的是 `executions` / `executions_archive` / `created_at` / `@Cron('0 3 * * *')`，
  与真实 schema 全不符（`task_executions` / `createdAt` / `0 0 2 * * *`）；
  且示例是「先 INSERT 再 DELETE」两条独立语句、无事务、无分批、无双闸——
  正好命中本文「B 的四道坎」里的第 1 条。该片段应视为**意图说明**，不是实现蓝本。
- **在 `task_executions` 上加软删列（`archivedAt`）当作归档**：两头不占优。
  存储上仍是同一块盘、同一张表（= D 的成本），却要把**所有**读面
  （`getExecutions` `task.service.ts:2337`、`getAllExecutions`、`getExecutionStats` `:2664`、
  重试链、报告、执行器维度、artifacts）全部加上 `WHERE archivedAt IS NULL`——
  漏一处的后果是「已归档行重新出现在列表里」，正是本仓反复在修的静默损坏；
  同时全部索引（含 5 条 running 谓词的 partial 索引）都要重新评估。
  **成本接近 B，收益不如 D。**
- **靠 DB 全库备份当归档**：不可行。`BACKUP_RETENTION_DAYS` 缺省 30
  （`.env.example:476`），比执行保留期 90 **更短**；且恢复是整库时间点恢复，
  不是按条件取回某条执行记录的手段。
- **什么都不做、也不记录**：本文的目的就是消灭这个状态——「不知道该不该保留」
  和「已经决定不保留」在运维上后果相同，但在问责上完全不同。

---

## 关联

- 计划项：`docs/archive/plans/backend-architecture.md` §2.2「执行记录归档」（`:171-199` 原设计、`:634-644` 状态）
- 相关实现：
  - `apps/admin-api/src/modules/executor/executor.service.ts:4693-4754`（Q7 主链）
  - `apps/admin-api/src/common/utils/capped-batched-delete.util.ts:24-87`（轮数/墙钟双闸）
  - `apps/admin-api/src/modules/task/log-retention/log-retention-cleanup.service.ts:22,302`（日志保留，代码缺省 30 天）
  - `apps/admin-api/src/modules/task/log-retention/s3-log-object-retention.service.ts:16,113`（S3 对象回收，03:35）
  - `apps/admin-api/src/modules/executor/executor.service.ts:4806-4813`（fail-open 语义）
- 相关文档：`.env.example:371-376`、`docs/deployment.md:94`、`docs/operations.md:778-789`
- 相关 ADR：ADR-009（S3 日志驱动的跨存储一致性边界——本文「S3 指针归属」一节的判据来源）
