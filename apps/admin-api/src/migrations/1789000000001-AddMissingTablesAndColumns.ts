import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Schema drift 修复：补齐迁移链从未创建、仅靠历史 DB_SYNCHRONIZE=true 建出的
 * 4 张表与 6 列。空库纯迁移链（CI e2e / 生产首装）上，实体一旦被真实查询即
 * 500：
 *   - task_versions            — TaskService.saveVersion 在 create/update 链路
 *                                被调用，空库建任务直接
 *                                `relation "task_versions" does not exist`
 *                                （develop CI e2e case 23-29 全红根因）。
 *   - applications.packageUrl  — Application.findAll 全列 SELECT 500（e2e
 *                                test#8 的 /api/applications 长期 500 被容忍）。
 *   - applications.webhookSecret — 应用 webhook 签名写入路径同炸。
 *   - executor_packages.{filename,originalFilename,mimeType,pushHistory} —
 *                                包上传/推送回调 INSERT 缺列 500。
 *   - config_history / execution_reports / executor_metrics_history —
 *                                配置审计、日执行报表、执行器指标趋势尚未接
 *                                CI e2e，属潜伏同款，一并补齐。
 * 列定义与各实体文件逐一对应（列名驼峰带引号，与 synchronize 产物一致）。
 * 幂等：IF NOT EXISTS / IF EXISTS，重复执行与 revert 重放均无副作用。
 */
export class AddMissingTablesAndColumns1789000000001 implements MigrationInterface {
  name = "AddMissingTablesAndColumns1789000000001";

  public async up(queryRunner: QueryRunner): Promise<void> {
    // ── task_versions（modules/task/entities/task-version.entity.ts）──
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "task_versions" (
        "id"          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "taskId"      VARCHAR NOT NULL,
        "version"     VARCHAR NOT NULL,
        "gitCommit"   VARCHAR,
        "snapshot"    JSONB NOT NULL,
        "createdBy"   VARCHAR,
        "description" VARCHAR,
        "createdAt"   TIMESTAMP NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_task_versions_taskId_version"
      ON "task_versions" ("taskId", "version")
    `);

    // ── config_history（modules/config/entities/config-history.entity.ts）──
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "config_history" (
        "id"          SERIAL PRIMARY KEY,
        "configKey"   VARCHAR NOT NULL,
        "oldValue"    TEXT,
        "newValue"    TEXT,
        "description" VARCHAR,
        "action"      VARCHAR NOT NULL,
        "userId"      VARCHAR,
        "username"    VARCHAR,
        "ipAddress"   VARCHAR,
        "createdAt"   TIMESTAMP NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_config_history_configKey"
      ON "config_history" ("configKey")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_config_history_configKey_createdAt"
      ON "config_history" ("configKey", "createdAt")
    `);

    // ── execution_reports（modules/metrics/entities/execution-report.entity.ts）──
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "execution_reports" (
        "id"             SERIAL PRIMARY KEY,
        "triggerDay"     DATE NOT NULL,
        "runningCount"   INTEGER NOT NULL DEFAULT 0,
        "successCount"   INTEGER NOT NULL DEFAULT 0,
        "failCount"      INTEGER NOT NULL DEFAULT 0,
        "timeoutCount"   INTEGER NOT NULL DEFAULT 0,
        "cancelledCount" INTEGER NOT NULL DEFAULT 0,
        "avgDurationMs"  DOUBLE PRECISION NOT NULL DEFAULT 0,
        "maxDurationMs"  DOUBLE PRECISION NOT NULL DEFAULT 0,
        "minDurationMs"  DOUBLE PRECISION NOT NULL DEFAULT 0,
        "updateTime"     TIMESTAMP NOT NULL DEFAULT now(),
        "createdAt"      TIMESTAMP NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "idx_execution_reports_triggerDay"
      ON "execution_reports" ("triggerDay")
    `);

    // ── executor_metrics_history（executor-metrics-history.entity.ts）──
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "executor_metrics_history" (
        "id"               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "executorAddress"  VARCHAR NOT NULL,
        "cpuUsage"         DOUBLE PRECISION,
        "memUsage"         DOUBLE PRECISION,
        "diskUsage"        DOUBLE PRECISION,
        "runningTaskCount" INTEGER NOT NULL DEFAULT 0,
        "totalTaskCount"   INTEGER NOT NULL DEFAULT 0,
        "failedTaskCount"  INTEGER NOT NULL DEFAULT 0,
        "avgExecutionTime" DOUBLE PRECISION,
        "uptimeSeconds"    INTEGER NOT NULL DEFAULT 0,
        "createdAt"        TIMESTAMP NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_executor_metrics_history_address_createdAt"
      ON "executor_metrics_history" ("executorAddress", "createdAt")
    `);

    // ── applications 缺失列（application.entity.ts）──
    await queryRunner.query(`
      ALTER TABLE "applications"
      ADD COLUMN IF NOT EXISTS "packageUrl" VARCHAR
    `);
    await queryRunner.query(`
      ALTER TABLE "applications"
      ADD COLUMN IF NOT EXISTS "webhookSecret" VARCHAR
    `);

    // ── executor_packages 缺失列（executor-package.entity.ts）──
    await queryRunner.query(`
      ALTER TABLE "executor_packages"
      ADD COLUMN IF NOT EXISTS "filename" VARCHAR(256)
    `);
    await queryRunner.query(`
      ALTER TABLE "executor_packages"
      ADD COLUMN IF NOT EXISTS "originalFilename" VARCHAR(256)
    `);
    await queryRunner.query(`
      ALTER TABLE "executor_packages"
      ADD COLUMN IF NOT EXISTS "mimeType" VARCHAR(128)
    `);
    await queryRunner.query(`
      ALTER TABLE "executor_packages"
      ADD COLUMN IF NOT EXISTS "pushHistory" JSONB NOT NULL DEFAULT '[]'
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "executor_packages" DROP COLUMN IF EXISTS "pushHistory"`,
    );
    await queryRunner.query(
      `ALTER TABLE "executor_packages" DROP COLUMN IF EXISTS "mimeType"`,
    );
    await queryRunner.query(
      `ALTER TABLE "executor_packages" DROP COLUMN IF EXISTS "originalFilename"`,
    );
    await queryRunner.query(
      `ALTER TABLE "executor_packages" DROP COLUMN IF EXISTS "filename"`,
    );
    await queryRunner.query(
      `ALTER TABLE "applications" DROP COLUMN IF EXISTS "webhookSecret"`,
    );
    await queryRunner.query(
      `ALTER TABLE "applications" DROP COLUMN IF EXISTS "packageUrl"`,
    );
    await queryRunner.query(`DROP TABLE IF EXISTS "executor_metrics_history"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "execution_reports"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "config_history"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "task_versions"`);
  }
}
