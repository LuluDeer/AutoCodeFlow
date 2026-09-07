import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * FEAT-11: 任务运行手册（runbook）。tasks 新增可空 text 列 runbook：
 * 排障知识（markdown），失败通知/详情页展示并随 OBS-02 告警外发链接。
 * 列可空、无默认值——未配置 runbook 的任务行为零变化。
 * 幂等：IF NOT EXISTS / IF EXISTS，重复执行与 revert 重放均无副作用。
 */
export class AddTaskRunbook1789400000000 implements MigrationInterface {
  name = "AddTaskRunbook1789400000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "tasks"
      ADD COLUMN IF NOT EXISTS "runbook" text
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "tasks"
      DROP COLUMN IF EXISTS "runbook"
    `);
  }
}
