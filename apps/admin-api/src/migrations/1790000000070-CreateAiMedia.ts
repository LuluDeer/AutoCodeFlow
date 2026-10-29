import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * 视频转 SOP（2026-10-28）：建 `ai_media`（中台自建媒体）。
 *
 * 为什么单独一张表而不是复用 `agent_media`：后者是「执行器在某次指派里回传的
 * 截图/录屏」，`assignmentId` 非空、保留期按指派整目录清理、下载面是执行器
 * 认证路由。视频转 SOP 的输入是管理员一次性上传，与指派无关——混用会让两边
 * 的归属与保留期语义互相污染。
 *
 * down：DROP TABLE（新表，无历史数据依赖）。
 */
export class CreateAiMedia1790000000070 implements MigrationInterface {
  name = "CreateAiMedia1790000000070";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "ai_media" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "name" character varying(128) NOT NULL,
        "mime" character varying(128),
        "sizeBytes" integer NOT NULL,
        "storedPath" character varying(512) NOT NULL,
        "uploadedBy" character varying(128) NOT NULL,
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_ai_media_id" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_ai_media_createdAt" ON "ai_media" ("createdAt")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "ai_media"`);
  }
}
