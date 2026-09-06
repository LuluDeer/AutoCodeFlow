import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * 改动2（可观测性补齐）：执行回调 exitCode 入库溯源。
 * CallbackItemDto 早已携带可选 exitCode 并参与 inferFailureReason 推断，但
 * TaskExecution 无对应列，终态 patch 也不保存——失败排查只剩推断出的
 * failureReason，原始退出码丢失。新增 nullable integer 列（NULL = 执行器
 * 未上报），handleCallback 终态 UPDATE 命中时校验为整数后随 patch 落库。
 * 幂等：IF NOT EXISTS / IF EXISTS，重复执行与 revert 重放均无副作用。
 */
export class AddExecutionExitCode1788800000000 implements MigrationInterface {
  name = "AddExecutionExitCode1788800000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "task_executions"
      ADD COLUMN IF NOT EXISTS "exitCode" INTEGER NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "task_executions" DROP COLUMN IF EXISTS "exitCode"
    `);
  }
}
