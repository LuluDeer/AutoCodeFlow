import { MigrationInterface, QueryRunner } from 'typeorm';

export class InitialSchema1717473142678 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    // Enums
    await queryRunner.query(`CREATE TYPE "user_role_enum" AS ENUM ('admin', 'user')`);
    await queryRunner.query(`CREATE TYPE "task_status_enum" AS ENUM ('active', 'paused', 'deleted')`);
    await queryRunner.query(`CREATE TYPE "task_triggertype_enum" AS ENUM ('cron', 'fixed_rate', 'api', 'manual')`);
    await queryRunner.query(`CREATE TYPE "task_runtime_enum" AS ENUM ('python', 'node', 'shell')`);
    await queryRunner.query(`CREATE TYPE "task_blockstrategy_enum" AS ENUM ('serial', 'discard')`);
    await queryRunner.query(`CREATE TYPE "task_misfirestrategy_enum" AS ENUM ('ignore', 'fire_once')`);
    await queryRunner.query(`CREATE TYPE "executor_status_enum" AS ENUM ('online', 'offline')`);
    await queryRunner.query(`CREATE TYPE "executor_type_enum" AS ENUM ('python', 'node', 'universal')`);
    await queryRunner.query(`CREATE TYPE "execution_status_enum" AS ENUM ('pending', 'running', 'success', 'failed', 'timeout', 'killed')`);

    // users
    await queryRunner.query(`
      CREATE TABLE "users" (
        "id"        SERIAL PRIMARY KEY,
        "username"  VARCHAR NOT NULL UNIQUE,
        "email"     VARCHAR NOT NULL UNIQUE,
        "password"  VARCHAR NOT NULL,
        "role"      "user_role_enum" NOT NULL DEFAULT 'user',
        "isActive"  BOOLEAN NOT NULL DEFAULT true,
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP NOT NULL DEFAULT now()
      )
    `);

    // tasks
    await queryRunner.query(`
      CREATE TABLE "tasks" (
        "id"               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "name"             VARCHAR NOT NULL,
        "description"      VARCHAR,
        "status"           "task_status_enum" NOT NULL DEFAULT 'active',
        "triggerType"      "task_triggertype_enum" NOT NULL,
        "cronExpression"   VARCHAR,
        "fixedRate"        INTEGER,
        "runtime"          "task_runtime_enum" NOT NULL DEFAULT 'python',
        "runtimeVersion"   VARCHAR,
        "dependencies"     JSONB,
        "entrypoint"       VARCHAR,
        "gitRepo"          VARCHAR,
        "gitBranch"        VARCHAR,
        "gitCommit"        VARCHAR,
        "currentVersion"   VARCHAR,
        "timeout"          INTEGER NOT NULL DEFAULT 0,
        "maxRetry"         INTEGER NOT NULL DEFAULT 3,
        "blockStrategy"    "task_blockstrategy_enum" NOT NULL DEFAULT 'serial',
        "misfireStrategy"  "task_misfirestrategy_enum" NOT NULL DEFAULT 'ignore',
        "lastTriggerTime"  TIMESTAMP,
        "alarmEmail"       VARCHAR,
        "alarmChannels"    TEXT,
        "params"           JSONB,
        "executorAppName" VARCHAR,
        "createdAt"        TIMESTAMP NOT NULL DEFAULT now(),
        "updatedAt"        TIMESTAMP NOT NULL DEFAULT now()
      )
    `);

    // task_executions
    await queryRunner.query(`
      CREATE TABLE "task_executions" (
        "id"              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "taskId"          VARCHAR NOT NULL,
        "taskName"        VARCHAR NOT NULL,
        "status"          "execution_status_enum" NOT NULL DEFAULT 'pending',
        "executorAddress" VARCHAR,
        "logs"            TEXT,
        "result"          JSONB,
        "params"          JSONB,
        "startTime"       TIMESTAMP,
        "endTime"         TIMESTAMP,
        "duration"        INTEGER,
        "retryCount"      INTEGER NOT NULL DEFAULT 0,
        "errorMessage"    VARCHAR,
        "aiAnalysis"      TEXT,
        "triggerType"     VARCHAR,
        "taskVersion"     VARCHAR,
        "createdAt"       TIMESTAMP NOT NULL DEFAULT now()
      )
    `);

    // execution_log_lines
    await queryRunner.query(`
      CREATE TABLE "execution_log_lines" (
        "id"          SERIAL PRIMARY KEY,
        "executionId" VARCHAR NOT NULL,
        "lineNumber"  INTEGER NOT NULL,
        "content"     TEXT NOT NULL
      )
    `);
    await queryRunner.query(`CREATE INDEX "IDX_execution_log_lines_executionId_lineNumber" ON "execution_log_lines" ("executionId", "lineNumber")`);

    // executors
    await queryRunner.query(`
      CREATE TABLE "executors" (
        "id"               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "appName"          VARCHAR NOT NULL,
        "address"          VARCHAR NOT NULL,
        "status"           "executor_status_enum" NOT NULL DEFAULT 'offline',
        "type"             "executor_type_enum" NOT NULL DEFAULT 'python',
        "version"          VARCHAR,
        "capabilities"     TEXT,
        "lastHeartbeat"    TIMESTAMP,
        "runningTaskCount" INTEGER NOT NULL DEFAULT 0,
        "cpuUsage"         FLOAT,
        "memUsage"         FLOAT,
        "createdAt"        TIMESTAMP NOT NULL DEFAULT now(),
        "updatedAt"        TIMESTAMP NOT NULL DEFAULT now()
      )
    `);

    // audit_logs
    await queryRunner.query(`
      CREATE TABLE "audit_logs" (
        "id"         SERIAL PRIMARY KEY,
        "userId"     INTEGER,
        "username"   VARCHAR,
        "action"     VARCHAR NOT NULL,
        "resource"   VARCHAR,
        "resourceId" VARCHAR,
        "detail"     JSONB,
        "ip"         VARCHAR,
        "result"     VARCHAR NOT NULL DEFAULT 'success',
        "createdAt"  TIMESTAMP NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(`CREATE INDEX "IDX_audit_logs_userId" ON "audit_logs" ("userId")`);
    await queryRunner.query(`CREATE INDEX "IDX_audit_logs_createdAt" ON "audit_logs" ("createdAt")`);

    // system_configs
    await queryRunner.query(`
      CREATE TABLE "system_configs" (
        "id"          SERIAL PRIMARY KEY,
        "key"         VARCHAR NOT NULL UNIQUE,
        "value"       TEXT,
        "description" VARCHAR,
        "valueType"   VARCHAR NOT NULL DEFAULT 'string',
        "isSecret"    BOOLEAN NOT NULL DEFAULT false,
        "createdAt"   TIMESTAMP NOT NULL DEFAULT now(),
        "updatedAt"   TIMESTAMP NOT NULL DEFAULT now()
      )
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "system_configs"`);
    await queryRunner.query(`DROP INDEX "IDX_audit_logs_createdAt"`);
    await queryRunner.query(`DROP INDEX "IDX_audit_logs_userId"`);
    await queryRunner.query(`DROP TABLE "audit_logs"`);
    await queryRunner.query(`DROP TABLE "executors"`);
    await queryRunner.query(`DROP INDEX "IDX_execution_log_lines_executionId_lineNumber"`);
    await queryRunner.query(`DROP TABLE "execution_log_lines"`);
    await queryRunner.query(`DROP TABLE "task_executions"`);
    await queryRunner.query(`DROP TABLE "tasks"`);
    await queryRunner.query(`DROP TABLE "users"`);
    await queryRunner.query(`DROP TYPE "execution_status_enum"`);
    await queryRunner.query(`DROP TYPE "executor_type_enum"`);
    await queryRunner.query(`DROP TYPE "executor_status_enum"`);
    await queryRunner.query(`DROP TYPE "task_misfirestrategy_enum"`);
    await queryRunner.query(`DROP TYPE "task_blockstrategy_enum"`);
    await queryRunner.query(`DROP TYPE "task_runtime_enum"`);
    await queryRunner.query(`DROP TYPE "task_triggertype_enum"`);
    await queryRunner.query(`DROP TYPE "task_status_enum"`);
    await queryRunner.query(`DROP TYPE "user_role_enum"`);
  }
}
