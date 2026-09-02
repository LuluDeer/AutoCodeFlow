import { MigrationInterface, QueryRunner } from "typeorm";

export class AddExecutorVersion1717473142693 implements MigrationInterface {
  name = "AddExecutorVersion1717473142693";

  public async up(queryRunner: QueryRunner): Promise<void> {
    // R-P0-006: Add version column to executors for optimistic locking
    // Prevents TOCTOU race condition in dispatch() capacity slot allocation
    await queryRunner.query(`
      ALTER TABLE "executors" 
      ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1
    `);

    // Optional: Add index to speed up version-aware queries
    await queryRunner.query(`
      CREATE INDEX "idx_executors_version_online" 
      ON "executors"("version") 
      WHERE "status" = 'online'
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Drop index first
    await queryRunner.query(`
      DROP INDEX IF EXISTS "idx_executors_version_online"
    `);

    // Drop version column
    await queryRunner.query(`
      ALTER TABLE "executors" 
      DROP COLUMN "version"
    `);
  }
}
