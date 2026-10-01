import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * 技术债 A 组（2026-10-01）：回收 task_executions 的冗余两列索引。
 *
 * idx_task_executions_task_id_created_at（("taskId", "createdAt" DESC)，
 * 1717473142683 建）被 AddExecutionTaskCreatedAtIndex1790000000049 建的
 * ("taskId", "createdAt" DESC, "id" DESC) 三列索引**严格左前缀覆盖**——
 * 0049 落地起它对任何查询都不再是唯一最优（计划器一律可走三列索引的
 * 前缀），留着只付写入维护成本。0049 当时的处置是「保守并存、后续单独
 * 迁移 DROP」——本迁移即该后续。
 *
 * 实体核对：task-execution.entity.ts 仅声明三列索引
 * idx_task_executions_task_id_created_at_id，旧两列索引无 @Index 声明，
 * 删除不产生 check-index-drift 漂移。
 *
 * 并发删索引：task_executions 是最高频写入大表，走 DROP INDEX CONCURRENTLY
 * ——PG 硬约束「CONCURRENTLY 不能在事务块内执行」，故声明 transaction =
 * false（同 1790000000049 口径）。IF EXISTS 保证重跑可重入。down 为人工
 * revert 路径（维护窗口执行），恢复两列索引形态（普通 CREATE INDEX）。
 */
export class DropTaskExecutionsTaskIdCreatedAtRedundantIndex1790000000051 implements MigrationInterface {
  name = "DropTaskExecutionsTaskIdCreatedAtRedundantIndex1790000000051";

  /** CONCURRENTLY 不能在事务内执行——本迁移不走外层事务（见类注释） */
  transaction = false;

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DROP INDEX CONCURRENTLY IF EXISTS "idx_task_executions_task_id_created_at"
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // 恢复 1717473142683 的原始形态（两列 DESC）。
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_task_executions_task_id_created_at"
      ON "task_executions" ("taskId", "createdAt" DESC)
    `);
  }
}
