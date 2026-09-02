import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * DB-001: tasks 表软删除列。
 *
 * 与现有 status='deleted' 逻辑删除并存：
 * - 应用层继续用 status='deleted' 作为业务标记（findAll/findOne 的 Not(DELETED) 不变）；
 * - deletedAt 由 @DeleteDateColumn 使用，Repository find/findOne 默认自动排除软删行；
 * - 原生 SQL / raw QueryBuilder 不会自动排除软删行，调用方需自行过滤。
 *
 * FK 引用行为说明：task_executions.taskId 对 tasks 的外键为 ON DELETE SET NULL
 * （见 1717473142679-TaskExecutionForeignKey），软删除只是 UPDATE，不触发行删除，
 * 因此不会影响任何引用 tasks.id 的外键。
 */
export class AddTaskSoftDelete1717473142700 implements MigrationInterface {
  name = "AddTaskSoftDelete1717473142700";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "deletedAt" TIMESTAMP NULL`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_tasks_deleted_at" ON "tasks" ("deletedAt")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_tasks_deleted_at"`);
    await queryRunner.query(
      `ALTER TABLE "tasks" DROP COLUMN IF EXISTS "deletedAt"`,
    );
  }
}
