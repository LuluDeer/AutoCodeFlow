import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * DB-002: execution_log_lines 增加写入时间 createdAt 与索引，作为日志
 * TTL 清理（LogRetentionCleanupService，LOG_RETENTION_DAYS 默认 30 天）
 * 的时间依据，避免该表随任务执行无限膨胀。
 *
 * 范围说明：仅清理数据库行。LOG_STORAGE_DRIVER=s3 时完整日志对象外置到
 * MinIO/S3（见 modules/task/log-storage/s3-log-storage.ts），外置对象
 * 不在本迁移与清理服务范围内，需另行配置 bucket 生命周期策略。
 *
 * 注意事项：
 * - 存量行的真实写入时间无法回溯，ADD COLUMN 的 DEFAULT now() 会把
 *   存量行统一记为迁移执行时间（相当于多保留一个保留周期，可接受）；
 * - PG 对带易失默认值（now()）的 ADD COLUMN 需要整表重写并持有
 *   ACCESS EXCLUSIVE 锁，大表请在维护窗口执行。
 */
export class AddExecutionLogLineCreatedAt1717473142703
  implements MigrationInterface
{
  name = "AddExecutionLogLineCreatedAt1717473142703";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "execution_log_lines"
        ADD COLUMN IF NOT EXISTS "createdAt" TIMESTAMP NOT NULL DEFAULT now()
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_execution_log_lines_createdAt"
      ON "execution_log_lines" ("createdAt")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_execution_log_lines_createdAt"`,
    );
    await queryRunner.query(
      `ALTER TABLE "execution_log_lines" DROP COLUMN IF EXISTS "createdAt"`,
    );
  }
}
