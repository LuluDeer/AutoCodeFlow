import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * G6（OSS 对照审计）第一步：失败边——`tasks.runOnUpstreamFailure`。
 *
 * 现状：依赖扇出只在上游 SUCCESS 时触发，失败/超时/取消不触发任何下游，
 * 包括「失败补偿/清理」这种最常见的需要。审计建议按边声明 `on: [success|
 * failure|always]`；本列是**任务级**粗粒度版本（零迁移风险的最小可用面）：
 * 标了该位的任务，在任一上游依赖进入失败终态时也会被扇出触发，
 * 其依赖闸门同时接受「上游最新执行是失败终态」。
 *
 * 为什么不改 dependencies 的 value 形态：`idx_tasks_dependencies_values_gin`
 * 建在 `jsonb_path_query_array(dependencies,'$.keyvalue().value')` 上，
 * value 从 string 变 object 会让该表达式索引的谓词失配（B-3 优化被悄悄
 * 回退）。任务级布尔列不触碰该索引。
 *
 * 形态：boolean NOT NULL DEFAULT false，metadata-only（PG 11+ 不重写表）。
 */
export class AddTaskRunOnUpstreamFailure1790000000079 implements MigrationInterface {
  name = "AddTaskRunOnUpstreamFailure1790000000079";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "runOnUpstreamFailure" boolean NOT NULL DEFAULT false`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "tasks" DROP COLUMN IF EXISTS "runOnUpstreamFailure"`,
    );
  }
}
