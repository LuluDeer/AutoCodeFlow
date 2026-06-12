import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Fix: Add columns that executor.entity.ts defines but were missing from initial schema:
 * - running_task_count (used for optimistic-lock dispatch)
 * - disk_usage, network_latency, total_task_count, failed_task_count
 * - max_concurrent_tasks, token_hash, group_name, tags, description
 */
export class AddExecutorMissingColumns1717473142685 implements MigrationInterface {
  name = "AddExecutorMissingColumns1717473142685";

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Core dispatch column — was causing all task executions to fail
    await queryRunner.query(`
      ALTER TABLE "executors"
      ADD COLUMN IF NOT EXISTS "runningTaskCount" INTEGER NOT NULL DEFAULT 0
    `);

    // Extended metrics
    await queryRunner.query(`
      ALTER TABLE "executors"
      ADD COLUMN IF NOT EXISTS "diskUsage" DOUBLE PRECISION
    `);
    await queryRunner.query(`
      ALTER TABLE "executors"
      ADD COLUMN IF NOT EXISTS "networkLatency" DOUBLE PRECISION
    `);
    await queryRunner.query(`
      ALTER TABLE "executors"
      ADD COLUMN IF NOT EXISTS "totalTaskCount" INTEGER NOT NULL DEFAULT 0
    `);
    await queryRunner.query(`
      ALTER TABLE "executors"
      ADD COLUMN IF NOT EXISTS "failedTaskCount" INTEGER NOT NULL DEFAULT 0
    `);

    // Capacity and auth
    await queryRunner.query(`
      ALTER TABLE "executors"
      ADD COLUMN IF NOT EXISTS "maxConcurrentTasks" INTEGER
    `);
    await queryRunner.query(`
      ALTER TABLE "executors"
      ADD COLUMN IF NOT EXISTS "tokenHash" VARCHAR
    `);

    // Grouping and routing
    await queryRunner.query(`
      ALTER TABLE "executors"
      ADD COLUMN IF NOT EXISTS "groupName" VARCHAR
    `);
    await queryRunner.query(`
      ALTER TABLE "executors"
      ADD COLUMN IF NOT EXISTS "tags" TEXT
    `);
    await queryRunner.query(`
      ALTER TABLE "executors"
      ADD COLUMN IF NOT EXISTS "description" TEXT
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "executors" DROP COLUMN IF EXISTS "description"`);
    await queryRunner.query(`ALTER TABLE "executors" DROP COLUMN IF EXISTS "tags"`);
    await queryRunner.query(`ALTER TABLE "executors" DROP COLUMN IF EXISTS "groupName"`);
    await queryRunner.query(`ALTER TABLE "executors" DROP COLUMN IF EXISTS "tokenHash"`);
    await queryRunner.query(`ALTER TABLE "executors" DROP COLUMN IF EXISTS "maxConcurrentTasks"`);
    await queryRunner.query(`ALTER TABLE "executors" DROP COLUMN IF EXISTS "failedTaskCount"`);
    await queryRunner.query(`ALTER TABLE "executors" DROP COLUMN IF EXISTS "totalTaskCount"`);
    await queryRunner.query(`ALTER TABLE "executors" DROP COLUMN IF EXISTS "networkLatency"`);
    await queryRunner.query(`ALTER TABLE "executors" DROP COLUMN IF EXISTS "diskUsage"`);
    await queryRunner.query(`ALTER TABLE "executors" DROP COLUMN IF EXISTS "runningTaskCount"`);
  }
}
