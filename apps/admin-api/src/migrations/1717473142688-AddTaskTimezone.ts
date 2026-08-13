import { MigrationInterface, QueryRunner } from "typeorm";

export class AddTaskTimezone1717473142688 implements MigrationInterface {
  name = "AddTaskTimezone1717473142688";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "timezone" VARCHAR`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "tasks" DROP COLUMN IF EXISTS "timezone"`,
    );
  }
}
