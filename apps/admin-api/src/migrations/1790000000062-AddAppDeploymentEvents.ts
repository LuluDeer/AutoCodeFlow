import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * R4（部署模型评审 2026-10-23 §4.1 方案 A）：不可变部署事件表
 * app_deployment_events（append-only，纯旁路记录）。
 *
 * - 每个部署域写动作（deploy 新建/复用、审批三动作、upgrade、stop、remove、
 *   卡死扫死）落一行短事实快照，补齐「行复用原地覆盖」模型下丢失的动作追溯；
 * - deploymentId 不带外键：removeDeployment 删行后事件必须存活（事件是历史，
 *   部署行是现状）；
 * - 索引：(applicationId, createdAt) 供 /events 时间序读面与 legacy 判定，
 *   (applicationId, eventType) 供按动作类型聚合（deployCount 的 GROUP BY）。
 *
 * 幂等：IF NOT EXISTS，重复执行与 revert 重放均无副作用。新表无存量回填——
 * 存量应用的 deployCount 读面走「无事件 → findAllByApp 回退」（见
 * buildDeployCountMap 注释）。
 */
export class AddAppDeploymentEvents1790000000062 implements MigrationInterface {
  name = "AddAppDeploymentEvents1790000000062";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "app_deployment_events" (
        "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "applicationId" UUID NOT NULL,
        "deploymentId" UUID,
        "executorId" VARCHAR,
        "executorAddress" VARCHAR,
        "eventType" VARCHAR NOT NULL,
        "deployedVersion" VARCHAR,
        "triggerType" VARCHAR,
        "operator" VARCHAR,
        "detail" JSONB,
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "FK_app_deployment_events_applicationId"
          FOREIGN KEY ("applicationId") REFERENCES "applications"("id") ON DELETE CASCADE
      )
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_app_deployment_events_application_created"
      ON "app_deployment_events" ("applicationId", "createdAt")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_app_deployment_events_application_type"
      ON "app_deployment_events" ("applicationId", "eventType")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DROP INDEX IF EXISTS "idx_app_deployment_events_application_type"
    `);
    await queryRunner.query(`
      DROP INDEX IF EXISTS "idx_app_deployment_events_application_created"
    `);
    await queryRunner.query(`
      DROP TABLE IF EXISTS "app_deployment_events"
    `);
  }
}
