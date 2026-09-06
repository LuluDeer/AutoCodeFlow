import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * FEAT-06: 任务级维护窗口。tasks 新增可空 jsonb 列 maintenanceWindows：
 *   [{ start: "30 2 * * *", end: "0 4 * * *", description?: string }]
 * 调度计划触发（cron/fixed_rate/misfire 等 enqueue 路径）命中窗口即跳过，
 * 手动/API 触发不受限。列可空、无默认值——未配置窗口的任务行为零变化。
 * 幂等：IF NOT EXISTS / IF EXISTS，重复执行与 revert 重放均无副作用。
 */
export class AddTaskMaintenanceWindows1789200000000 implements MigrationInterface {
  name = "AddTaskMaintenanceWindows1789200000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "tasks"
      ADD COLUMN IF NOT EXISTS "maintenanceWindows" JSONB
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "tasks"
      DROP COLUMN IF EXISTS "maintenanceWindows"
    `);
  }
}
