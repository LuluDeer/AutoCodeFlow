import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * G4（OSS 对照审计）：给 `agent_sessions` 加发起人列。
 *
 * 为什么需要：四眼原则（不能自己批自己）在审批链路上**无数据可判**——
 * `agent_sessions` 没有 creator 列，`decide()` 只能校验「审批单属于该会话」，
 * 同一个管理员发起会话再点批准，闭环成立。本列是这条策略的数据基础。
 *
 * 形态：`varchar(64) NULL`（存量行 NULL = 未知，不做回填；NULL 时按「不可判定」
 * 处理并 warn，策略开关默认关闭以免单人部署被卡死）。加**可空列**是
 * metadata-only（PG 11+ 不重写表、不长时间持锁），无需 CONCURRENTLY。
 */
export class AddAgentSessionCreatedBy1790000000078 implements MigrationInterface {
  name = "AddAgentSessionCreatedBy1790000000078";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "agent_sessions" ADD COLUMN IF NOT EXISTS "createdBy" varchar(64)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "agent_sessions" DROP COLUMN IF EXISTS "createdBy"`,
    );
  }
}
