import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * FEAT-22 方案 A v2：任务级部署约束模式（tasks.deploymentPolicy 列）。
 *
 * 语义：'strict' | 'prefer' | NULL。NULL = 跟随全局 executor.deploymentPolicy
 * （EXECUTOR_DEPLOYMENT_POLICY，v1 引入）——存量行全部为 NULL，升级后行为
 * 零变化。strict = 任务关联应用的部署设备集合成为派发硬约束（集合不可用
 * → WAITING 排队不换机）；prefer = ARCH-35 软偏好（可让单个任务退出全局
 * strict）。优先级链与 master 开关的关系见 task.entity.ts 字段注释。
 *
 * 有意用 varchar 而非 PG enum：与 DeploymentStatus 的字符串复述纪律一致，
 * 且值域极小（2 值）+ DTO @IsIn 校验兜底，enum 类型迁移成本不成比例。
 *
 * 幂等：IF NOT EXISTS，重复执行与 revert 重放均无副作用。
 */
export class AddTaskDeploymentPolicy1790000000047 implements MigrationInterface {
  name = "AddTaskDeploymentPolicy1790000000047";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "tasks"
      ADD COLUMN IF NOT EXISTS "deploymentPolicy" VARCHAR NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "tasks" DROP COLUMN IF EXISTS "deploymentPolicy"
    `);
  }
}
