import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * 遗留 P1-24：executors 增 `offlineReason` 可空 enum 列
 * （`manual` / `stale_timeout`）。
 *
 * 背景：GET /executors/:id 此前只返回 status=offline，无法区分「优雅下线
 * （执行器主动 shutdown / 管理员手动下线）」与「心跳超时被 stale sweep 判死」。
 * 本列把两类离线显式化，前端可分别展示「主动下线」与「失联判死」。
 *
 * 列语义：
 * - 可空（NULL = 历史数据未标注 / 当前在线）。仅 status=offline 时有意义；
 *   心跳恢复 online 时由代码路径置 NULL。
 * - PG enum 名 `executors_offlineReason_enum`（TypeORM 0.3.x 的
 *   `<table>_<property>_enum` 约定，与实体 @Column({ type:"enum", enum:
 *   ExecutorOfflineReason }) 对齐）。
 *
 * 幂等：CREATE TYPE 走 pg_type 存在性守卫（PG 无 CREATE TYPE IF NOT EXISTS），
 * 列走 ADD COLUMN IF NOT EXISTS，down 走 DROP COLUMN IF EXISTS + 类型守卫——
 * 重放与 revert 均无副作用（先例 1790000000024）。
 */
export class AddExecutorOfflineReason1790000000032 implements MigrationInterface {
  name = "AddExecutorOfflineReason1790000000032";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_type t
          JOIN pg_namespace n ON n.oid = t.typnamespace
          WHERE t.typname = 'executors_offlineReason_enum'
            AND n.nspname = current_schema()
        ) THEN
          CREATE TYPE "executors_offlineReason_enum" AS ENUM ('manual', 'stale_timeout');
        END IF;
      END
      $$;
    `);

    await queryRunner.query(`
      ALTER TABLE "executors"
      ADD COLUMN IF NOT EXISTS "offlineReason" "executors_offlineReason_enum"
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "executors" DROP COLUMN IF EXISTS "offlineReason"
    `);
    await queryRunner.query(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1 FROM pg_type t
          JOIN pg_namespace n ON n.oid = t.typnamespace
          WHERE t.typname = 'executors_offlineReason_enum'
            AND n.nspname = current_schema()
        ) THEN
          DROP TYPE "executors_offlineReason_enum";
        END IF;
      END
      $$;
    `);
  }
}
