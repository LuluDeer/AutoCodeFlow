import { MigrationInterface, QueryRunner } from "typeorm";

export class AddExecutionLogStorage1717473142690 implements MigrationInterface {
  name = "AddExecutionLogStorage1717473142690";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "task_executions" ADD COLUMN IF NOT EXISTS "logStorage" VARCHAR DEFAULT 'db'`,
    );
    await queryRunner.query(
      `ALTER TABLE "task_executions" ADD COLUMN IF NOT EXISTS "logObjectKey" VARCHAR`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "task_executions" DROP COLUMN IF EXISTS "logObjectKey"`,
    );
    await queryRunner.query(
      `ALTER TABLE "task_executions" DROP COLUMN IF EXISTS "logStorage"`,
    );
  }
}
