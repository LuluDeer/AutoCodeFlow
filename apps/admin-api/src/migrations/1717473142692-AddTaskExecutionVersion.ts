import { MigrationInterface, QueryRunner } from "typeorm";

export class AddTaskExecutionVersion1717473142692
  implements MigrationInterface
{
  name = "AddTaskExecutionVersion1717473142692";

  public async up(queryRunner: QueryRunner): Promise<void> {
    // R-P0-007: Add version column to task_executions for optimistic locking
    // Prevents concurrent updates from Worker/Callback/Kill operations
    await queryRunner.query(`
      ALTER TABLE "task_executions" 
      ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1
    `);

    // Optional: Add partial index for active executions to speed up version checks
    await queryRunner.query(`
      CREATE INDEX "idx_task_executions_version_active" 
      ON "task_executions"("version") 
      WHERE "status" IN ('pending', 'running')
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Drop index first
    await queryRunner.query(`
      DROP INDEX IF EXISTS "idx_task_executions_version_active"
    `);

    // Drop version column
    await queryRunner.query(`
      ALTER TABLE "task_executions" 
      DROP COLUMN "version"
    `);
  }
}
