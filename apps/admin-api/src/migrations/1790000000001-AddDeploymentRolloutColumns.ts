import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * DEP-02/DEP-03: app_deployments 灰度（canary）发布批次状态列。
 *
 * - rolloutState（nullable varchar）：该部署行在灰度批次中的推进状态，
 *   pending（已触发升级，等待心跳确认）/ probing（心跳已确认，健康探测中）/
 *   promoted（批次提升：探测通过或提升命令已受理）/ failed（批次失败，
 *   未被回滚——含服务重启后批次不可恢复的收尾）/ rolled_back（已触发回退到
 *   上一 release）。NULL = 非批次路径（手动 upgrade / webhook 升级 / 首次
 *   部署），行为与灰度特性引入前一致。
 * - rolloutMeta（nullable jsonb）：批次元数据 { batchId, role, strategy,
 *   percentage, upgradedIds, failureReason?, rolledBackTo? }，批次本体是
 *   进程内状态（最低正确形态），此列提供每行的持久化痕迹与读面展示。
 *
 * 幂等：IF NOT EXISTS，重复执行与 revert 重放均无副作用。
 */
export class AddDeploymentRolloutColumns1790000000001 implements MigrationInterface {
  name = "AddDeploymentRolloutColumns1790000000001";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "app_deployments"
      ADD COLUMN IF NOT EXISTS "rolloutState" VARCHAR(32) NULL
    `);
    await queryRunner.query(`
      ALTER TABLE "app_deployments"
      ADD COLUMN IF NOT EXISTS "rolloutMeta" JSONB NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "app_deployments" DROP COLUMN IF EXISTS "rolloutMeta"
    `);
    await queryRunner.query(`
      ALTER TABLE "app_deployments" DROP COLUMN IF EXISTS "rolloutState"
    `);
  }
}
