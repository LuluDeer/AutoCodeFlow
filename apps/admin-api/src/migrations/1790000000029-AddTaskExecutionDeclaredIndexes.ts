import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * NETOPT-3①（第二轮深潜）：task_executions 实体声明的索引从未落进迁移。
 *
 * 背景：task-execution.entity.ts 早就 @Index(["status"])、@Index(["taskId","status"])
 * （PK-10 第三次重演——实体声明与迁移 DDL 两张皮）。生产 synchronize=false
 * （data-source.ts），迁移是 schema 唯一来源，于是这两条索引从未存在过。
 * 最痛消费者：
 * - scheduler.service recoverStaleExecutions 的 PENDING 兜底清扫
 *   `where: { status: PENDING, createdAt: LessThan(cutoff) }`——每 2 分钟
 *   一次，无任何可用索引 → O(全表) 游走；
 * - findOne({ taskId, status: RUNNING })（blockStrategy DISCARD / COVER_EARLY
 *   判定）与 metrics getRecentFailures（status=FAILED + createdAt DESC 排序）。
 *
 * 本迁移：
 * - ("taskId", "status")：等值对查询（回调/扇出/阻断策略判定）；
 * - ("status", "createdAt")：PENDING 清扫的等值 + 范围复合、FAILED 最近失败
 *   排序共用一索；同时**替掉**实体上误导性的独立 ["status"] 单列声明
 *   （低基数单列索引本就该避免，消费面已由复合索引左前缀覆盖）；
 * - config_history ("createdAt")：config.service getHistory 无 key 分支按
 *   createdAt DESC 全量历史排序，此前零索引（configKey 分支已有
 *   idx_config_history_configKey[_createdAt]，见迁移 1789000000001）。
 *
 * 命名对齐 1717473142683 / 1790000000022 既有风格
 * （idx_<table>_<col>[_<col>]）。幂等建索引（IF NOT EXISTS），重复执行
 * 与 revert 重放均无副作用。全部为非唯一普通索引，不触碰数据行。
 */
export class AddTaskExecutionDeclaredIndexes1790000000029 implements MigrationInterface {
  name = "AddTaskExecutionDeclaredIndexes1790000000029";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_task_executions_task_id_status"
      ON "task_executions" ("taskId", "status")
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_task_executions_status_created_at"
      ON "task_executions" ("status", "createdAt")
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_config_history_created_at"
      ON "config_history" ("createdAt")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DROP INDEX IF EXISTS "idx_config_history_created_at"
    `);

    await queryRunner.query(`
      DROP INDEX IF EXISTS "idx_task_executions_status_created_at"
    `);

    await queryRunner.query(`
      DROP INDEX IF EXISTS "idx_task_executions_task_id_status"
    `);
  }
}
