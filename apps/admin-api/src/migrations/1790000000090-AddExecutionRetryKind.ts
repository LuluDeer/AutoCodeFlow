import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * RT-BUDGET-01：重试**双预算**的落库面（用户预算 vs 引擎内部预算分离）。
 *
 * ## 为什么需要这两列
 *
 * 改动前 `task.maxRetry` 是**一个**预算：`ExecutorService.retryBudgetExhausted`
 * 只看 `task_executions.retryCount`（总重试数），于是
 *   · 用户代码/配置的真失败，与
 *   · 引擎内部抖动（网络抖动、执行器重启、stale sweep 回收僵尸行）
 * 共用同一格额度 ⇒ **一次抖动就烧掉用户一格重试额度**，且用户看到的失败原因
 * 与实际不符。Hatchet 把 `app_retry_count`（用户代码失败）与
 * `internal_retry_count`（引擎内部抖动）分成**两个独立计数器**
 * （`sql/schema/v1-core.sql:538-540`；`pkg/repository/sqlcv1/tasks.sql:591`），
 * 本迁移落同一分离。
 *
 * ## 列语义
 *
 * | 列 | 含义 | NULL 语义 |
 * |---|---|---|
 * | `retryKind` | **本行为什么被重试**：`user` / `internal` | 未知（存量行/非重试行）——**不回填**，不假装知道 |
 * | `retryUserCount` | 本行之前**已由用户类**消耗的重试次数 | 未知——读侧按「全部已用」保守处理 |
 *
 * 为什么只加一列计数器：每条重试恰属一类，故
 * `internal 已用 = retryCount − retryUserCount`（≥0 截断）。`retryCount` 本身
 * （总数，供 attempts 扣减/退避指数/读面展示）语义**不变**——这是「存量行为
 * 逐字节等价」的前提，故刻意不加第三列、也不改它的含义。
 *
 * ## 为什么刻意不回填
 *
 * 历史行没有留下「这次重试是谁造成的」的证据（`triggerType` 记的是**原始触发**
 * 方式，不是失败成因，sweep 重试行照样带 `cron`/`manual`）。用推断填值等于
 * 把猜测当事实写进库：读侧会**多给**重试（多给 = 静默多跑一次副作用），
 * 比少给贵。NULL 在读写两侧都按「与迁移前同一口径」处理：
 * 两类预算都被看作已用满 `retryCount` 格 ⇒ 存量行的准入判定与迁移前逐字节相同。
 *
 * ## DDL 性质
 *
 * 两列均可空且无 DEFAULT ⇒ PG 11+ 的 `ADD COLUMN` 是 **metadata-only**（不重写
 * 表、只改 catalog），可在大表上直接执行。幂等：`IF NOT EXISTS`，up/down 可重放。
 */
export class AddExecutionRetryKind1790000000090 implements MigrationInterface {
  name = "AddExecutionRetryKind1790000000090";

  public async up(queryRunner: QueryRunner): Promise<void> {
    // 本次重试的成因类别（'user' | 'internal'；NULL = 存量/未知）。
    await queryRunner.query(`
      ALTER TABLE "task_executions"
      ADD COLUMN IF NOT EXISTS "retryKind" VARCHAR(16) NULL
    `);
    // 链上已由**用户类**失败消耗的重试次数（internal 已用 = retryCount - 本列）。
    await queryRunner.query(`
      ALTER TABLE "task_executions"
      ADD COLUMN IF NOT EXISTS "retryUserCount" INTEGER NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "task_executions" DROP COLUMN IF EXISTS "retryUserCount"
    `);
    await queryRunner.query(`
      ALTER TABLE "task_executions" DROP COLUMN IF EXISTS "retryKind"
    `);
  }
}
