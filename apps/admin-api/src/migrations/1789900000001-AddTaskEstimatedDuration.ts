import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * CORE-05: tasks.estimatedDurationSec（nullable int）——任务预估执行时长
 * （秒）。0/NULL = 未知。仅参与调度侧执行器负载评分（ExecutorService 的
 * loadScore 加权，长任务预估占用给 busy 执行器更重惩罚）；执行链路
 * （心跳/超时/统计）不消费该字段。可空列零破坏：存量行读为 NULL，评分
 * 按「未知时长」默认项处理，行为与既有实现一致。
 * 幂等：IF NOT EXISTS / IF EXISTS，重复执行与 revert 重放均无副作用。
 */
export class AddTaskEstimatedDuration1789900000001
  implements MigrationInterface
{
  name = "AddTaskEstimatedDuration1789900000001";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "tasks"
      ADD COLUMN IF NOT EXISTS "estimatedDurationSec" INTEGER NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "tasks" DROP COLUMN IF EXISTS "estimatedDurationSec"
    `);
  }
}
