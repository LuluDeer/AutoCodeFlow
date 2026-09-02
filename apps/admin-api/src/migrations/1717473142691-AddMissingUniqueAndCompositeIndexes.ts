import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * PERF/CONSISTENCY: add missing unique and composite indexes.
 *
 * - executors.address is used as the natural key by register()/heartbeat()
 *   but had no unique constraint; dedupe then enforce uniqueness.
 * - task_executions executorAddress lookups (restart recovery, stale sweep)
 *   had no covering index.
 * - app_deployments executorAddress+status filtering had no index.
 *
 * task_versions(taskId, version) was already created by migration
 * 1717473142684; system_configs.key is UNIQUE since InitialSchema.
 */
export class AddMissingUniqueAndCompositeIndexes1717473142691
  implements MigrationInterface
{
  public async up(queryRunner: QueryRunner): Promise<void> {
    // Remove duplicate executor rows (keep the most recently updated one per
    // address) before enforcing uniqueness. executorAddress columns elsewhere
    // are plain varchar without FKs, so deleting stale duplicates is safe.
    await queryRunner.query(`
      DELETE FROM "executors" e
      USING "executors" newer
      WHERE e."address" = newer."address"
        AND e."id" <> newer."id"
        AND (e."updatedAt", e."id") < (newer."updatedAt", newer."id")
    `);

    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "uq_executors_address"
      ON "executors" ("address")
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_task_executions_executor_address_status"
      ON "task_executions" ("executorAddress", "status")
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_task_executions_running"
      ON "task_executions" ("executorAddress", "startTime")
      WHERE "status" = 'running'
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_app_deployments_executor_address_status"
      ON "app_deployments" ("executorAddress", "status")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_app_deployments_executor_address_status"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_task_executions_running"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_task_executions_executor_address_status"`,
    );
    await queryRunner.query(`DROP INDEX IF EXISTS "uq_executors_address"`);
  }
}
