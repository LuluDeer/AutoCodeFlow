import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * NF-04（标签亲和/反亲和调度约束，第三态调度面）：tasks 加
 * executorAffinityTags / executorAntiAffinityTags 两个可空 simple-array 列。
 *
 * 语义（拍板记录，与 entity/task.service/executor.service 注释及
 * docs/api-reference.md 同步）：
 * - 亲和 = OR 语义：执行器持有**任一**亲和标签即命中候选（软路由意向，
 *   命中集合内仍由 CORE-05 loadScore 择优）；与 executorTags（硬性能力
 *   要求，AND 子集语义）正交，两者可同配。
 * - 反亲和 = 排除语义：执行器持有**任一**反亲和标签即被排除；单发与
 *   broadcast 均生效。
 * - 组合：先取亲和命中集再剔除反亲和命中（交集）；无亲和时反亲和独立生效。
 * - broadcast + 亲和 = 广播收窄为「命中亲和标签的执行器子集」（broadcast
 *   本为全体在线执行器，亲和是第三态价值）；broadcast + 反亲和照常剔除。
 * - 两列均 NULL/[] = 无约束，默认行为零变化（不过滤、不走新分支）。
 * - 候选过滤后为空：走既有「无可用执行器」抛错路径（dispatch 单发抛
 *   "No online executors match..."，broadcast 抛 "No online executors
 *   match..." / "No available executor for broadcast dispatch"），不发明
 *   新失败状态——processor 既有分类器将其归 EXECUTOR_OFFLINE。
 * - 存储风格与 executorTags 对齐（TypeORM simple-array ⇔ PG TEXT，见
 *   1717473142684 首建 "executorTags" TEXT 的先例）。
 *
 * down 对称 DROP COLUMN。无回填：存量行 NULL = 无约束。
 */
export class AddTaskAffinityConstraints1790000000011 implements MigrationInterface {
  name = "AddTaskAffinityConstraints1790000000011";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "tasks"
      ADD COLUMN IF NOT EXISTS "executorAffinityTags" text NULL
    `);
    await queryRunner.query(`
      ALTER TABLE "tasks"
      ADD COLUMN IF NOT EXISTS "executorAntiAffinityTags" text NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "tasks"
      DROP COLUMN IF EXISTS "executorAffinityTags"
    `);
    await queryRunner.query(`
      ALTER TABLE "tasks"
      DROP COLUMN IF EXISTS "executorAntiAffinityTags"
    `);
  }
}
