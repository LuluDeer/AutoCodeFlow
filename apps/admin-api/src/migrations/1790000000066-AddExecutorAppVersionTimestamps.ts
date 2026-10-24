import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * R3 迁移缺口收口（2026-10-25，5c E2E selftest 暴露）：executor_app_versions
 * 补 createdAt / updatedAt 列。
 *
 * ## 缺口成因
 *
 * 迁移 1790000000063 建表时漏了实体的 @CreateDateColumn/@UpdateDateColumn
 * （executor-app-version.entity.ts:91-93）两列——admin-api jest 对该表的
 * 测试用映射替身/SQLite 方言，SELECT 全列时两列「碰巧」由 TypeORM 内存补齐
 * 或根本不触发，全绿掩盖了 DDL 缺口。首个跑「真 PG + 完整迁移链」的场景
 * （arch31 cross-instance selftest，5c 轮 CI）在心跳落库路径暴露：
 * `column ExecutorAppVersion.createdAt does not exist`——deployedApps
 * 持久化每拍必败，设备版本事实（R3 主交付）实际从未落库。
 *
 * ## 为什么是新增迁移而不是改 63
 *
 * 63 已在 develop 环境执行过（迁移记录按 name 记账，改已执行迁移的内容
 * 不会重放）。本迁移对已执行 63 的库补列；63 的建表语句同步修正，让将来
 * 的空库一次到位（本迁移的 IF NOT EXISTS 对新库是 no-op，双向幂等）。
 *
 * ## down
 *
 * 逆序删列（IF EXISTS 幂等）。删列会丢 lastReportedAt 之外的创建/更新
 * 时间线——down 本就只用于迁移链演练，不做数据回填。
 */
export class AddExecutorAppVersionTimestamps1790000000066 implements MigrationInterface {
  name = "AddExecutorAppVersionTimestamps1790000000066";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "executor_app_versions"
      ADD COLUMN IF NOT EXISTS "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now()
    `);
    await queryRunner.query(`
      ALTER TABLE "executor_app_versions"
      ADD COLUMN IF NOT EXISTS "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now()
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "executor_app_versions" DROP COLUMN IF EXISTS "updatedAt"`,
    );
    await queryRunner.query(
      `ALTER TABLE "executor_app_versions" DROP COLUMN IF EXISTS "createdAt"`,
    );
  }
}
