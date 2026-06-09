import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * M1: Add Application entity, new Task fields (applicationId, glueSource, glueLanguage,
 * executorGroup, executorTags, retryDelay, retryableErrors, priority, executeMode),
 * and task-version entity improvements.
 */
export class AddApplicationAndTaskFields1717473142684 implements MigrationInterface {
  name = 'AddApplicationAndTaskFields1717473142684';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // ── Application table ──────────────────────────────────────
    await queryRunner.query(`CREATE TYPE "application_status_enum" AS ENUM ('active', 'deploying', 'failed')`);

    await queryRunner.query(`
      CREATE TABLE "applications" (
        "id"          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "name"        VARCHAR NOT NULL UNIQUE,
        "description" VARCHAR,
        "version"     VARCHAR NOT NULL,
        "runtime"     VARCHAR NOT NULL,
        "status"      "application_status_enum" NOT NULL DEFAULT 'active',
        "gitRepo"     VARCHAR,
        "gitBranch"   VARCHAR,
        "gitCommit"   VARCHAR,
        "manifest"    JSONB,
        "env"         JSONB,
        "entrypoint"  VARCHAR,
        "createdAt"   TIMESTAMP NOT NULL DEFAULT now(),
        "updatedAt"   TIMESTAMP NOT NULL DEFAULT now()
      )
    `);

    await queryRunner.query(`CREATE INDEX "idx_applications_status" ON "applications" ("status")`);
    await queryRunner.query(`CREATE INDEX "idx_applications_name" ON "applications" ("name")`);

    // ── New Task fields ──────────────────────────────────────
    // applicationId (links task to application)
    await queryRunner.query(`
      ALTER TABLE "tasks" ADD COLUMN "applicationId" UUID
    `);
    await queryRunner.query(`
      ALTER TABLE "tasks" ADD CONSTRAINT "FK_tasks_applicationId"
      FOREIGN KEY ("applicationId") REFERENCES "applications"("id") ON DELETE SET NULL
    `);
    await queryRunner.query(`CREATE INDEX "idx_tasks_applicationId" ON "tasks" ("applicationId")`);

    // Glue script fields
    await queryRunner.query(`
      ALTER TABLE "tasks" ADD COLUMN "glueSource" TEXT
    `);
    await queryRunner.query(`
      ALTER TABLE "tasks" ADD COLUMN "glueLanguage" VARCHAR
    `);

    // Executor routing fields
    await queryRunner.query(`
      ALTER TABLE "tasks" ADD COLUMN "executorGroup" VARCHAR
    `);
    await queryRunner.query(`
      ALTER TABLE "tasks" ADD COLUMN "executorTags" TEXT
    `);

    // Retry and priority fields
    await queryRunner.query(`
      ALTER TABLE "tasks" ADD COLUMN "retryDelay" INTEGER NOT NULL DEFAULT 0
    `);
    await queryRunner.query(`
      ALTER TABLE "tasks" ADD COLUMN "retryableErrors" TEXT
    `);

    // Task priority and execute mode enums
    await queryRunner.query(`CREATE TYPE "task_priority_enum" AS ENUM ('low', 'normal', 'high', 'critical')`);
    await queryRunner.query(`CREATE TYPE "task_execute_mode_enum" AS ENUM ('single', 'broadcast', 'shard')`);

    await queryRunner.query(`
      ALTER TABLE "tasks" ADD COLUMN "priority" "task_priority_enum" NOT NULL DEFAULT 'normal'
    `);
    await queryRunner.query(`
      ALTER TABLE "tasks" ADD COLUMN "executeMode" "task_execute_mode_enum" NOT NULL DEFAULT 'single'
    `);

    // ── Task version improvements ───────────────────────────
    // Add gitBranch to snapshot consistency
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_task_versions_taskId_version" ON "task_versions" ("taskId", "version")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Task columns
    await queryRunner.query(`ALTER TABLE "tasks" DROP COLUMN "executeMode"`);
    await queryRunner.query(`ALTER TABLE "tasks" DROP COLUMN "priority"`);
    await queryRunner.query(`ALTER TABLE "tasks" DROP COLUMN "retryableErrors"`);
    await queryRunner.query(`ALTER TABLE "tasks" DROP COLUMN "retryDelay"`);
    await queryRunner.query(`ALTER TABLE "tasks" DROP COLUMN "executorTags"`);
    await queryRunner.query(`ALTER TABLE "tasks" DROP COLUMN "executorGroup"`);
    await queryRunner.query(`ALTER TABLE "tasks" DROP COLUMN "glueLanguage"`);
    await queryRunner.query(`ALTER TABLE "tasks" DROP COLUMN "glueSource"`);
    await queryRunner.query(`ALTER TABLE "tasks" DROP CONSTRAINT "FK_tasks_applicationId"`);
    await queryRunner.query(`ALTER TABLE "tasks" DROP COLUMN "applicationId"`);

    // Application table
    await queryRunner.query(`DROP TABLE IF EXISTS "applications"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "application_status_enum"`);

    // Task enums
    await queryRunner.query(`DROP TYPE IF EXISTS "task_execute_mode_enum"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "task_priority_enum"`);

    // Indexes
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_task_versions_taskId_version"`);
  }
}