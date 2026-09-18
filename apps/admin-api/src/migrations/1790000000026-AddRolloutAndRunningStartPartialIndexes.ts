import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * PERF (O-1 / O-2): partial indexes backing the rollout restart sweep and the
 * task_executions stale-sweep.
 *
 * - idx_app_deployments_rollout_state_active: markInterruptedRolloutsFailed()
 *   filters rolloutState IN ('pending','probing'); a partial index keeps only
 *   the in-flight rows instead of the whole table.
 * - idx_task_executions_start_time_running: recoverStaleExecutions() filters
 *   status='running' AND startTime < cutoff with NO executorAddress predicate.
 *   The existing idx_task_executions_running leads with executorAddress and so
 *   cannot serve that scan; a (startTime) partial index does.
 *
 * Mirrors the entity @Index declarations (app-deployment.entity.ts,
 * task-execution.entity.ts). Both tables already exist by this revision.
 */
export class AddRolloutAndRunningStartPartialIndexes1790000000026 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_app_deployments_rollout_state_active"
      ON "app_deployments" ("rolloutState")
      WHERE "rolloutState" IN ('pending','probing')
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_task_executions_start_time_running"
      ON "task_executions" ("startTime")
      WHERE "status" = 'running'
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_task_executions_start_time_running"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_app_deployments_rollout_state_active"`,
    );
  }
}
