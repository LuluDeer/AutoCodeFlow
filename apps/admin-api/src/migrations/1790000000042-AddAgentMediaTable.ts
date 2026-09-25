import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * P7b（agent-and-deployment）：执行器 Agent 媒体回传登记表。
 *
 * 截图/录屏的**元数据**行（字节落本地盘 uploads/agent-media/，与 artifacts
 * 同款根模式）。归属是 sop_assignments（指派工单）而非 task_execution——
 * artifacts 表的 verifyUploadAuth 强绑执行行，Agent 媒体塞过去要造假
 * execId 或开特例，独立小表是干净解。保留策略 30 天（澄清证据档，与
 * agent_steps 同档）。
 *
 * 新增表 + IF NOT EXISTS 幂等；down 逆序 DROP。
 */
export class AddAgentMediaTable1790000000042 implements MigrationInterface {
  name = "AddAgentMediaTable1790000000042";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "agent_media" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "assignmentId" uuid NOT NULL,
        "name" character varying(255) NOT NULL,
        "mime" character varying(128),
        "sizeBytes" integer NOT NULL,
        "storedPath" character varying(512) NOT NULL,
        "uploadedBy" character varying(128) NOT NULL,
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_agent_media" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_agent_media_assignmentId"
        ON "agent_media" ("assignmentId")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_agent_media_assignmentId"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "agent_media"`);
  }
}
