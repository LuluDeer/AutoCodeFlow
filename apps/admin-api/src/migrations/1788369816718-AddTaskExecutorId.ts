import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * R6: 任务级 executor pinning——tasks.executorId（nullable）。
 * 设置后调度仅派给该执行器；无 FK 约束（执行器记录可被管理员硬删，
 * 删除不应阻塞或被 pin 引用级联），语义详见 task.entity.ts 注释。
 * 幂等：IF NOT EXISTS / IF EXISTS，重复执行与 revert 重放均无副作用。
 */
export class AddTaskExecutorId1788369816718 implements MigrationInterface {
  name = "AddTaskExecutorId1788369816718";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "tasks"
      ADD COLUMN IF NOT EXISTS "executorId" VARCHAR NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "tasks" DROP COLUMN IF EXISTS "executorId"
    `);
  }
}
