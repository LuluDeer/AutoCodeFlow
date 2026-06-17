import { MigrationInterface, QueryRunner } from "typeorm";

export class ExecutorTokenHash1717473142682 implements MigrationInterface {
  name = "ExecutorTokenHash1717473142682";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "executors" ADD COLUMN IF NOT EXISTS "maxConcurrentTasks" INTEGER DEFAULT NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE "executors" ADD COLUMN IF NOT EXISTS "tokenHash" VARCHAR DEFAULT NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "executors" DROP COLUMN IF EXISTS "tokenHash"`,
    );
    await queryRunner.query(
      `ALTER TABLE "executors" DROP COLUMN IF EXISTS "maxConcurrentTasks"`,
    );
  }
}
