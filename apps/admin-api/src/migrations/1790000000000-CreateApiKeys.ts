import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * AUTH-03: api_keys 表（限权 API Key，CI/CD 机器对机器认证）。
 *
 * 列设计：
 * - userId：归属创建人（管理端点仅本人 JWT 可见/可操作）；
 * - name/keyPrefix/keyHash：展示名 / 前 8 位明文前缀（识别用） /
 *   sha256(明文) 唯一索引（认证查找）；明文仅在创建响应回显一次；
 * - scope：readonly | trigger | manage（默认 readonly，最小权限）；
 * - expiresAt/revokedAt：过期与吊销（软删，吊销立即 401 且审计可溯）；
 * - lastUsedAt：最后使用时间（guard 侧节流 ≤1 写/分钟/键，防写放大）。
 *
 * 幂等：CREATE TABLE IF NOT EXISTS / ALTER ... IF NOT EXISTS /
 * DROP TABLE IF EXISTS，重复执行与 revert 重放均无副作用。
 * 时间戳 1790000000000 为 002/AUTH-03 声明占用
 * （此前最高 1789900000003=OBS-01，见 docs/PLAN-CLAIMS.md 变更日志）。
 */
export class CreateApiKeys1790000000000 implements MigrationInterface {
  name = "CreateApiKeys1790000000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "api_keys" (
        "id" SERIAL PRIMARY KEY,
        "userId" INTEGER NOT NULL,
        "name" VARCHAR(100) NOT NULL,
        "keyPrefix" VARCHAR(16) NOT NULL,
        "keyHash" VARCHAR(64) NOT NULL,
        "scope" VARCHAR(16) NOT NULL DEFAULT 'readonly',
        "expiresAt" TIMESTAMPTZ NULL,
        "revokedAt" TIMESTAMPTZ NULL,
        "lastUsedAt" TIMESTAMPTZ NULL,
        "createdAt" TIMESTAMP NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "idx_api_keys_key_hash"
      ON "api_keys" ("keyHash")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_api_keys_user_id"
      ON "api_keys" ("userId")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DROP INDEX IF EXISTS "idx_api_keys_user_id"
    `);
    await queryRunner.query(`
      DROP INDEX IF EXISTS "idx_api_keys_key_hash"
    `);
    await queryRunner.query(`
      DROP TABLE IF EXISTS "api_keys"
    `);
  }
}
