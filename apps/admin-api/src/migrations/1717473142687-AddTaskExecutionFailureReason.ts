import { MigrationInterface, QueryRunner } from "typeorm";

export class AddTaskExecutionFailureReason1717473142687 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "task_executions"
        ADD COLUMN IF NOT EXISTS "failureReason" VARCHAR NULL
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_task_executions_failureReason" ON "task_executions" ("failureReason")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "IDX_task_executions_failureReason"`,
    );
    await queryRunner.query(`
      ALTER TABLE "task_executions"
        DROP COLUMN IF EXISTS "failureReason"
    `);
  }
}
