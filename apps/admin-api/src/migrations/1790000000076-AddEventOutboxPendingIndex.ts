import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * db-3（第 3 轮并行审计，P2）：`event_outbox` 补与 claim 谓词逐字对应的
 * partial index。
 *
 * ## 缺陷
 * outbox 补投每 5s 一轮，claim 谓词是
 *   `dispatchedAt IS NULL AND deadLettered = false AND (nextAttemptAt …) AND (leaseUntil …)`
 *   `ORDER BY createdAt LIMIT 5 FOR UPDATE SKIP LOCKED`
 * 而表上只有 4 个单列索引（dispatchedAt / nextAttemptAt / eventId / leaseUntil），
 * 没有 createdAt 索引、没有 deadLettered 索引、也没有与谓词匹配的 partial index。
 * 死信行**不会**离开 `dispatchedAt IS NULL` 集合（终态只置 deadLettered=true，
 * 保留 90 天），于是每次 tick 都要回堆判几十万行死信，而真正要投的只有 0~5 条。
 * 工作队列的扫描成本与「历史失败量」成正比，而不是与「待投量」成正比。
 *
 * ## 为什么是 partial index
 * 谓词 `dispatchedAt IS NULL AND deadLettered = false` 恰好是「可投递集合」，
 * 死信与已投递行**完全不进索引**；`ORDER BY createdAt` 由索引序直接满足，
 * 不再需要 Sort。`nextAttemptAt`/`leaseUntil` 继续作残余过滤（退避行占比高
 * 时再考虑第二个 partial index，不在本轮扩大）。
 *
 * ## 并发与超时
 * 同 db-1/db-2：transaction=false + 会话级 statement_timeout 豁免 + finally
 * RESET（连接归还池）。
 */
export class AddEventOutboxPendingIndex1790000000076 implements MigrationInterface {
  name = "AddEventOutboxPendingIndex1790000000076";

  transaction = false;

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`SET statement_timeout = 0`);
    try {
      await queryRunner.query(`
        CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_event_outbox_pending"
        ON "event_outbox" ("createdAt")
        WHERE "dispatchedAt" IS NULL AND "deadLettered" = false
      `);
    } finally {
      await queryRunner.query(`RESET statement_timeout`);
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`SET statement_timeout = 0`);
    try {
      await queryRunner.query(
        `DROP INDEX CONCURRENTLY IF EXISTS "idx_event_outbox_pending"`,
      );
    } finally {
      await queryRunner.query(`RESET statement_timeout`);
    }
  }
}
