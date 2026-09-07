import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * CORE-04: 超时策略分级。tasks 新增两列：
 *   - timeoutAction varchar(16)：超时后动作，值域 kill / kill_retry /
 *     notify_only，null = 缺省 kill（与既有单级树杀行为一致，存量任务
 *     行为零变化）。
 *   - timeoutWarnRatio int：超时预警阈值（占 timeout 的百分数 0-90），
 *     null = 未启用预警。执行运行时长达到 timeout×ratio 时发一次
 *     WARNING 通知（每执行至多一次，processor 持 warned 标记去重）。
 * 两列均可空、无默认值——未配置的任务行为零变化。
 * 幂等：IF NOT EXISTS / IF EXISTS，重复执行与 revert 重放均无副作用。
 */
export class AddTaskTimeoutPolicy1789500000000 implements MigrationInterface {
  name = "AddTaskTimeoutPolicy1789500000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "tasks"
      ADD COLUMN IF NOT EXISTS "timeoutAction" VARCHAR(16)
    `);
    await queryRunner.query(`
      ALTER TABLE "tasks"
      ADD COLUMN IF NOT EXISTS "timeoutWarnRatio" integer
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "tasks"
      DROP COLUMN IF EXISTS "timeoutWarnRatio"
    `);
    await queryRunner.query(`
      ALTER TABLE "tasks"
      DROP COLUMN IF EXISTS "timeoutAction"
    `);
  }
}
