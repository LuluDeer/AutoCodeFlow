import { MigrationInterface, QueryRunner } from "typeorm";

export class AddExecutorVersion1717473142693 implements MigrationInterface {
  name = "AddExecutorVersion1717473142693";

  public async up(queryRunner: QueryRunner): Promise<void> {
    // R-P0-006: Add version column to executors for optimistic locking
    // Prevents TOCTOU race condition in dispatch() capacity slot allocation
    //
    // 撞名修复（N1）：InitialSchema 建表时 executors 已有 "version" VARCHAR
    // （旧"执行器软件版本"语义，实体中该字段已更名为 executorVersion）。
    // 本迁移要新增的 "version" 是 @VersionColumn 乐观锁（INTEGER）。
    // 因此先把遗留 VARCHAR version 重命名为 executorVersion（保留存量数据，
    // 并与实体字段名对齐，替代 1788274394054 的 rename 职责），再幂等新增
    // INTEGER version。
    await queryRunner.query(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_schema = current_schema()
            AND table_name = 'executors'
            AND column_name = 'version'
        ) AND NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_schema = current_schema()
            AND table_name = 'executors'
            AND column_name = 'executorVersion'
        ) THEN
          EXECUTE 'ALTER TABLE "executors" RENAME COLUMN "version" TO "executorVersion"';
        END IF;
      END
      $$;
    `);

    await queryRunner.query(`
      ALTER TABLE "executors"
      ADD COLUMN IF NOT EXISTS "version" INTEGER NOT NULL DEFAULT 1
    `);

    // Optional: Add index to speed up version-aware queries
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_executors_version_online"
      ON "executors"("version")
      WHERE "status" = 'online'
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Drop index first
    await queryRunner.query(`
      DROP INDEX IF EXISTS "idx_executors_version_online"
    `);

    // Drop version column
    await queryRunner.query(`
      ALTER TABLE "executors"
      DROP COLUMN IF EXISTS "version"
    `);
  }
}
