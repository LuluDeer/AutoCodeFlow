import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * 切片 D1（机器验收 fail-closed）：SOP 指派工单的**验收维度**落账。
 *
 * 背景（调研结论，行号见 sop.service.ts）：交付回报（completeAssignment）只落
 * 账不做验收判定；spawnVerificationSession 起复核会话，spawn 失败是 fail-open
 * （仅 logger.warn，工单停留 completed，验收状态完全不可见）。本迁移给
 * sop_assignments 加三列，让「验收了吗、谁验的、何时验完」成为行上的事实：
 *
 *   · verification_status varchar(16) NULL——值域 unverified/passed/failed/
 *     unclear。NULL = 迁移前存量行（无验收语义，读面按「无验收」展示，与
 *     引入本列前的行为一致）；unverified = 已进入验收流程但无结论（spawn
 *     成功即置，spawn 失败也置——fail-closed 的可见面）；
 *   · verification_session_id uuid NULL——复核会话锚（失败路径为 NULL）；
 *   · verification_checked_at timestamptz NULL——结论落定时间。
 *
 * 三列都可空、无默认值：不回填存量（历史工单的验收事实无法重构，宁缺毋假）。
 *
 * 幂等：IF [NOT] EXISTS，重复执行与 revert 重放均无副作用。三条独立
 * ALTER TABLE：迁移对称性守卫按「每条 ALTER TABLE 一个 ADD/DROP COLUMN」
 * 抽取，逗号续写的多列形态会漏判后一列（先例 AddExecutionModeSnapshot）。
 */
export class AddSopAssignmentVerification1790000000111 implements MigrationInterface {
  name = "AddSopAssignmentVerification1790000000111";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "sop_assignments"
      ADD COLUMN IF NOT EXISTS "verification_status" VARCHAR(16) NULL
    `);
    await queryRunner.query(`
      ALTER TABLE "sop_assignments"
      ADD COLUMN IF NOT EXISTS "verification_session_id" UUID NULL
    `);
    await queryRunner.query(`
      ALTER TABLE "sop_assignments"
      ADD COLUMN IF NOT EXISTS "verification_checked_at" TIMESTAMPTZ NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "sop_assignments"
      DROP COLUMN IF EXISTS "verification_checked_at"
    `);
    await queryRunner.query(`
      ALTER TABLE "sop_assignments"
      DROP COLUMN IF EXISTS "verification_session_id"
    `);
    await queryRunner.query(`
      ALTER TABLE "sop_assignments"
      DROP COLUMN IF EXISTS "verification_status"
    `);
  }
}
