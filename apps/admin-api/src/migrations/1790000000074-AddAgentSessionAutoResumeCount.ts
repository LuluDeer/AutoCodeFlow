import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * GAP-3（LLM 瞬态耗尽的自动续跑）：`agent_sessions` 补 `autoResumeCount`。
 *
 * ## 为什么这个计数必须落库
 * 自动续跑的语义是「每个会话最多自动补跑一次」——provider 长时间挂掉时，
 * 若每次耗尽都排一个 delayed job，退避重试就换皮成了重试风暴（60s 一次，
 * 每次先烧 3 次 LLM 尝试）。判据必须是**跨进程持久**的：
 *   · 进程内 Set：N 个 admin-api 副本 = N 次补跑；重启即清零 = 无限补跑；
 *   · 扫 steps 找标记：多一次全表读，且把控制面状态塞进审计面。
 * 条件写 `autoResumeCount < 1` 是同一把 CAS 纪律（GAP-1 的 markRunning、
 * ADR-026 的条件写）：多副本同时判定时只有一个赢家。
 *
 * ## 为什么默认 0 且不回填
 * 存量会话从未自动续跑过，0 是事实；回填任何非零值都等于伪造履历。
 */
export class AddAgentSessionAutoResumeCount1790000000074 implements MigrationInterface {
  name = "AddAgentSessionAutoResumeCount1790000000074";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "agent_sessions"
      ADD COLUMN IF NOT EXISTS "autoResumeCount" integer NOT NULL DEFAULT 0
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "agent_sessions" DROP COLUMN IF EXISTS "autoResumeCount"`,
    );
  }
}
