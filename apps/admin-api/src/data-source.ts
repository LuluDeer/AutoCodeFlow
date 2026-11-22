/**
 * TypeORM DataSource for CLI migrations.
 * Usage:
 *   npm run migration:run     — apply pending migrations in production
 *   npm run migration:revert  — undo last migration
 *   npm run migration:generate src/migrations/MyName — generate from entity diff
 *
 * 第四轮审计（A2）: run/revert 已改走 src/migration-lock-cli.ts（pg_advisory_lock
 * 互斥包裹，与 boot 路径 main.ts 同键）——本文件仅保留 DataSource 定义供其
 * 复用与 migration:generate 使用，勿再用 typeorm CLI -d 直指本文件跑 run/revert。
 */
import { DataSource, DefaultNamingStrategy, Table } from "typeorm";
import * as dotenv from "dotenv";
// R04（2026-11-05）自检 hermeticity：`.env` 的**第三个**入口（migration CLI 路径）。
// 与 main.ts / app.module 受同一开关约束；未设置时行为逐字节不变。
// 实测依据：只改前两处时，迁移子进程仍打印 `injected env (133) from .env`。
import { shouldSkipEnvFile } from "./config/selftest-env";
if (!shouldSkipEnvFile()) dotenv.config();
// ARCH-27: migration CLI 的独立引导路径 —— 不经 NestDI/ConfigModule（无 IoC
// 容器），无法注入 ConfigService，因此经 src/config/env.ts 的 getEnvVar()
// 收口读取（ESLint 豁免：data-source.ts override，见 .eslintrc.js）。
import { getEnvVar } from "./config/env";

const QA08_INDEX_NAMES: Record<string, string> = {
  "agent_approvals|approvalKey": "UQ_agent_approvals_approvalKey",
  "execution_artifacts|executionId,name":
    "UQ_execution_artifacts_execution_name",
  "executor_app_versions|applicationId,executorId":
    "UQ_executor_app_versions_executor_application",
  "project_members|projectId,userId": "uq_project_members_project_user",
  "task_templates|key": "uq_task_templates_key",
  "app_deployments|applicationId": "idx_app_deployments_applicationId",
  "app_deployments|applicationId,status":
    "idx_app_deployments_applicationId_status",
  "app_deployments|status": "idx_app_deployments_status",
  "application_versions|applicationId":
    "idx_application_versions_applicationId",
  "application_versions|applicationId,version":
    "uq_application_versions_applicationId_version",
  "application_versions|createdAt": "idx_application_versions_createdAt",
  "application_versions|sourceDeploymentId":
    "idx_application_versions_sourceDeploymentId",
  "applications|status": "idx_applications_status",
  "audit_logs|createdAt": "IDX_audit_logs_createdAt",
  "audit_logs|userId": "IDX_audit_logs_userId",
  "config_history|configKey": "idx_config_history_configKey",
  "config_history|configKey,createdAt":
    "idx_config_history_configKey_createdAt",
  "execution_log_lines|executionId,lineNumber":
    "IDX_execution_log_lines_execId_lineNumber",
  "execution_reports|triggerDay": "idx_execution_reports_triggerDay",
  "executor_metrics_history|createdAt,executorAddress":
    "idx_executor_metrics_history_address_createdAt",
  "executor_packages|name,type,version":
    "IDX_executor_packages_name_version_type",
  "executors|lastHeartbeat": "idx_executors_last_heartbeat",
  "executors|status": "idx_executors_status",
  "refresh_tokens|jti": "idx_refresh_tokens_jti",
  "task_executions|createdAt": "idx_task_executions_created_at",
  "task_executions|taskId": "IDX_task_executions_taskId",
  "tasks|applicationId": "idx_tasks_applicationId",
  "tasks|status": "idx_tasks_status",
};

const QA08_FK_NAMES: Record<string, string> = {
  "app_deployment_events|applicationId":
    "FK_app_deployment_events_applicationId",
  "app_deployments|applicationId": "FK_app_deployments_applicationId",
  "application_versions|applicationId": "FK_application_versions_applicationId",
  "execution_artifacts|executionId": "FK_execution_artifacts_executionId",
  "executor_app_versions|applicationId":
    "FK_executor_app_versions_applicationId",
  "executor_app_versions|executorId": "FK_executor_app_versions_executorId",
  "task_executions|taskId": "FK_task_executions_taskId",
  "tasks|applicationId": "FK_tasks_applicationId",
  "tasks|projectId": "FK_tasks_project",
};

