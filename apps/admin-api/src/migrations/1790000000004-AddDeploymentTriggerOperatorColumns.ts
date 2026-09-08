import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * FEAT-20（DEP-01 遗留收口）：app_deployments 部署触发来源两列。
 *
 * - triggerType（nullable varchar）：本次部署行的触发动作语义——
 *   manual（控制台 deploy）/ upgrade（升级：upgrade、upgrade-all、webhook
 *   触发的滚动升级）/ rollback（回退链）/ approval（审批通过后的派发）。
 *   NULL = 存量行与机器路径（心跳等）未标注，前端已兼容。
 * - operator（nullable varchar）：触发该部署行的操作人用户名（JWT
 *   user.username）。NULL 同上。
 *
 * 两列一经写入不随后续状态迁移覆盖（approve 接力时写 approval，其余
 * 动作各自写一次），读面 GET /app-deployments 与 /applications/:id/releases
 * 聚合行透出，替代 DEP-01 的「缺失占位」标注。
 *
 * 幂等：IF NOT EXISTS，重复执行与 revert 重放均无副作用。
 */
export class AddDeploymentTriggerOperatorColumns1790000000004 implements MigrationInterface {
  name = "AddDeploymentTriggerOperatorColumns1790000000004";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "app_deployments"
      ADD COLUMN IF NOT EXISTS "triggerType" VARCHAR(32) NULL
    `);
    await queryRunner.query(`
      ALTER TABLE "app_deployments"
      ADD COLUMN IF NOT EXISTS "operator" VARCHAR(100) NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "app_deployments" DROP COLUMN IF EXISTS "operator"
    `);
    await queryRunner.query(`
      ALTER TABLE "app_deployments" DROP COLUMN IF EXISTS "triggerType"
    `);
  }
}
