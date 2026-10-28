import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * 视频转 SOP（2026-10-28）：`ai_sop_sessions` 补 `turnLockedAt`。
 *
 * ## 为什么需要"回合锁"
 * 一轮 = 一次全量视频推理（贵）。但"再点一次发送 / 刷新后重发 / 两个标签页"
 * 都会让同一会话**并发跑两轮**：成本翻倍、消息交错、后写覆盖先写。
 * 进程内 Set 只能挡单实例（本仓明确支持多副本），所以锁要落在库里：
 *
 * ```
 * UPDATE ... SET "turnLockedAt" = now()
 *  WHERE id = $1 AND ("turnLockedAt" IS NULL
 *                     OR "turnLockedAt" < now() - interval '5 minutes')
 * ```
 * 命中 0 行 → 别人正在跑（409）；5 分钟自动过期 → 进程崩溃不会留下永久死锁
 * （比"手动解锁"可靠，也不需要额外的清理任务）。
 *
 * down：DROP COLUMN IF EXISTS（纯加列）。
 */
export class AddAiSopSessionTurnLock1790000000072 implements MigrationInterface {
  name = "AddAiSopSessionTurnLock1790000000072";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "ai_sop_sessions"
        ADD COLUMN IF NOT EXISTS "turnLockedAt" TIMESTAMPTZ NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "ai_sop_sessions" DROP COLUMN IF EXISTS "turnLockedAt"`,
    );
  }
}
