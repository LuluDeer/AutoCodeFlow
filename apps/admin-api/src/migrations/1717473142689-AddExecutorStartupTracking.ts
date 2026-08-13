import { MigrationInterface, QueryRunner } from "typeorm";

export class AddExecutorStartupTracking1717473142689 implements MigrationInterface {
  name = "AddExecutorStartupTracking1717473142689";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "executors"
        ADD COLUMN IF NOT EXISTS "executorStartedAt" TIMESTAMP NULL
    `);
    await queryRunner.query(`
      ALTER TABLE "executors"
        ADD COLUMN IF NOT EXISTS "executorStartupId" VARCHAR NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "executors"
        DROP COLUMN IF EXISTS "executorStartupId"
    `);
    await queryRunner.query(`
      ALTER TABLE "executors"
        DROP COLUMN IF EXISTS "executorStartedAt"
    `);
  }
}
