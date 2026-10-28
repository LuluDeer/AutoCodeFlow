import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * 视频转 SOP（交互式，2026-10-28）：建 `ai_sop_sessions`。
 *
 * 会话必须落库：每轮都要重发「全部视频 + 完整历史」，刷新/换设备能续跑才
 * 不必重问一遍（每重问一轮就是一次全量视频推理）。`questionsAsked` 也落库，
 * 否则续跑会把提问预算清零、无限追问。
 *
 * down：DROP TABLE（新表）。
 */
export class CreateAiSopSessions1790000000071 implements MigrationInterface {
  name = "CreateAiSopSessions1790000000071";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "ai_sop_sessions" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "status" character varying(16) NOT NULL DEFAULT 'active',
        "messagesJson" jsonb,
        "mediaJson" jsonb,
        "draftJson" jsonb,
        "provider" character varying(64),
        "questionsAsked" integer NOT NULL DEFAULT 0,
        "createdBy" character varying(128) NOT NULL,
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_ai_sop_sessions_id" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_ai_sop_sessions_createdAt"
        ON "ai_sop_sessions" ("createdAt")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "ai_sop_sessions"`);
  }
}