const QA08_UC_NAMES: Record<string, string> = {
  "u|agent_approvals|approvalKey": "UQ_agent_approvals_approvalKey",
  "u|task_templates|key": "uq_task_templates_key",
  "c|mutex_groups|1,maxConcurrentPerDevice":
    "ck_mutex_groups_max_concurrent_positive",
  "c|mutex_groups|scope": "chk_mutex_groups_scope",
  "u|execution_artifacts|executionId,name":
    "UQ_execution_artifacts_execution_name",
  "u|executor_app_versions|applicationId,executorId":
    "UQ_executor_app_versions_executor_application",
  "u|project_members|projectId,userId": "uq_project_members_project_user",
};

/**
 * QA-08: 迁移链与 DB 中的 index/FK/unique/check 名是旧版可读名，TypeORM 1.x
 * 默认命名策略会生成 hash 名，导致 migration:generate 误判为「删除旧索引 +
 * 新建同构索引」的假漂移。此处显式钉回 DB 既有名，只影响 schema diff 计算，
 * 不改变运行时 CRUD（运行面 app.module.ts 不注入本策略）。
 */
class Qa08NamingStrategy extends DefaultNamingStrategy {
  private static key(t: Table | string, cols: string[]): string {
    const name = typeof t === "string" ? t : t.name;
    return `${name}|${[...cols].sort().join(",")}`;
  }
  foreignKeyName(
    t: Table | string,
    cols: string[],
    rt?: string,
    rc?: string[],
  ): string {
    return (
      QA08_FK_NAMES[Qa08NamingStrategy.key(t, cols)] ??
      super.foreignKeyName(t, cols, rt, rc)
    );
  }
  indexName(t: Table | string, cols: string[], where?: string): string {
    return (
      QA08_INDEX_NAMES[Qa08NamingStrategy.key(t, cols)] ??
      super.indexName(t, cols, where)
    );
  }
  uniqueConstraintName(t: Table | string, cols: string[]): string {
    const name = typeof t === "string" ? t : t.name;
    return (
      QA08_UC_NAMES[`u|${name}|${[...cols].sort().join(",")}`] ??
      super.uniqueConstraintName(t, cols)
    );
  }
  checkConstraintName(
    t: Table | string,
    expression: string,
    isEnum?: boolean,
  ): string {
    const name = typeof t === "string" ? t : t.name;
    if (name === "mutex_groups") {
      if (expression.includes("maxConcurrentPerDevice"))
        return "ck_mutex_groups_max_concurrent_positive";
      if (expression.includes("scope")) return "chk_mutex_groups_scope";
    }
    const cols = [
      ...new Set([...expression.matchAll(/"([^"]+)"/g)].map((m) => m[1])),
    ].sort();
    return (
      QA08_UC_NAMES[`c|${name}|${cols.join(",")}`] ??
      super.checkConstraintName(t, expression, isEnum)
    );
  }
}

export const AppDataSource = new DataSource({
  type: "postgres",
  host: getEnvVar("DB_HOST") || "localhost",
  port: parseInt(getEnvVar("DB_PORT") || "5432", 10),
  username: getEnvVar("DB_USERNAME") || "autoflow",
  password: getEnvVar("DB_PASSWORD") || "",
  database: getEnvVar("DB_DATABASE") || "autoflow",
  // 与 src/config/configuration.ts 运行面 glob（../**/*.entity）对齐：
  // 模块根直放的实体（project/project.entity.ts、executor-package 同款）
  // 也能被 CLI 引导路径加载，避免 AUTH-01 Task#project 反向关系因
  // Project 实体元数据缺失而报 "Entity metadata not found"。
  entities: [__dirname + "/modules/**/*.entity{.ts,.js}"],
  migrations: [__dirname + "/migrations/*{.ts,.js}"],
  namingStrategy: new Qa08NamingStrategy(),
  synchronize: false,
  // TypeORM 1.x 把迁移事务默认模式从 0.3.x 的 "each" 改成了 "all"（整链单
  // 事务），且 "all" 下一律禁止迁移实例覆盖 transaction
  // （ForbiddenTransactionModeOverrideError）。迁移链按 "each" 语义设计：
  // 1790000000022 用 CREATE INDEX CONCURRENTLY（PG 硬性禁止事务块内执行）、
  // 1789900000002 声明 transaction=false 让守卫式 SQL 真正出事务——两者都
  // 依赖 per-migration 覆盖合法。显式钉回 "each"，恢复每迁移独立事务语义。
  migrationsTransactionMode: "each",
  logging:
    getEnvVar("NODE_ENV") !== "production" ? ["query", "error"] : ["error"],
});
