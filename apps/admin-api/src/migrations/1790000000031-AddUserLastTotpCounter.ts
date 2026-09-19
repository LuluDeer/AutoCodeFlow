import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * NETOPT-5⑤（TOTP 重放防护）：users 加 lastTotpCounter 列
 * （INTEGER NULL——不设默认，NULL = 尚未消费过任何 counter）。
 *
 * 背景：totpVerify 允许 ±1 步（±30s）时钟漂移并返回命中 counter，但该
 * counter 此前全仓零消费——同一个 6 位码在约 90s 窗口内可反复通过第二因子
 * （嗅探/肩窥/日志泄露的码可重放登录）。引入列后，totpVerifyLogin 在
 * totpVerify 命中后执行原子条件 UPDATE：
 *   SET lastTotpCounter = :matched
 *   WHERE id = :userId AND (lastTotpCounter IS NULL OR lastTotpCounter < :matched)
 * affected=0 → 该 counter 已被使用（重放）或并发占位失败，按无效码拒绝。
 * 单调递增语义（HOTP 计数器模型），无读改写、天然并发安全。
 *
 * NULL 语义：列可空是有意的——无 TOTP 用户（totpEnabled=false）的行保持
 * NULL，不受影响；存量 TOTP 用户在下次登录时自然从 NULL 起步（首次校验
 * 即占位，该码此前是否用过无从考证，可接受的漂移）。
 *
 * 不在本迁移范围：totpEnable（一次性启用，totpEnabled 标志守门）与
 * totpDisable（已登录会话内操作）不消费 counter，理由见 auth.service 注释。
 *
 * 幂等：IF [NOT] EXISTS 写法，重复执行与 revert 重放均无副作用。
 */
export class AddUserLastTotpCounter1790000000031 implements MigrationInterface {
  name = "AddUserLastTotpCounter1790000000031";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "users"
      ADD COLUMN IF NOT EXISTS "lastTotpCounter" INTEGER
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "users" DROP COLUMN IF EXISTS "lastTotpCounter"
    `);
  }
}
