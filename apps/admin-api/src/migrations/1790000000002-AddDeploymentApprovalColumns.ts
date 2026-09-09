import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * DEP-04: app_deployments 部署审批流状态列。
 *
 * - approvalStatus（nullable varchar）：该部署行的审批推进状态，
 *   pending_approval（deploy() 在应用开启审批流时创建，等待审批人处置）/
 *   approved（审批通过，行已转入正常推送链，永久痕迹）/ rejected（审批拒绝，
 *   终态）/ cancelled（提交者主动撤销，终态）。NULL = 非审批路径（既有
 *   deploy/upgrade/webhook 升级行为与数据零变化）。
 * - approvalMeta（nullable jsonb）：审批痕迹 { requestedBy, requestedByName,
 *   requestedAt, actedBy?, actedByName?, actedAt?, reason? }。第二人规则
 *   （审批者 ≠ 提交者）在服务层校验，本列提供持久化证据。
 *
 * 待审批行复用 status='pending' 表达（不新增 DeploymentStatus 枚举值），
 * 因此天然被部分唯一索引 uq_app_deployments_application_in_flight
 * （WHERE status IN ('pending','deploying')，迁移 1789000000000）约束：
 * 「同一应用至多一个在途部署（含待审批）」在 DB 层闭环，本迁移零索引改动。
 *
 * 幂等：IF NOT EXISTS，重复执行与 revert 重放均无副作用。
 */
export class AddDeploymentApprovalColumns1790000000002 implements MigrationInterface {
  name = "AddDeploymentApprovalColumns1790000000002";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "app_deployments"
      ADD COLUMN IF NOT EXISTS "approvalStatus" VARCHAR(32) NULL
    `);
    await queryRunner.query(`
      ALTER TABLE "app_deployments"
      ADD COLUMN IF NOT EXISTS "approvalMeta" JSONB NULL
    `);
    // DEP-04: 应用级审批开关（存量行 false=关闭，行为零变化）。
    await queryRunner.query(`
      ALTER TABLE "applications"
      ADD COLUMN IF NOT EXISTS "approvalRequired" BOOLEAN NOT NULL DEFAULT false
    `);
    // 审批待办高频读（approvalStatus=pending_approval 扫描）——部分索引。
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_app_deployments_approval_pending"
      ON "app_deployments" ("applicationId")
      WHERE "approvalStatus" = 'pending_approval'
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DROP INDEX IF EXISTS "idx_app_deployments_approval_pending"
    `);
    await queryRunner.query(`
      ALTER TABLE "applications" DROP COLUMN IF EXISTS "approvalRequired"
    `);
    await queryRunner.query(`
      ALTER TABLE "app_deployments" DROP COLUMN IF EXISTS "approvalMeta"
    `);
    await queryRunner.query(`
      ALTER TABLE "app_deployments" DROP COLUMN IF EXISTS "approvalStatus"
    `);
  }
}
