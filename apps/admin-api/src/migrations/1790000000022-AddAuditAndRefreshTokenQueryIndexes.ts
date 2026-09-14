import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * PK-16（DEEP_REVIEW 0ef3bbe packages 批）：audit_logs / refresh_tokens
 * 实际查询面缺索引支撑。
 *
 * 背景：
 * - audit_logs 是 append-only 高频写入表（append-only 触发器已上），
 *   AuditService 列表查询按 action/resource/userId/username 过滤 +
 *   createdAt DESC 排序——单列 idx_audit_logs_action（1717473142683 建）
 *   只能过滤不能免排序，随数据量线性劣化；本迁移补
 *   (action, createdAt) 复合索引（过滤 + 排序一索两用）。
 * - refresh_tokens：AuthService 会话列表按 (userId, revoked) 查、
 *   定时清理按 expiresAt LessThan(now) DELETE——两个列都无索引，每轮
 *   清理全表扫描。补 userId / expiresAt 两个普通索引。
 *
 * 命名对齐 1717473142683（AddPerformanceIndexes）既有风格
 * （idx_<table>_<col>[_<col>]，camelCase 列名转 snake 段）。
 *
 * 幂等：CREATE/DROP INDEX IF [NOT] EXISTS，重复执行与 revert 重放均无
 * 副作用。全部为非唯一普通索引，不触碰数据行。
 */
export class AddAuditAndRefreshTokenQueryIndexes1790000000022 implements MigrationInterface {
  name = "AddAuditAndRefreshTokenQueryIndexes1790000000022";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_audit_logs_action_created_at"
      ON "audit_logs" ("action", "createdAt")
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_refresh_tokens_user_id"
      ON "refresh_tokens" ("userId")
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_refresh_tokens_expires_at"
      ON "refresh_tokens" ("expiresAt")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DROP INDEX IF EXISTS "idx_refresh_tokens_expires_at"
    `);

    await queryRunner.query(`
      DROP INDEX IF EXISTS "idx_refresh_tokens_user_id"
    `);

    await queryRunner.query(`
      DROP INDEX IF EXISTS "idx_audit_logs_action_created_at"
    `);
  }
}
