import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * WIKI-AUTH-REVOC（访问令牌即时撤销）：users 加 sessionVersion 列
 * （INTEGER NOT NULL DEFAULT 0，用户级会话版本）。
 *
 * 背景（repo-wiki page-16 评审结论）：access JWT 在有效期内此前无法撤销——
 * logout 只吊销 refresh token，在途 access token 仍能活到自然过期
 * （JWT_EXPIRES_IN 默认 15m）。引入会话版本后：
 * - 签发侧：auth.service.generateTokens 把 sessionVersion 快照进 token 的
 *   ver claim（登录 / TOTP 二阶段 / refresh 同一单点）；
 * - 校验侧：jwt.strategy.validate() 每请求本就 findById 加载用户（并检查
 *   isActive），顺手比对 ver 与库中 sessionVersion——近零增量查询成本；
 * - bump 点：logout（auth.service.revokeAllForUser）与改密
 *   （users.service.update 携带 password 时，含自改与管理员重置），均为
 *   原子自增（无读改写，防竞态）。
 *
 * NOT NULL DEFAULT 0：存量行一次性取 0。部署前签发的旧令牌无 ver claim，
 * 校验侧按「无 ver = 存量兼容放行（到期自然失效）」处理，零破坏升级。
 *
 * 不在本迁移范围：管理员停用（isActive=false）已有 isActive 校验兜底、
 * TOTP 变更、单会话级联撤销（刷新令牌族）。
 *
 * 幂等：IF [NOT] EXISTS 写法，重复执行与 revert 重放均无副作用。
 */
export class AddUserSessionVersion1790000000017 implements MigrationInterface {
  name = "AddUserSessionVersion1790000000017";

  public async up(queryRunner: QueryRunner): Promise<void> {
    // PG 支持单条语句同用 IF NOT EXISTS + NOT NULL DEFAULT：列已存在时整句
    // 跳过，不存在时存量行直接以 DEFAULT 0 填充（常量默认无表重写）。
    await queryRunner.query(`
      ALTER TABLE "users"
      ADD COLUMN IF NOT EXISTS "sessionVersion" INTEGER NOT NULL DEFAULT 0
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "users" DROP COLUMN IF EXISTS "sessionVersion"
    `);
  }
}
