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
import { DataSource } from "typeorm";
import * as dotenv from "dotenv";
dotenv.config();
// ARCH-27: migration CLI 的独立引导路径 —— 不经 NestDI/ConfigModule（无 IoC
// 容器），无法注入 ConfigService，因此经 src/config/env.ts 的 getEnvVar()
// 收口读取（ESLint 豁免：data-source.ts override，见 .eslintrc.js）。
import { getEnvVar } from "./config/env";

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
