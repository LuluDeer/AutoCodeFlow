import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * N1 补偿迁移：app_deployments 建表。
 *
 * 全部既有迁移中没有任何一处 CREATE TABLE "app_deployments"，但
 * 1717473142691 对其建索引（现已加表存在性守卫），实体
 * modules/application/entities/app-deployment.entity.ts 长期无表可用——
 * 任何对 AppDeployment repository 的读写都会报 relation does not exist。
 *
 * 本迁移按实体定义建表（列名/类型/枚举/索引与 entity 逐一对齐）。
 * 幂等说明：
 * - 全新库：1717473142691 时表不存在（守卫跳过索引），本迁移建表 + 建全部索引；
 * - 已手工预建过该表的存量库：CREATE TABLE IF NOT EXISTS 与索引存在性
 *   检查保证重复执行无副作用。
 * 枚举类型创建前先判断存在（DO 块），避免与手工建表环境冲突。
 */
export class CreateAppDeploymentsTable1788274394055 implements MigrationInterface {
  name = "CreateAppDeploymentsTable1788274394055";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_type t
          JOIN pg_namespace n ON n.oid = t.typnamespace
          WHERE t.typname = 'app_deployments_status_enum'
            AND n.nspname = current_schema()
        ) THEN
          CREATE TYPE "app_deployments_status_enum" AS ENUM (
            'pending', 'deploying', 'running', 'stopped', 'failed', 'upgrading'
          );
        END IF;
      END
      $$;
    `);

    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_type t
          JOIN pg_namespace n ON n.oid = t.typnamespace
          WHERE t.typname = 'app_deployments_run_mode_enum'
            AND n.nspname = current_schema()
        ) THEN
          CREATE TYPE "app_deployments_run_mode_enum" AS ENUM ('once', 'daemon', 'scheduled');
        END IF;
      END
      $$;
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "app_deployments" (
        "id"              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "applicationId"   UUID NOT NULL,
        "executorAddress" VARCHAR NOT NULL,
        "executorId"      VARCHAR,
        "status"          "app_deployments_status_enum" NOT NULL DEFAULT 'pending',
        "runMode"         "app_deployments_run_mode_enum" NOT NULL DEFAULT 'daemon',
        "deployedCommit"  VARCHAR,
        "deployedVersion" VARCHAR,
        "startCommand"    VARCHAR,
        "env"             JSONB,
        "pid"             INTEGER,
        "lastHeartbeat"   TIMESTAMP,
        "statusMessage"   TEXT,
        "deployedAt"      TIMESTAMP,
        "createdAt"       TIMESTAMP NOT NULL DEFAULT now(),
        "updatedAt"       TIMESTAMP NOT NULL DEFAULT now()
      )
    `);

    await queryRunner.query(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1 FROM information_schema.tables
          WHERE table_schema = current_schema()
            AND table_name = 'applications'
        ) AND NOT EXISTS (
          SELECT 1 FROM information_schema.table_constraints
          WHERE table_schema = current_schema()
            AND table_name = 'app_deployments'
            AND constraint_name = 'FK_app_deployments_applicationId'
            AND constraint_type = 'FOREIGN KEY'
        ) THEN
          EXECUTE 'ALTER TABLE "app_deployments" ADD CONSTRAINT "FK_app_deployments_applicationId" FOREIGN KEY ("applicationId") REFERENCES "applications"("id") ON DELETE CASCADE';
        END IF;
      END
      $$;
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_app_deployments_applicationId"
      ON "app_deployments" ("applicationId")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_app_deployments_applicationId_status"
      ON "app_deployments" ("applicationId", "status")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_app_deployments_status"
      ON "app_deployments" ("status")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_app_deployments_executor_address_status"
      ON "app_deployments" ("executorAddress", "status")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_app_deployments_executor_address_status"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_app_deployments_status"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_app_deployments_applicationId_status"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_app_deployments_applicationId"`,
    );
    await queryRunner.query(
      `ALTER TABLE "app_deployments" DROP CONSTRAINT IF EXISTS "FK_app_deployments_applicationId"`,
    );
    await queryRunner.query(`DROP TABLE IF EXISTS "app_deployments"`);
    await queryRunner.query(
      `DROP TYPE IF EXISTS "app_deployments_run_mode_enum"`,
    );
    await queryRunner.query(
      `DROP TYPE IF EXISTS "app_deployments_status_enum"`,
    );
  }
}
