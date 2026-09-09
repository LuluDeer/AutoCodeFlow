import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * W-21 (windows-findings): 任务级依赖声明——tasks.requirements（jsonb，nullable）。
 * 执行器运行任务前安装：python runtime → per-task uv venv（executor-python）；
 * node runtime → npm 包（executor-node）。仅 entrypoint（打包）任务生效，glue
 * 脚本任务在执行器侧被清零。派发时随 task 实体原样透传到 /api/execute，
 * 故无需改派发逻辑。用 jsonb 而非 simple-array：pip/npm spec 可含逗号
 * （`django>=4,<5`、`pkg[extra]`），simple-array 的逗号编码会破坏它们。
 * 幂等：IF NOT EXISTS / IF EXISTS，重复执行与 revert 重放均无副作用。
 */
export class AddTaskRequirements1788581485026 implements MigrationInterface {
  name = "AddTaskRequirements1788581485026";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "tasks"
      ADD COLUMN IF NOT EXISTS "requirements" jsonb NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "tasks" DROP COLUMN IF EXISTS "requirements"
    `);
  }
}
