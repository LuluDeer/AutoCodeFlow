import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * 时序修复（N1）：本迁移原为无条件 RENAME version TO executorVersion，
 * 但其时间戳晚于 1717473142693（executors.version 乐观锁 INTEGER），
 * 全新库执行到此处时 "version" 已是乐观锁列，无条件 rename 会把 INTEGER
 * 乐观锁错名为 executorVersion，与实体（executorVersion VARCHAR 软件版本 +
 * version INTEGER @VersionColumn）冲突。
 *
 * 修复后的职责划分：
 * - 1717473142693 在新增 INTEGER version 前，先把遗留 VARCHAR version 重命名
 *   为 executorVersion（保留存量数据）——这是所有链上可达状态的正式路径；
 * - 本迁移仅在"遗留 VARCHAR version 仍在且 executorVersion 尚不存在"的残余
 *   状态下补做 rename（守卫式幂等），对已收敛的库是无操作。
 */
export class RenameExecutorVersionColumn1788274394054 implements MigrationInterface {
    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
          DO $$
          BEGIN
            IF EXISTS (
              SELECT 1 FROM information_schema.columns
              WHERE table_schema = current_schema()
                AND table_name = 'executors'
                AND column_name = 'version'
                AND data_type = 'character varying'
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
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        // 守卫：仅当 executorVersion 存在且 version 不存在时回滚 rename，
        // 避免与 1717473142693 新增的 INTEGER version 撞名报错。
        await queryRunner.query(`
          DO $$
          BEGIN
            IF EXISTS (
              SELECT 1 FROM information_schema.columns
              WHERE table_schema = current_schema()
                AND table_name = 'executors'
                AND column_name = 'executorVersion'
            ) AND NOT EXISTS (
              SELECT 1 FROM information_schema.columns
              WHERE table_schema = current_schema()
                AND table_name = 'executors'
                AND column_name = 'version'
            ) THEN
              EXECUTE 'ALTER TABLE "executors" RENAME COLUMN "executorVersion" TO "version"';
            END IF;
          END
          $$;
        `);
    }
}
