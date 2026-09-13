import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * AUTH-04（OIDC SSO）：users.oidcSub 身份绑定列。
 *
 * 设计要点：
 * - `oidcSub` 存 IdP 的 `sub` 声明（OIDC 规范中用户的稳定唯一标识）——SSO
 *   登录按「sub 精确匹配 → username 声明匹配（首次绑定 sub）」两级定位账号，
 *   避免以可变 email 做身份主键；
 * - 可空 + 唯一索引：本地密码登录用户不受影响（NULL 在 PG 唯一索引下互不
 *   冲突），存量行零回填——不启用 OIDC 的部署行为逐字节不变；
 * - 自动建号（OIDC_AUTO_PROVISION=true）时写入 sub；关闭时仅允许「管理员
 *   预建同名账号 → 首次 SSO 登录绑定 sub」的显式链路。
 *
 * 幂等：列与索引均带 IF NOT EXISTS 守卫，down 完整回滚。
 */
export class AddUsersOidcSub1790000000018 implements MigrationInterface {
  name = "AddUsersOidcSub1790000000018";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "users"
      ADD COLUMN IF NOT EXISTS "oidcSub" varchar(255) NULL
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "uq_users_oidc_sub"
      ON "users" ("oidcSub")
      WHERE "oidcSub" IS NOT NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DROP INDEX IF EXISTS "uq_users_oidc_sub"
    `);
    await queryRunner.query(`
      ALTER TABLE "users" DROP COLUMN IF EXISTS "oidcSub"
    `);
  }
}
