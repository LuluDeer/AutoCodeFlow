import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * ADR-017 阶段 3（配套）：`task_executions` 增 `executorId` —— 执行行的**行身份**。
 *
 * ## 为什么必须加这一列
 *
 * 阶段 3 把 `uq_executors_address` 收窄为 partial（仅 push 行），pull 模式
 * **允许同地址多行并存**（ADR-017 §5：两家不同内网同网段同 IP）。此前
 * `task_executions.executorAddress` 是「派发到哪台机器」的唯一记录，现在它
 * **不再唯一指代一行**——所有按地址匹配执行行的面都会命中别人的行：
 *
 * 1. **重启恢复误杀**（最严重）：`failRunningExecutionsAfterRestart` 按
 *    `executorAddress + RUNNING` 批量终态化。A 机器重启会把 **B 机器正在跑的
 *    健康执行**判成 `EXECUTOR_RESTART` 并重新入队 —— 正是
 *    `executor-address-conflict.util.ts` 头注列为「三类静默故障」之一的形态，
 *    而 partial 索引恰好把这个状态合法化了。
 * 2. **互斥占用算错**：MUTEX-01 的组占用账本按 `executorAddress + mutexGroupId`
 *    计数，两台共享地址会互相把对方的执行数进自己的组占用。
 * 3. **产物/统计归属串台**：`getExecutorExecutions` / `getTerminalStates` /
 *    7 日 metrics / `estimatedDurationsByExecutor` 等按地址聚合的读面。
 * 4. **回调地址闸门失效**：`task.service.handleCallback` 的
 *    `cb.executorAddress !== execution.executorAddress` 恒等（两台自报同一地址），
 *    拦不住串台。
 *
 * ## 可空是刻意的（兼容性红线）
 *
 * 存量执行行（本迁移前派发的）没有该值。**不回填**是刻意的：
 * 回填需要一个「地址 → 行」的映射，而正是这个映射在 pull 同址多行下**有歧义**
 * ——猜错行等于把历史执行挂到错误的机器上，比留 NULL（回落地址匹配、与引入前
 * 逐字节一致）更糟。故存量行为 NULL，配套代码在 NULL 时回落 `executorAddress`
 * 匹配（见 `failRunningExecutionsAfterRestart` 的 `IsNull()` 谓词）。
 *
 * ## 不加外键
 *
 * 执行器行会被 `cleanupOfflineExecutors` 删除，而执行历史**必须保留**（删行会
 * 让历史断裂——正是本 ADR 要消灭的故障）。故以裸 uuid 存**快照语义**：它记录
 * 「当时派发到哪一行」，不随执行器行删除而失效。
 *
 * ## 索引
 *
 * 部分索引 `(executorId, startTime) WHERE status='running'`：重启恢复的查询形态
 * 是 `executorId = $1 AND status='running' ORDER BY startTime`（take 10000），
 * 与既有 `idx_task_executions_running`（按 address）同款，避免每次重启扫全表。
 * 部分谓词把索引只覆盖真正参与恢复的行；`CREATE INDEX CONCURRENTLY`
 * （`transaction = false`）对齐 1790000000049/0053 的大表纪律——task_executions
 * 是仓库最高频写入的表，普通 CREATE INDEX 会持写锁阻塞派发。
 */
export class AddTaskExecutionsExecutorId1790000000055 implements MigrationInterface {
  name = "AddTaskExecutionsExecutorId1790000000055";

  // 大表 DDL：CONCURRENTLY 不能在事务块内执行。
  transaction = false as const;

  public async up(queryRunner: QueryRunner): Promise<void> {
    // 连接池对每条语句设 statement_timeout=30s；CONCURRENTLY 是**单条**
    // 语句，大表构建可能超过 30s。本迁移 transaction=false，SET LOCAL
    // 没有事务块会退化成警告 + 无效（对照 0037 的写法不可照抄）——因此
    // 用会话级 SET 并在 finally 复位（连接会归还池，污染会波及后续查询）。
    // 超时的后果不是"重跑即可"：PG 会留下 indisvalid=false 的同名索引，
    // IF NOT EXISTS 会命中它并跳过，索引永远建不起来。
    await queryRunner.query(`SET statement_timeout = 0`);
    try {
    // 1) 加列（可空；存量行不回填，理由见类注释）。
    await queryRunner.query(
      `ALTER TABLE "task_executions" ADD COLUMN IF NOT EXISTS "executorId" uuid NULL`,
    );
    // 2) 重启恢复查询形态的部分索引（幂等 + 不阻塞写入）。
    //    单行字符串是刻意的：`scripts/check-index-drift.mjs` 的 DDL 扫描器按
    //    正则匹配**同一行内**的语句，跨行拼接会让它读不到这条索引并误报漂移。
    await queryRunner.query(
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_task_executions_executor_id_running" ON "task_executions" ("executorId", "startTime") WHERE "status" = 'running'`,
    );
    } finally {
      await queryRunner.query(`RESET statement_timeout`);
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // 逆序回收：先索引后列。
    await queryRunner.query(
      `DROP INDEX CONCURRENTLY IF EXISTS "idx_task_executions_executor_id_running"`,
    );
    await queryRunner.query(
      `ALTER TABLE "task_executions" DROP COLUMN IF EXISTS "executorId"`,
    );
  }
}
