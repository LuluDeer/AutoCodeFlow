import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * N6 / GCO §11.3：IM 身份绑定表 `im_identities`（本轮新增，时间戳在
 * docs/PLAN-CLAIMS.md 的迁移分配表登记 1790000000104）。
 *
 * 列语义见 im-identity.entity.ts 头注。索引：
 * - `uq_im_identities_platform_sender`：(platform, imSenderId) 唯一——一个平台
 *   的一个 sender 只能有一条绑定，并发 upsert 由 DB 唯一键兜底；
 * - `idx_im_identities_platform_user_id`：按绑定 user 查询（后续 adapter 反查）。
 *
 * 幂等：CREATE TABLE / INDEX IF NOT EXISTS；down 逆序 DROP，无 CONCURRENTLY
 * （新表无存量行，遵守 check-migrations.mjs 的 CONCURRENTLY 守卫约定）。
 */
export class CreateImIdentities1790000000104 implements MigrationInterface {
  name = "CreateImIdentities1790000000104";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "im_identities" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "platform" varchar(16) NOT NULL,
        "imSenderId" varchar(128) NOT NULL,
        "platformUserId" int,
        "projectId" varchar,
        "projectRole" varchar(16),
        "verified" boolean NOT NULL DEFAULT false,
        "createdBy" varchar(64),
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        "updatedAt" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "pk_im_identities" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "uq_im_identities_platform_sender"
      ON "im_identities" ("platform", "imSenderId")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_im_identities_platform_user_id"
      ON "im_identities" ("platformUserId")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_im_identities_platform_user_id"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "uq_im_identities_platform_sender"`,
    );
    await queryRunner.query(`DROP TABLE IF EXISTS "im_identities"`);
  }
}
