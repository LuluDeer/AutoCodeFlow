import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * 第 6 轮八域审计 P2：`sop_clarifications` 的待办 partial 索引。
 *
 * 兜底扫描（`sweepStuckClarifications`，每 5 分钟）谓词是
 * `resolution IS NULL ORDER BY createdAt ASC LIMIT 100`，而该表此前只有
 * assignmentId/round 与 clientId 两个索引——扫描是 seq scan + Sort，成本与
 * **历史澄清总量**成正比（表无 retention），而与待办量无关。
 *
 * partial 索引只装未答复行：扫描成本改为与待办量成正比。CONCURRENTLY 建
 * （表已有生产写入），transaction=false + 会话级 statement_timeout 豁免 +
 * finally RESET（与 1790000000075/0076 同纪律；SET LOCAL 无事务块会退化）。
 */
export class AddSopClarificationsPendingIndex1790000000080 implements MigrationInterface {
  name = "AddSopClarificationsPendingIndex1790000000080";

  transaction = false;

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`SET statement_timeout = 0`);
    try {
      await queryRunner.query(`
        CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_sop_clarifications_pending"
        ON "sop_clarifications" ("createdAt")
        WHERE "resolution" IS NULL
      `);
    } finally {
      await queryRunner.query(`RESET statement_timeout`);
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`SET statement_timeout = 0`);
    try {
      await queryRunner.query(`
        DROP INDEX CONCURRENTLY IF EXISTS "idx_sop_clarifications_pending"
      `);
    } finally {
      await queryRunner.query(`RESET statement_timeout`);
    }
  }
}
