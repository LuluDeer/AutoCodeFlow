import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * SEC-03: users TOTP 两步验证列 + refresh_tokens 会话元数据列。
 *
 * ① users.totpSecret（nullable varchar）——Base32 编码的 TOTP 密钥；
 *    totpEnabled=false 时该列可为「暂存未启用态」（setup 后 enable 前）。
 * ② users.totpEnabled（boolean default false）——用户级 opt-in 开关；
 *    未启用用户登录路径零变化（backward 兼容承诺）。
 * ③ refresh_tokens.userAgent / refresh_tokens.ip——会话管理列表展示
 *    （设备/时间/IP），签发时写入（无则 null）。纯增量列，零破坏。
 *
 * 幂等：IF NOT EXISTS / IF EXISTS，重复执行与 revert 重放均无副作用。
 * 时间戳 1789800000001 为 002/SEC-03 声明占用（避让 004/CORE-03 的
 * 1789800000000，见 docs/PLAN-CLAIMS.md 变更日志）。
 */
export class AddUserTotpAndSessionMeta1789800000001
  implements MigrationInterface
{
  name = "AddUserTotpAndSessionMeta1789800000001";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "users"
      ADD COLUMN IF NOT EXISTS "totpSecret" VARCHAR NULL
    `);
    await queryRunner.query(`
      ALTER TABLE "users"
      ADD COLUMN IF NOT EXISTS "totpEnabled" BOOLEAN NOT NULL DEFAULT false
    `);
    await queryRunner.query(`
      ALTER TABLE "refresh_tokens"
      ADD COLUMN IF NOT EXISTS "userAgent" VARCHAR NULL
    `);
    await queryRunner.query(`
      ALTER TABLE "refresh_tokens"
      ADD COLUMN IF NOT EXISTS "ip" VARCHAR NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "refresh_tokens" DROP COLUMN IF EXISTS "ip"
    `);
    await queryRunner.query(`
      ALTER TABLE "refresh_tokens" DROP COLUMN IF EXISTS "userAgent"
    `);
    await queryRunner.query(`
      ALTER TABLE "users" DROP COLUMN IF EXISTS "totpEnabled"
    `);
    await queryRunner.query(`
      ALTER TABLE "users" DROP COLUMN IF EXISTS "totpSecret"
    `);
  }
}
