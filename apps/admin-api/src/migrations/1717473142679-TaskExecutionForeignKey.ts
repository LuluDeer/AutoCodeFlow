import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * N6: Add foreign key constraint and index on task_executions.taskId.
 * taskId references tasks(id) with ON DELETE CASCADE, preventing orphan records.
 * Index on taskId speeds up getExecutions(taskId) queries.
 */
export class TaskExecutionForeignKey1717473142679 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    // Change taskId column type from VARCHAR to UUID to match tasks.id
    await queryRunner.query(`
      ALTER TABLE "task_executions"
        ALTER COLUMN "taskId" TYPE UUID USING "taskId"::uuid
    `);

    // Add index for fast lookups by taskId
    await queryRunner.query(`
      CREATE INDEX "IDX_task_executions_taskId" ON "task_executions" ("taskId")
    `);

    // Add foreign key with cascade delete
    await queryRunner.query(`
      ALTER TABLE "task_executions"
        ADD CONSTRAINT "FK_task_executions_taskId"
        FOREIGN KEY ("taskId") REFERENCES "tasks"("id") ON DELETE CASCADE
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "task_executions" DROP CONSTRAINT "FK_task_executions_taskId"`,
    );
    await queryRunner.query(`DROP INDEX "IDX_task_executions_taskId"`);
    await queryRunner.query(
      `ALTER TABLE "task_executions" ALTER COLUMN "taskId" TYPE VARCHAR`,
    );
  }
}
